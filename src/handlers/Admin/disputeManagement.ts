import { Request, Response } from 'express';
import Booking, { BookingStatus } from '../../models/booking';
import User from '../../models/user';
import Conversation from '../../models/conversation';
import { captureAndTransferPayment } from '../Stripe/payment';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import { generateIdempotencyKey, convertToStripeAmount } from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import {
  awardBookingCompletionPoints,
  ensureWarrantyCoverageSnapshot,
  getProfessionalId,
  markMilestonesCompleted,
} from '../../utils/bookingHelpers';
import { sendDisputeResolvedEmail } from '../../utils/emailService';
import { auditLog } from '../../utils/auditLogger';
import { getProfessionalDisplayName } from '../../utils/displayName';
import {
  isAllowedS3Url,
  generateFileName,
  uploadToS3,
  deleteFromS3,
  validateFile,
  validateImageFileBuffer,
  validateVideoFile,
} from '../../utils/s3Upload';

const ACTIVE_DISPUTE_STATUS: BookingStatus = 'dispute';
const COMPLETED_BOOKING_STATUS: BookingStatus = 'completed';

type DisputeResolutionAction = 'accept_professional' | 'reject_extra_costs' | 'adjust';
type ForceBookingStatus = 'completed' | 'cancelled' | 'refunded' | 'in_progress';
const FORCE_STATUS_VALUES: ForceBookingStatus[] = ['completed', 'cancelled', 'refunded', 'in_progress'];

const buildDisputeFilter = (status?: string) => {
  if (status === 'resolved') {
    return { 'dispute.raisedAt': { $exists: true }, 'dispute.resolvedAt': { $ne: null } };
  }

  if (status === 'open') {
    return { 'dispute.raisedAt': { $exists: true }, 'dispute.resolvedAt': null };
  }

  return { 'dispute.raisedAt': { $exists: true } };
};

const applyExtraCostUpdate = (
  resolvedBooking: any,
  action: DisputeResolutionAction,
  adjustedAmount?: number
): number => {
  const originalExtraCostAmount = Number(resolvedBooking.extraCostTotal || 0);
  resolvedBooking.extraCostStatus = 'confirmed';

  if (action === 'accept_professional') {
    return originalExtraCostAmount;
  }

  if (action === 'reject_extra_costs') {
    resolvedBooking.extraCostTotal = 0;
    return 0;
  }

  const finalAdjustedAmount = Number(adjustedAmount);
  resolvedBooking.extraCostTotal = finalAdjustedAmount;
  if (resolvedBooking.dispute) {
    resolvedBooking.dispute.adminAdjustedAmount = finalAdjustedAmount;
  }
  return finalAdjustedAmount;
};

