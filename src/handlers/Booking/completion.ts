import { Request, Response } from 'express';
import Booking, { BookingStatus, ExtraCostType } from '../../models/booking';
import User from '../../models/user';
import PlatformSettings from '../../models/platformSettings';
import {
  uploadToS3,
  generateFileName,
  deleteFromS3,
  isAllowedS3Url,
  validateFile,
  validateImageFileBuffer,
  validateVideoFile,
} from '../../utils/s3Upload';
import { getProfessionalDisplayName } from '../../utils/displayName';
import { captureAndTransferPayment } from '../Stripe/payment';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import {
  generateIdempotencyKey,
  convertToStripeAmount,
  buildPaymentMetadata,
} from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import LoyaltyConfig from '../../models/loyaltyConfig';
import { getCurrentTier } from '../../utils/loyaltySystem';
import Payment from '../../models/payment';
import {
  awardBookingCompletionPoints,
  ensureWarrantyCoverageSnapshot,
  getProfessionalId,
  getUnpaidMilestoneCount,
  markMilestonesCompleted,
} from '../../utils/bookingHelpers';
import {
  sendProfessionalCompletedEmail,
  sendCustomerConfirmedCompletionEmail,
  sendDisputeRaisedEmail,
} from '../../utils/emailService';
import { DISPUTE_SLA_HOURS } from '../../constants/dispute';
import { ensureBookingInvoiceArtifacts } from '../../services/invoiceArtifacts';

const ADMIN_NOTIFICATIONS_EMAIL = process.env.ADMIN_NOTIFICATIONS_EMAIL || process.env.FROM_EMAIL || '';

const PROFESSIONAL_COMPLETION_PENDING_STATUS: BookingStatus = 'professional_completed';
const COMPLETED_BOOKING_STATUS: BookingStatus = 'completed';

const getPlatformCommissionPercent = async () => {
  try {
    const platformConfig = await PlatformSettings.getCurrentConfig();
    return platformConfig.commissionPercent;
  } catch (configError) {
    console.warn('Failed to fetch platform commission for extra-cost payment, falling back to env var:', configError);
    const parsed = Number.parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0');
    return Number.isFinite(parsed) ? parsed : 0;
  }
};

const roundToTwo = (value: number) => Math.round(value * 100) / 100;

const computeCustomerLoyaltyDiscount = async (customer: any, commissionInclusiveAmount: number) => {
  if (commissionInclusiveAmount <= 0) return { tier: 'Bronze', percentage: 0, amount: 0 };
  try {
    const config = await LoyaltyConfig.getCurrentConfig();
    if (!config.globalSettings?.isEnabled) return { tier: 'Bronze', percentage: 0, amount: 0 };
    const minBookingAmount = config.globalSettings.minBookingAmount || 0;
    if (commissionInclusiveAmount < minBookingAmount) return { tier: 'Bronze', percentage: 0, amount: 0 };
    const activeTiers = (config.tiers || []).filter((t: any) => t.isActive);
    if (activeTiers.length === 0) return { tier: 'Bronze', percentage: 0, amount: 0 };
    const preferredName = customer?.manualCustomerLevelOverride || customer?.loyaltyLevel;
    const preferred = preferredName ? activeTiers.find((t: any) => t.name === preferredName) : undefined;
    const tier = preferred || getCurrentTier(activeTiers, customer?.totalSpent || 0);
    const percentage = tier.discountPercentage || 0;
    if (percentage <= 0) return { tier: tier.name, percentage: 0, amount: 0 };
    let amount = roundToTwo(commissionInclusiveAmount * (percentage / 100));
    if (typeof tier.maxDiscountAmount === 'number' && Number.isFinite(tier.maxDiscountAmount) && amount > tier.maxDiscountAmount) {
      amount = tier.maxDiscountAmount;
    }
    return { tier: tier.name, percentage, amount };
  } catch (error) {
    console.error('Loyalty discount calc failed for extra-cost intent:', error);
    return { tier: 'Bronze', percentage: 0, amount: 0 };
  }
};