const transferResolvedExtraCostIfNeeded = async (resolvedBooking: any, finalExtraCostAmount: number) => {
  if (!(finalExtraCostAmount > 0)) return;

  const extraCostPaymentIntentId = resolvedBooking.payment?.extraCostStripePaymentIntentId;
  if (!extraCostPaymentIntentId) {
    console.warn(`[DISPUTE] Booking ${resolvedBooking._id} has approved extra costs but no extra-cost PaymentIntent to transfer.`);
    return;
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(extraCostPaymentIntentId, { expand: ['latest_charge'] });
    if (paymentIntent.status !== 'succeeded') {
      console.warn(`[DISPUTE] Extra-cost PaymentIntent ${extraCostPaymentIntentId} is ${paymentIntent.status}; skipping professional transfer.`);
      return;
    }

    if (paymentIntent.transfer_data?.destination) {
      return;
    }

    const professionalId = await getProfessionalId(resolvedBooking);
    if (!professionalId) {
      console.error(`[DISPUTE] Missing professional on booking ${resolvedBooking._id}; cannot transfer approved extra costs.`);
      return;
    }

    const professional = await User.findById(professionalId).select('stripe.accountId');
    const destinationAccountId = (professional as any)?.stripe?.accountId;
    if (!destinationAccountId) {
      console.error(`[DISPUTE] Professional ${professionalId} has no connected Stripe account; cannot transfer approved extra costs.`);
      return;
    }

    let transferCurrency = String(resolvedBooking.payment?.currency || paymentIntent.currency || 'EUR').toLowerCase();
    let sourceTransaction: string | undefined;
    let availableAmount = paymentIntent.amount_received || paymentIntent.amount || 0;

    if (paymentIntent.latest_charge) {
      const latestCharge = typeof paymentIntent.latest_charge === 'string'
        ? await stripe.charges.retrieve(paymentIntent.latest_charge, { expand: ['balance_transaction'] })
        : paymentIntent.latest_charge;

      sourceTransaction = latestCharge.id;
      if (latestCharge.currency) {
        transferCurrency = latestCharge.currency.toLowerCase();
      }

      const balanceTransaction =
        typeof latestCharge.balance_transaction === 'string'
          ? null
          : latestCharge.balance_transaction;

      if (balanceTransaction?.currency) {
        transferCurrency = balanceTransaction.currency.toLowerCase();
      }
      if (typeof balanceTransaction?.amount === 'number' && balanceTransaction.amount > 0) {
        availableAmount = balanceTransaction.amount;
      }
    }

    const requestedAmount = convertToStripeAmount(finalExtraCostAmount, transferCurrency);
    const transferAmount = Math.min(requestedAmount, availableAmount);
    if (transferAmount <= 0) {
      console.warn(`[DISPUTE] Extra-cost transfer amount for booking ${resolvedBooking._id} resolved to 0; skipping transfer.`);
      return;
    }

    await stripe.transfers.create({
      amount: transferAmount,
      currency: transferCurrency,
      destination: destinationAccountId,
      ...(sourceTransaction ? { source_transaction: sourceTransaction } : {}),
      metadata: {
        bookingId: resolvedBooking._id.toString(),
        bookingNumber: resolvedBooking.bookingNumber || '',
        environment: STRIPE_CONFIG.environment,
        type: 'extra_cost_dispute_resolution',
        extraCostPaymentIntentId,
      },
      description: `Extra cost payout for Booking #${resolvedBooking.bookingNumber}`,
    }, {
      idempotencyKey: generateIdempotencyKey({
        bookingId: resolvedBooking._id.toString(),
        operation: 'transfer',
        version: `extra-cost:${extraCostPaymentIntentId}:${transferAmount}`,
      })
    });
  } catch (error) {
    console.error('Failed to transfer approved extra costs during dispute resolution:', error);
  }
};

export const getDisputes = async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 20));

    const filter = buildDisputeFilter(typeof status === 'string' ? status : undefined);

    const [disputes, total] = await Promise.all([
      Booking.find(filter)
        .populate('customer', 'name email phone')
        .populate('professional', 'name email username')
        .populate('project', 'title category service')
        .select(
          'bookingNumber status customer professional project payment extraCosts extraCostTotal extraCostStatus completionAttestation dispute createdAt actualEndDate actualStartDate scheduledStartDate scheduledEndTime scheduledStartTime scheduledExecutionEndDate rescheduleRequest warrantyCoverage cancellation'
        )
        .sort({ 'dispute.raisedAt': -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Booking.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        disputes,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        }
      }
    });
  } catch (error: any) {
    console.error('Error fetching disputes:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch disputes' }
    });
  }
};

export const getDisputeDetails = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title category service extraOptions termsConditions subprojects');

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (!booking.dispute?.raisedAt) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'BOOKING_NOT_IN_DISPUTE',
          message: `Booking ${bookingId} has no dispute record`
        }
      });
    }

    return res.json({
      success: true,
      data: { booking }
    });
  } catch (error: any) {
    console.error('Error fetching dispute details:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch dispute details' }
    });
  }
};