const computeExtraCostCustomerCharge = async (customer: any, extraCostTotal: number) => {
  const commissionPercent = await getPlatformCommissionPercent();
  const subtotalInclCommission = roundToTwo(extraCostTotal * (1 + commissionPercent / 100));
  const loyalty = await computeCustomerLoyaltyDiscount(customer, subtotalInclCommission);
  const platformMargin = roundToTwo(subtotalInclCommission - extraCostTotal);
  const cappedLoyalty = Math.max(0, Math.min(loyalty.amount, platformMargin));
  (loyalty as any).cappedAmount = cappedLoyalty;
  (loyalty as any).amount = cappedLoyalty;
  const customerChargeAmount = Math.max(0, roundToTwo(subtotalInclCommission - cappedLoyalty));
  const platformCommissionAmount = roundToTwo(subtotalInclCommission - extraCostTotal - cappedLoyalty);
  return { commissionPercent, subtotalInclCommission, loyalty, cappedLoyalty, customerChargeAmount, platformCommissionAmount };
};

export const professionalCompleteBooking = async (req: Request, res: Response) => {
  let attachmentUrls: string[] = [];
  let attachmentKeys: string[] = [];
  let completionSaved = false;
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId).populate('project');
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    const professionalId = booking.professional?.toString()
      || (booking.project as any)?.professionalId?.toString();

    if (professionalId !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can confirm completion' }
      });
    }

    const unpaidMilestoneCount = getUnpaidMilestoneCount(booking.milestonePayments);
    if (unpaidMilestoneCount > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MILESTONES_UNPAID',
          message: `Cannot confirm completion: ${unpaidMilestoneCount} milestone payment(s) are still unpaid.`
        }
      });
    }

    const { notes, extraCosts: extraCostsRaw } = req.body;
    let extraCostsInput = extraCostsRaw;
    if (typeof extraCostsRaw === 'string') {
      const rawValue = extraCostsRaw.trim();
      if (!rawValue) {
        extraCostsInput = undefined;
      } else {
        try {
          extraCostsInput = JSON.parse(rawValue);
        } catch (error: any) {
          console.error('Invalid extra costs JSON during professional completion:', {
            bookingId,
            userId,
            extraCostsRaw,
            error: error?.message || error,
          });
          return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Invalid extraCosts payload' }
          });
        }
      }
    }
    const files = (req as any).files as Express.Multer.File[] | undefined;

    let validatedExtraCosts: any[] = [];
    let extraCostTotal = 0;

    if (Array.isArray(extraCostsInput) && extraCostsInput.length > 0) {
      const project = booking.project as any;

      for (const cost of extraCostsInput) {
        if (!cost.type || !cost.justification) {
          return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Each extra cost requires a type and justification' }
          });
        }

        const costType = cost.type as ExtraCostType;

        if (costType === 'unit_adjustment') {
          if (cost.actualUnits == null || cost.estimatedUnits == null || cost.unitPrice == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Unit adjustment requires actualUnits, estimatedUnits, and unitPrice' }
            });
          }
          const diff = cost.actualUnits - cost.estimatedUnits;
          const amount = diff * cost.unitPrice;
          validatedExtraCosts.push({
            type: 'unit_adjustment',
            name: cost.name || 'Unit-based adjustment',
            justification: cost.justification,
            amount,
            estimatedUnits: cost.estimatedUnits,
            actualUnits: cost.actualUnits,
            unitPrice: cost.unitPrice,
          });
          extraCostTotal += amount;
        } else if (costType === 'condition') {
          if (cost.referenceIndex == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Condition extra cost requires referenceIndex' }
            });
          }
          const condition = project?.termsConditions?.[cost.referenceIndex];
          if (!condition) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: `Invalid condition at index ${cost.referenceIndex}` }
            });
          }
          const rawCost = condition.additionalCost;
          const conditionNet = rawCost == null || rawCost === '' ? 0 : Number(rawCost);
          if (!Number.isFinite(conditionNet) || conditionNet < 0) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: `Condition at index ${cost.referenceIndex} has an invalid additionalCost` }
            });
          }
          validatedExtraCosts.push({
            type: 'condition',
            name: condition.name,
            justification: cost.justification,
            amount: conditionNet,
            referenceIndex: cost.referenceIndex,
          });
          extraCostTotal += conditionNet;
        } else if (costType === 'option') {
          if (cost.referenceIndex == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Option extra cost requires referenceIndex' }
            });
          }
          const option = project?.extraOptions?.[cost.referenceIndex];
          if (!option) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: `Invalid option at index ${cost.referenceIndex}` }
            });
          }
          const optionNet = Number(option.price);
          if (!Number.isFinite(optionNet) || optionNet < 0) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: `Option at index ${cost.referenceIndex} has an invalid price` }
            });
          }
          validatedExtraCosts.push({
            type: 'option',
            name: option.name,
            justification: cost.justification,
            amount: optionNet,
            referenceIndex: cost.referenceIndex,
          });
          extraCostTotal += optionNet;
        } else if (costType === 'other') {
          if (cost.amount == null || cost.name == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Other extra cost requires name and amount' }
            });
          }
          validatedExtraCosts.push({
            type: 'other',
            name: cost.name,
            justification: cost.justification,
            amount: cost.amount,
          });
          extraCostTotal += cost.amount;
        } else {
          return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: `Invalid extra cost type: ${cost.type}` }
          });
        }
      }
    }

    if (files && files.length > 0) {
      try {
        for (const file of files) {
          const fileName = generateFileName(file.originalname, userId, 'completion-attachments');
          const result = await uploadToS3(file, fileName);
          attachmentUrls.push(result.url);
          attachmentKeys.push(result.key);
        }
      } catch (error) {
        await Promise.allSettled(attachmentKeys.map((key) => deleteFromS3(key)));
        attachmentUrls = [];
        attachmentKeys = [];
        throw error;
      }
    }

    const completionConfirmedAt = new Date();
    const statusHistoryNote = validatedExtraCosts.length > 0
      ? `Professional confirmed completion with ${validatedExtraCosts.length} extra cost(s) totaling ${extraCostTotal}`
      : 'Professional confirmed completion';

    const updateDoc: any = {
      $set: {
        status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
        completionAttestation: {
          confirmedAt: completionConfirmedAt,
          confirmedBy: authUser._id,
          attachments: attachmentUrls,
          notes: notes || undefined,
        },
      },
      $push: {
        statusHistory: {
          status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
          timestamp: completionConfirmedAt,
          updatedBy: authUser._id,
          note: statusHistoryNote,
        }
      }
    };

    if (validatedExtraCosts.length > 0) {
      updateDoc.$set.extraCosts = validatedExtraCosts;
      updateDoc.$set.extraCostStatus = 'pending';
      updateDoc.$set.extraCostTotal = extraCostTotal;
    }

    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'in_progress' as BookingStatus },
      updateDoc,
      { new: true }
    ).populate('project');

    if (!updatedBooking) {
      if (attachmentKeys.length > 0) {
        await Promise.allSettled(attachmentKeys.map((key) => deleteFromS3(key)));
        attachmentUrls = [];
        attachmentKeys = [];
      }

      const currentBooking = await Booking.findById(booking._id).select('status');
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot confirm completion while booking is "${currentBooking?.status || booking.status}"`
        }
      });
    }

    completionSaved = true;

    try {
      const customerUser = updatedBooking.customer ? await User.findById(updatedBooking.customer).lean() : null;
      const professionalUser = await User.findById(authUser._id).select('email name username').lean();
      if (customerUser?.email) {
        const emailExtraCostTotal = extraCostTotal > 0
          ? (await computeExtraCostCustomerCharge(customerUser, extraCostTotal)).customerChargeAmount
          : extraCostTotal;
        await sendProfessionalCompletedEmail(
          customerUser.email,
          customerUser.name || 'Customer',
          getProfessionalDisplayName(professionalUser),
          emailExtraCostTotal,
          String(updatedBooking._id),
          (updatedBooking as any).payment?.currency || 'EUR'
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send professional-completed email:', emailError?.message || emailError);
    }

    return res.json({
      success: true,
      data: {
        message: 'Completion confirmed. Awaiting customer confirmation.',
        booking: updatedBooking,
        extraCostTotal,
      }
    });
  } catch (error: any) {
    if (!completionSaved && attachmentKeys.length > 0) {
      await Promise.allSettled(attachmentKeys.map((key) => deleteFromS3(key)));
      attachmentUrls = [];
      attachmentKeys = [];
    }
    console.error('Error in professional completion:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to process completion' }
    });
  }
};

export const createExtraCostPaymentIntent = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer')
      .populate('professional')
      .populate('project', 'professionalId title');
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.customer._id.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the customer can pay extra costs' }
      });
    }

    if (booking.status !== 'professional_completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot pay extra costs while booking is "${booking.status}"` }
      });
    }

    const extraCostTotal = booking.extraCostTotal || 0;
    if (extraCostTotal <= 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_EXTRA_COSTS', message: 'No positive extra costs to pay' }
      });
    }

    const existingExtraCostPiId = booking.payment?.extraCostStripePaymentIntentId;
    const existingExtraCostSecret = booking.payment?.extraCostClientSecret;
    if (existingExtraCostPiId && existingExtraCostSecret) {
      return res.json({
        success: true,
        data: {
          clientSecret: existingExtraCostSecret,
          extraCostTotal,
        }
      });
    }

    let professional = booking.professional as any;
    if (!professional && booking.project && (booking.project as any).professionalId) {
      professional = await User.findById((booking.project as any).professionalId);
    }

    if (!professional?.stripe?.accountId) {
      return res.status(400).json({
        success: false,
        error: { code: 'PROFESSIONAL_NO_STRIPE', message: 'Professional Stripe account not available' }
      });
    }

    const currency = (booking.payment?.currency || 'EUR').toLowerCase();
    const { subtotalInclCommission, loyalty, customerChargeAmount, platformCommissionAmount } =
      await computeExtraCostCustomerCharge(booking.customer as any, extraCostTotal);
    const applicationFeeAmount = convertToStripeAmount(Math.max(0, platformCommissionAmount), currency);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: convertToStripeAmount(customerChargeAmount, currency),
      currency,
      payment_method_types: ['card'],
      transfer_data: {
        destination: professional.stripe.accountId,
      },
      ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
      metadata: {
        ...buildPaymentMetadata(
          booking._id.toString(),
          booking.bookingNumber || '',
          (booking.customer as any)._id.toString(),
          professional._id.toString(),
          professional.stripe.accountId,
          STRIPE_CONFIG.environment as 'production' | 'test'
        ),
        type: 'extra_cost',
      },
      description: `Extra costs for Booking #${booking.bookingNumber}`,
    }, {
      idempotencyKey: generateIdempotencyKey({
        bookingId: booking._id.toString(),
        operation: 'extra-cost-payment-intent',
        version: `${convertToStripeAmount(customerChargeAmount, currency)}:${booking.extraCosts?.length || 0}`,
      })
    });

    booking.set('payment.extraCostStripePaymentIntentId', paymentIntent.id);
    booking.set('payment.extraCostClientSecret', paymentIntent.client_secret);
    booking.set('payment.extraCostAmount', customerChargeAmount);
    await booking.save();

    return res.json({
      success: true,
      data: {
        clientSecret: paymentIntent.client_secret,
        extraCostTotal,
        customerChargeAmount,
        subtotalInclCommission,
        loyaltyDiscount: loyalty,
      }
    });
  } catch (error: any) {
    console.error('Error creating extra cost payment intent:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to create extra cost payment' }
    });
  }
};