export const resolveDispute = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const adminUser = (req as any).user;
  const { action, adjustedAmount, resolution, forceStatus, resolutionAttachments } = req.body || {};

  let resolvedBooking: any = null;
  let finalExtraCostAmount = 0;
  let targetStatus: BookingStatus = COMPLETED_BOOKING_STATUS;
  let disputeType: string = 'extra_costs';
  let isExtraCostsDispute = true;
  let sanitizedAttachments: string[] = [];

  try {
    if (!action || !['accept_professional', 'reject_extra_costs', 'adjust'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Action must be accept_professional, reject_extra_costs, or adjust' }
      });
    }

    if (!resolution) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Resolution notes are required' }
      });
    }

    if (action === 'adjust' && (!Number.isFinite(adjustedAmount) || adjustedAmount < 0)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Adjusted amount is required for adjust action and must be >= 0' }
      });
    }

    if (forceStatus !== undefined && !FORCE_STATUS_VALUES.includes(forceStatus)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `forceStatus must be one of ${FORCE_STATUS_VALUES.join(', ')}` }
      });
    }

    if (resolutionAttachments !== undefined) {
      if (!Array.isArray(resolutionAttachments)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'resolutionAttachments must be an array of S3 URLs' }
        });
      }
      sanitizedAttachments = resolutionAttachments
        .filter((value: unknown): value is string => typeof value === 'string')
        .filter((url) => isAllowedS3Url(url));
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.status !== ACTIVE_DISPUTE_STATUS) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Booking is not in dispute status (current: ${booking.status})` }
      });
    }

    disputeType = String((booking.dispute as any)?.type || 'extra_costs');
    isExtraCostsDispute = disputeType === 'extra_costs';
    targetStatus = (forceStatus as BookingStatus) || COMPLETED_BOOKING_STATUS;

    const completionDate = new Date();
    const setFields: Record<string, any> = {
      status: targetStatus,
      'dispute.resolvedAt': completionDate,
      'dispute.resolution': resolution,
      'dispute.resolvedBy': adminUser._id,
    };
    if (targetStatus === COMPLETED_BOOKING_STATUS) {
      setFields.actualEndDate = completionDate;
    }
    if (sanitizedAttachments.length > 0) {
      setFields['dispute.resolutionAttachments'] = sanitizedAttachments;
    }

    resolvedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: ACTIVE_DISPUTE_STATUS },
      {
        $set: setFields,
        $push: {
          statusHistory: {
            status: targetStatus,
            timestamp: completionDate,
            updatedBy: adminUser._id,
            note: `Admin resolved dispute (${action}): ${resolution}`
          }
        }
      },
      { new: true }
    );

    if (!resolvedBooking) {
      const currentBooking = await Booking.findById(booking._id).select('status');
      return res.status(409).json({
        success: false,
        error: {
          code: 'BOOKING_STATUS_CONFLICT',
          message: `Booking status changed to "${currentBooking?.status || booking.status}" before the dispute could be resolved`
        }
      });
    }

    if (isExtraCostsDispute) {
      finalExtraCostAmount = applyExtraCostUpdate(
        resolvedBooking,
        action as DisputeResolutionAction,
        adjustedAmount
      );
    }

    if (targetStatus === COMPLETED_BOOKING_STATUS) {
      markMilestonesCompleted(resolvedBooking, completionDate);
      await ensureWarrantyCoverageSnapshot(resolvedBooking);
    }
    await resolvedBooking.save();
  } catch (error: any) {
    console.error('Error resolving dispute:', error);
    try {
      await auditLog({
        req,
        action: 'admin.disputes.resolve',
        targetType: 'Booking',
        targetId: req.params.bookingId,
        status: 'failure',
        statusCode: 500,
        errorMessage: error?.message || 'unknown',
      });
    } catch (auditError) {
      console.error('Audit log failed during dispute resolve failure:', auditError);
    }
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to resolve dispute' }
    });
  }

  try {
    await auditLog({
      req,
      action: 'admin.disputes.resolve',
      targetType: 'Booking',
      targetId: resolvedBooking._id,
      details: {
        action,
        resolution,
        adjustedAmount: typeof adjustedAmount === 'number' ? adjustedAmount : undefined,
        finalExtraCostAmount,
        forceStatus: forceStatus || null,
        disputeType,
        resolutionAttachmentsCount: sanitizedAttachments.length,
        before: { status: ACTIVE_DISPUTE_STATUS },
        after: { status: targetStatus },
      },
      status: 'success',
      statusCode: 200,
    });
  } catch (auditError) {
    console.error('Audit log failed after dispute resolve:', auditError);
  }

  setImmediate(async () => {
    try {
      if (targetStatus === COMPLETED_BOOKING_STATUS) {
        const transferResult = await captureAndTransferPayment(resolvedBooking._id.toString());
        if (!transferResult.success) {
          const paymentStatus = resolvedBooking.payment?.status ? String(resolvedBooking.payment.status) : '';
          if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
            console.error('Transfer failed during dispute resolution:', transferResult.error);
          }
        } else if (isExtraCostsDispute) {
          await transferResolvedExtraCostIfNeeded(resolvedBooking, finalExtraCostAmount);
        }
      }
    } catch (e) {
      console.error('Post-resolve Stripe step failed:', e);
    }

    const proId = await getProfessionalId(resolvedBooking).catch(() => null);

    if (targetStatus === COMPLETED_BOOKING_STATUS) {
      try {
        const bookingAmount = (resolvedBooking.payment?.amount || 0) + Math.max(0, finalExtraCostAmount);
        await processReferralCompletion(resolvedBooking.customer, resolvedBooking._id, bookingAmount);
      } catch (e) {
        console.error('Error processing referral completion:', e);
      }

      try {
        if (proId) await updateProfessionalLevel(proId);
      } catch (e) {
        console.error('Error updating professional level:', e);
      }

      try {
        await awardBookingCompletionPoints(proId, resolvedBooking.customer, resolvedBooking._id);
      } catch (e) {
        console.error('Error awarding booking completion points:', e);
      }
    }

    try {
      const [customerUser, professionalUser] = await Promise.all([
        User.findById(resolvedBooking.customer).select('email name').lean(),
        proId ? User.findById(proId).select('email name businessInfo').lean() : null,
      ]);
      if (customerUser?.email && professionalUser?.email) {
        await sendDisputeResolvedEmail(
          customerUser.email,
          professionalUser.email,
          customerUser.name || 'Customer',
          getProfessionalDisplayName(professionalUser),
          resolution,
          isExtraCostsDispute && typeof finalExtraCostAmount === 'number' ? finalExtraCostAmount : undefined,
          String(resolvedBooking._id),
          (resolvedBooking as any).payment?.currency || 'EUR'
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send dispute-resolved email:', emailError?.message || emailError);
    }

    try {
      const participantIds = [resolvedBooking.customer, proId].filter(Boolean);
      if (participantIds.length > 0) {
        await Conversation.updateMany(
          {
            type: 'support',
            status: 'active',
            supportTargetUserId: { $in: participantIds },
          },
          { $set: { status: 'archived' } }
        );
      }
    } catch (e) {
      console.error('Failed to archive related support conversations:', e);
    }
  });

  return res.json({
    success: true,
    data: {
      message: `Dispute resolved: ${action}`,
      booking: resolvedBooking,
    }
  });
};

export const getDisputeAnalytics = async (_req: Request, res: Response) => {
  try {
    const [
      totalOpen,
      totalResolved,
      totalDisputes,
    ] = await Promise.all([
      Booking.countDocuments(buildDisputeFilter('open')),
      Booking.countDocuments(buildDisputeFilter('resolved')),
      Booking.countDocuments(buildDisputeFilter()),
    ]);

    return res.json({
      success: true,
      data: {
        totalOpen,
        totalResolved,
        totalDisputes,
      }
    });
  } catch (error: any) {
    console.error('Error fetching dispute analytics:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch dispute analytics' }
    });
  }
};

export const uploadDisputeResolutionAttachment = async (req: Request, res: Response) => {
  try {
    const adminUser = (req as any).user;
    const adminId = adminUser?._id?.toString();
    if (!adminId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No files uploaded' } });
    }
    if (files.length > 10) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'You can upload up to 10 files at once' } });
    }

    const uploaded: Array<{ url: string; key: string; fileName: string; mimeType: string; fileSize: number }> = [];
    try {
      for (const file of files) {
        const validation = file.mimetype.startsWith('image/')
          ? await validateImageFileBuffer(file)
          : file.mimetype.startsWith('video/')
          ? validateVideoFile(file)
          : validateFile(file);
        if (!validation.valid) {
          await Promise.all(uploaded.map((f) => deleteFromS3(f.key).catch(() => null)));
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: validation.error || 'Invalid file' } });
        }

        const fileName = generateFileName(file.originalname, adminId, 'dispute-resolutions');
        const result = await uploadToS3(file, fileName);
        uploaded.push({
          url: result.url,
          key: result.key,
          fileName: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
        });
      }
    } catch (uploadError) {
      await Promise.all(uploaded.map((f) => deleteFromS3(f.key).catch(() => null)));
      throw uploadError;
    }

    return res.json({ success: true, data: { files: uploaded } });
  } catch (error: any) {
    console.error('Failed to upload dispute resolution attachments:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to upload attachments' } });
  }
};