export const customerConfirmCompletion = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the customer can confirm completion' }
      });
    }

    if (booking.status !== 'professional_completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot confirm completion while booking is "${booking.status}"` }
      });
    }

    const unpaidMilestoneCount = getUnpaidMilestoneCount(booking.milestonePayments);
    if (unpaidMilestoneCount > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MILESTONES_UNPAID',
          message: `Cannot confirm completion: ${unpaidMilestoneCount} milestone payment(s) are still unpaid.`
        }
      });
    }

    const extraCostTotal = booking.extraCostTotal || 0;

    if (extraCostTotal > 0) {
      const extraCostPiId = booking.payment?.extraCostStripePaymentIntentId;
      if (!extraCostPiId) {
        return res.status(400).json({
          success: false,
          error: { code: 'EXTRA_COST_NOT_PAID', message: 'Extra costs must be paid before confirming completion. Call the extra-cost-payment-intent endpoint first.' }
        });
      }
      const pi = await stripe.paymentIntents.retrieve(extraCostPiId);
      if (pi.status !== 'succeeded') {
        return res.status(400).json({
          success: false,
          error: { code: 'EXTRA_COST_NOT_PAID', message: `Extra cost payment has not succeeded yet (status: ${pi.status})` }
        });
      }
    }

    const completionDate = new Date();
    const completedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
      {
        $set: {
          status: COMPLETED_BOOKING_STATUS,
          actualEndDate: completionDate,
          ...(booking.extraCosts && booking.extraCosts.length > 0 ? { extraCostStatus: 'confirmed' } : {}),
        },
        $push: {
          statusHistory: {
            status: COMPLETED_BOOKING_STATUS,
            timestamp: completionDate,
            updatedBy: authUser._id,
            note: extraCostTotal !== 0
              ? `Customer confirmed completion with extra costs of ${extraCostTotal}`
              : 'Customer confirmed completion'
          }
        }
      },
      { new: true }
    );

    if (!completedBooking) {
      const currentBooking = await Booking.findById(booking._id).select('status');
      if (currentBooking?.status === COMPLETED_BOOKING_STATUS) {
        return res.json({
          success: true,
          data: {
            message: 'Booking is already completed',
            booking: currentBooking,
          }
        });
      }

      return res.status(409).json({
        success: false,
        error: {
          code: 'BOOKING_STATUS_CONFLICT',
          message: `Booking status changed to "${currentBooking?.status || booking.status}" before completion could be finalized`
        }
      });
    }

    const transferResult = await captureAndTransferPayment(completedBooking._id.toString());
    const refreshedBooking = await Booking.findById(completedBooking._id);
    const paymentStatus = refreshedBooking?.payment?.status ? String(refreshedBooking.payment.status) : '';

    if (!transferResult.success) {
      if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
        await Booking.findOneAndUpdate(
          { _id: completedBooking._id, status: COMPLETED_BOOKING_STATUS },
          {
            $set: {
              status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
            },
            $unset: {
              actualEndDate: 1,
            },
            $push: {
              statusHistory: {
                status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
                timestamp: new Date(),
                updatedBy: authUser._id,
                note: `Reverted completion after payment failure: ${transferResult.error?.message || 'unknown payment error'}`
              }
            }
          }
        );

        return res.status(400).json({
          success: false,
          error: transferResult.error
        });
      }
    }

    const finalizedBooking = refreshedBooking || completedBooking;

    markMilestonesCompleted(finalizedBooking, completionDate);
    await ensureWarrantyCoverageSnapshot(finalizedBooking);

    if (extraCostTotal < 0 && finalizedBooking.payment?.stripePaymentIntentId) {
      const commissionPercent = await getPlatformCommissionPercent();
      const refundAmount = Math.round(Math.abs(extraCostTotal) * (1 + commissionPercent / 100) * 100) / 100;
      const currency = (finalizedBooking.payment.currency || 'EUR').toLowerCase();
      await stripe.refunds.create({
        payment_intent: finalizedBooking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, currency),
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: finalizedBooking._id.toString(),
          operation: 'unit-underuse-refund',
          version: `${finalizedBooking.payment.stripePaymentIntentId}:${convertToStripeAmount(refundAmount, currency)}`,
        })
      });
    }

    await finalizedBooking.save();

    try {
      const bookingAmount = (finalizedBooking.payment?.amount || 0) + Math.max(0, extraCostTotal);
      await processReferralCompletion(finalizedBooking.customer, finalizedBooking._id, bookingAmount);
    } catch (e) {
      console.error('Error processing referral completion:', e);
    }

    const proId = await getProfessionalId(finalizedBooking);
    try {
      if (proId) await updateProfessionalLevel(proId);
    } catch (e) {
      console.error('Error updating professional level:', e);
    }

    try {
      await awardBookingCompletionPoints(proId, finalizedBooking.customer, finalizedBooking._id);
    } catch (e) {
      console.error('Error awarding booking completion points:', e);
    }

    try {
      await ensureBookingInvoiceArtifacts(finalizedBooking._id.toString());
    } catch (invoiceError: any) {
      console.error('Failed to generate booking invoice artifacts:', invoiceError?.message || invoiceError);
    }

    try {
      const [customerUser, professionalUser] = await Promise.all([
        User.findById(finalizedBooking.customer).select('email name').lean(),
        proId ? User.findById(proId).select('email name businessInfo').lean() : null,
      ]);
      if (professionalUser?.email) {
        await sendCustomerConfirmedCompletionEmail(
          professionalUser.email,
          getProfessionalDisplayName(professionalUser),
          customerUser?.name || 'Customer',
          String(finalizedBooking._id)
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send customer-confirmed-completion email:', emailError?.message || emailError);
    }

    return res.json({
      success: true,
      data: {
        message: 'Booking completed successfully',
        booking: finalizedBooking,
      }
    });
  } catch (error: any) {
    console.error('Error in customer confirm completion:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to process completion confirmation' }
    });
  }
};

const ALLOWED_DISPUTE_TYPES = ['extra_costs', 'reschedule', 'completion_request', 'warranty_claim', 'warranty_resolve', 'refund_request', 'in_progress'] as const;
type DisputeType = typeof ALLOWED_DISPUTE_TYPES[number];

const DISPUTE_ALLOWED_STATUSES_BY_TYPE: Record<DisputeType, BookingStatus[]> = {
  extra_costs: ['professional_completed'],
  reschedule: ['rescheduling_requested'],
  completion_request: ['professional_completed'],
  warranty_claim: ['completed'],
  warranty_resolve: ['completed'],
  refund_request: ['booked', 'in_progress', 'professional_completed', 'completed'],
  in_progress: ['in_progress'],
};

export const customerDisputeExtraCosts = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the customer can dispute' }
      });
    }

    const { reason, description, type: rawType, attachments: rawAttachments } = req.body;
    const requestedType: DisputeType = ALLOWED_DISPUTE_TYPES.includes(rawType) ? rawType : 'extra_costs';
    const attachments: string[] = Array.isArray(rawAttachments)
      ? rawAttachments
          .filter((u: unknown): u is string => typeof u === 'string' && u.trim().length > 0)
          .filter((u) => isAllowedS3Url(u))
          .slice(0, 10)
      : [];

    const allowedStatuses = DISPUTE_ALLOWED_STATUSES_BY_TYPE[requestedType] || ['professional_completed'];
    if (!allowedStatuses.includes(booking.status as BookingStatus)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot raise this dispute while booking is "${booking.status}"` }
      });
    }

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    const trimmedDescription = typeof description === 'string' ? description.trim() : '';
    if (!trimmedReason) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Dispute reason is required' }
      });
    }

    const disputedAt = new Date();
    const slaDeadline = new Date(disputedAt.getTime() + DISPUTE_SLA_HOURS * 60 * 60 * 1000);
    const disputedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: booking.status },
      {
        $set: {
          status: 'dispute' as BookingStatus,
          ...(booking.extraCosts && booking.extraCosts.length > 0 && requestedType === 'extra_costs' ? { extraCostStatus: 'disputed' } : {}),
          dispute: {
            raisedBy: authUser._id,
            reason: trimmedReason,
            description: trimmedDescription,
            raisedAt: disputedAt,
            slaDeadline,
            type: requestedType,
            attachments,
          }
        },
        $push: {
          statusHistory: {
            status: 'dispute' as BookingStatus,
            timestamp: disputedAt,
            updatedBy: authUser._id,
            note: `Customer disputed (${requestedType}): ${trimmedReason}`
          }
        }
      },
      { new: true }
    );

    if (!disputedBooking) {
      const currentBooking = await Booking.findById(booking._id).select('status');
      return res.status(409).json({
        success: false,
        error: {
          code: 'BOOKING_STATUS_CONFLICT',
          message: `Booking status changed to "${currentBooking?.status || booking.status}" before the dispute could be recorded`
        }
      });
    }

    try {
      const proId = await getProfessionalId(disputedBooking);
      const [customerUser, professionalUser] = await Promise.all([
        User.findById(disputedBooking.customer).select('email name').lean(),
        proId ? User.findById(proId).select('email name businessInfo').lean() : null,
      ]);
      if (professionalUser?.email && ADMIN_NOTIFICATIONS_EMAIL) {
        await sendDisputeRaisedEmail(
          professionalUser.email,
          ADMIN_NOTIFICATIONS_EMAIL,
          getProfessionalDisplayName(professionalUser),
          customerUser?.name || 'Customer',
          trimmedReason,
          String(disputedBooking._id)
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send dispute-raised email:', emailError?.message || emailError);
    }

    return res.json({
      success: true,
      data: {
        message: 'Dispute has been raised. An admin will review your case.',
        booking: disputedBooking,
      }
    });
  } catch (error: any) {
    console.error('Error in customer dispute:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to process dispute' }
    });
  }
};

export const uploadDisputeAttachments = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const files = (req as any).files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_FILES', message: 'No files provided' } });
    }
    if (files.length > 10) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'You can upload up to 10 files at once' } });
    }

    const uploaded: { url: string; key: string }[] = [];
    try {
      for (const file of files) {
        const validation = file.mimetype.startsWith('image/')
          ? await validateImageFileBuffer(file)
          : file.mimetype.startsWith('video/')
          ? validateVideoFile(file)
          : validateFile(file);
        if (!validation.valid) {
          await Promise.allSettled(uploaded.map((u) => deleteFromS3(u.key)));
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: validation.error || 'Invalid file' } });
        }
        const fileName = generateFileName(file.originalname, userId, 'dispute-attachments');
        const result = await uploadToS3(file, fileName);
        uploaded.push(result);
      }
    } catch (error: any) {
      await Promise.allSettled(uploaded.map((u) => deleteFromS3(u.key)));
      console.error('Error uploading dispute attachments:', error?.message || error);
      return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: 'Failed to upload attachments' } });
    }

    return res.json({
      success: true,
      data: {
        files: uploaded,
        urls: uploaded.map((u) => u.url),
      },
    });
  } catch (error: any) {
    console.error('Error uploading dispute attachments:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to upload attachments' } });
  }
};
