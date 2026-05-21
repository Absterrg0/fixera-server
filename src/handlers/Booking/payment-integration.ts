/**
 * Booking Payment Integration
 * Extends booking handlers with Stripe payment functionality
 */

import { Request, Response } from 'express';
import Booking, { BookingStatus } from '../../models/booking';
import Payment from '../../models/payment';
import Project from '../../models/project';
import { createPaymentIntent, captureAndTransferPayment, executeRefund, RefundError } from '../Stripe/payment';
import { stripe } from '../../services/stripe';
import { generateIdempotencyKey } from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import { addPoints } from '../../utils/pointsSystem';
import PointsConfig from '../../models/pointsConfig';
import PointTransaction from '../../models/pointTransaction';
import {
  buildProjectScheduleWindow,
  validateProjectScheduleSelection,
} from '../../utils/scheduleEngine';
import {
  addWarrantyDuration,
  getBookingWarrantyDuration,
  normalizeWarrantyDuration,
} from '../../utils/warranty';
import {
  resolveSubprojectIndex,
  normalizeExtraOptions,
} from '../../utils/bookingHelpers';
import {
  sendBookingScheduledEmail,
  sendRescheduleRequestedEmail,
  sendRescheduleResolvedEmail,
} from '../../utils/emailService';
import { MAX_RESCHEDULES_PER_BOOKING } from '../../constants/booking';
import { DISPUTE_SLA_HOURS } from '../../constants/dispute';
import { findTeamConflicts } from '../../utils/scheduleConflict';
import { releaseScheduleSlots } from '../../utils/scheduleRelease';
import { getProfessionalDisplayName } from '../../utils/displayName';
import WarrantyClaim from '../../models/warrantyClaim';

const REFUNDABLE_PAYMENT_STATUSES = new Set(['authorized', 'completed', 'partially_refunded']);

const BOOKING_STATUS_VALUES: BookingStatus[] = [
  'rfq',
  'rfq_accepted',
  'draft_quote',
  'quoted',
  'quote_accepted',
  'quote_rejected',
  'payment_pending',
  'booked',
  'rescheduling_requested',
  'in_progress',
  'professional_completed',
  'completed',
  'cancelled',
  'dispute',
  'refunded',
];

const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  rfq: ['rfq_accepted', 'quoted', 'cancelled'],
  rfq_accepted: ['quoted', 'cancelled'],
  draft_quote: ['quoted', 'cancelled'],
  quoted: ['quote_accepted', 'quote_rejected', 'cancelled'],
  quote_accepted: ['payment_pending', 'booked', 'cancelled'],
  quote_rejected: ['quoted'],
  payment_pending: ['booked', 'cancelled'],
  booked: ['in_progress', 'completed', 'cancelled', 'dispute'],
  rescheduling_requested: [],
  in_progress: ['professional_completed', 'cancelled', 'dispute'],
  professional_completed: ['completed', 'dispute', 'cancelled'],
  completed: [],
  cancelled: [],
  dispute: ['completed', 'cancelled', 'refunded'],
  refunded: [],
};

const resolveBookingSubprojectIndex = (projectDoc: any, requestedIndex: unknown) =>
  resolveSubprojectIndex(projectDoc?.subprojects, requestedIndex);

const normalizeSelectedExtraOptions = (
  extraOptions: unknown,
  projectDoc: any
): { extraOptionId: string; bookedPrice: number }[] =>
  normalizeExtraOptions(extraOptions, projectDoc?.extraOptions);

const isValidBookingStatus = (value: string): value is BookingStatus =>
  BOOKING_STATUS_VALUES.includes(value as BookingStatus);

const isTransitionAllowed = (current: BookingStatus, requested: BookingStatus): boolean =>
  current === requested || ALLOWED_TRANSITIONS[current]?.includes(requested) === true;

const markMilestonesCompleted = (booking: any, completedAt: Date) => {
  if (!Array.isArray(booking.milestonePayments) || booking.milestonePayments.length === 0) {
    return;
  }

  booking.milestonePayments.forEach((milestone: any) => {
    milestone.workStatus = 'completed';
    milestone.startedAt = milestone.startedAt || booking.actualStartDate || completedAt;
    milestone.completedAt = milestone.completedAt || completedAt;
  });
};

const ensureWarrantyCoverageSnapshot = async (booking: any) => {
  let source: 'quote' | 'project_subproject' = 'quote';
  let duration = normalizeWarrantyDuration(booking.warrantyCoverage?.duration)
    || getBookingWarrantyDuration(booking);

  if (!duration && booking.project) {
    const project = await Project.findById(booking.project).select('subprojects');
    const subprojects = Array.isArray((project as any)?.subprojects) ? (project as any).subprojects : [];
    if (
      typeof booking.selectedSubprojectIndex === 'number' &&
      booking.selectedSubprojectIndex >= 0 &&
      booking.selectedSubprojectIndex < subprojects.length
    ) {
      const selectedSubproject = subprojects[booking.selectedSubprojectIndex];
      duration = normalizeWarrantyDuration(selectedSubproject?.warrantyPeriod);
      if (duration) {
        source = 'project_subproject';
      }
    }
  }

  if (!duration) return;

  const startsAt =
    booking.warrantyCoverage?.startsAt instanceof Date
      ? booking.warrantyCoverage.startsAt
      : booking.actualEndDate || new Date();
  const endsAt =
    booking.warrantyCoverage?.endsAt instanceof Date
      ? booking.warrantyCoverage.endsAt
      : addWarrantyDuration(startsAt, duration);

  booking.warrantyCoverage = {
    duration,
    startsAt,
    endsAt,
    source: booking.warrantyCoverage?.source || source,
  };
};

const isDuplicateKeyError = (error: any): boolean => error?.code === 11000;
const COMPLETABLE_BOOKING_STATUSES: BookingStatus[] = ['booked', 'in_progress', 'professional_completed', 'dispute'];

const getProfessionalId = async (booking: any) => {
  if (booking.professional) {
    return booking.professional?._id?.toString?.() || booking.professional?.toString?.();
  }
  if (!booking.project) return undefined;

  const project = await Project.findById(booking.project).select('professionalId');
  return project?.professionalId?.toString?.() || project?.professionalId;
};

const createStatusHistoryEntry = (
  status: BookingStatus,
  updatedBy: any,
  note: string
) => ({
  status,
  timestamp: new Date(),
  updatedBy,
  note,
});

const MAX_STATUS_HISTORY_NOTE_LENGTH = 500;
const MAX_RESCHEDULE_REASON_LENGTH = 500;

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const truncateStatusHistoryNote = (note: string) => {
  const normalized = note.trim();
  if (normalized.length <= MAX_STATUS_HISTORY_NOTE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_STATUS_HISTORY_NOTE_LENGTH - 1).trimEnd()}…`;
};

const snapshotCurrentSchedule = (booking: any) => ({
  scheduledStartDate: booking.scheduledStartDate,
  scheduledExecutionEndDate: booking.scheduledExecutionEndDate,
  scheduledBufferStartDate: booking.scheduledBufferStartDate,
  scheduledBufferEndDate: booking.scheduledBufferEndDate,
  scheduledBufferUnit: booking.scheduledBufferUnit,
  scheduledStartTime: booking.scheduledStartTime,
  scheduledEndTime: booking.scheduledEndTime,
  assignedTeamMembers: Array.isArray(booking.assignedTeamMembers) ? booking.assignedTeamMembers : undefined,
});

const applyScheduleFields = (booking: any, schedule: Record<string, any>) => {
  booking.scheduledStartDate = schedule.scheduledStartDate;
  booking.scheduledExecutionEndDate = schedule.scheduledExecutionEndDate;
  booking.scheduledBufferStartDate = schedule.scheduledBufferStartDate;
  booking.scheduledBufferEndDate = schedule.scheduledBufferEndDate;
  booking.scheduledBufferUnit = schedule.scheduledBufferUnit;
  booking.scheduledStartTime = schedule.scheduledStartTime;
  booking.scheduledEndTime = schedule.scheduledEndTime;
  if (Array.isArray(schedule.assignedTeamMembers) && schedule.assignedTeamMembers.length > 0) {
    booking.assignedTeamMembers = schedule.assignedTeamMembers as any;
  }
};

const buildScheduleUpdatePayload = async ({
  booking,
  scheduledStartDate,
  scheduledStartTime,
  hasExplicitExtraOptions = false,
  selectedExtraOptions,
}: {
  booking: any;
  scheduledStartDate: string;
  scheduledStartTime?: string;
  hasExplicitExtraOptions?: boolean;
  selectedExtraOptions?: unknown;
}): Promise<
  | { success: true; data: Record<string, any> }
  | { success: false; status: number; error: { code: string; message: string } }
> => {
  if (booking.project) {
    const projectId = (booking.project as any)?._id?.toString?.() || String(booking.project);
    const projectDoc = await Project.findById(projectId).select('subprojects extraOptions');
    if (!projectDoc) {
      return {
        success: false,
        status: 404,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Linked project not found' },
      };
    }

    const resolvedSubprojectIndex = resolveBookingSubprojectIndex(
      projectDoc,
      booking.selectedSubprojectIndex
    );

    if (typeof resolvedSubprojectIndex !== 'number') {
      return {
        success: false,
        status: 400,
        error: { code: 'MUST_SELECT_SUBPROJECT', message: 'Please select a subproject/package before scheduling' },
      };
    }

    const isRfqSubproject = Array.isArray(projectDoc.subprojects)
      && projectDoc.subprojects[resolvedSubprojectIndex]?.pricing?.type === 'rfq';

    const scheduleData: Record<string, any> = {
      selectedSubprojectIndex: resolvedSubprojectIndex,
    };

    if (isRfqSubproject) {
      const startDate = new Date(scheduledStartDate);
      if (isNaN(startDate.getTime()) || startDate < new Date()) {
        return {
          success: false,
          status: 400,
          error: { code: 'INVALID_DATE', message: 'Start date must be a valid future date' },
        };
      }

      scheduleData.scheduledStartDate = startDate;
      scheduleData.scheduledExecutionEndDate = undefined;
      scheduleData.scheduledBufferStartDate = undefined;
      scheduleData.scheduledBufferEndDate = undefined;
      scheduleData.scheduledBufferUnit = undefined;
      scheduleData.scheduledStartTime = typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined;
      scheduleData.scheduledEndTime = undefined;
      if (Array.isArray(booking.assignedTeamMembers) && booking.assignedTeamMembers.length > 0) {
        scheduleData.assignedTeamMembers = booking.assignedTeamMembers;
      }
    } else {
      const validation = await validateProjectScheduleSelection({
        projectId,
        subprojectIndex: resolvedSubprojectIndex,
        startDate: scheduledStartDate,
        startTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
        customerBlocks: booking.customerBlocks,
      });

      if (!validation.valid) {
        return {
          success: false,
          status: 400,
          error: {
            code: 'INVALID_DATE',
            message: validation.reason || 'Selected schedule is not available',
          },
        };
      }

      const window = await buildProjectScheduleWindow({
        projectId,
        subprojectIndex: resolvedSubprojectIndex,
        startDate: scheduledStartDate,
        startTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
        customerBlocks: booking.customerBlocks,
      });

      if (!window) {
        return {
          success: false,
          status: 400,
          error: { code: 'INVALID_DATE', message: 'Unable to schedule the selected window' },
        };
      }

      scheduleData.scheduledStartDate = window.scheduledStartDate;
      scheduleData.scheduledExecutionEndDate = window.scheduledExecutionEndDate;
      scheduleData.scheduledBufferStartDate = window.scheduledBufferStartDate;
      scheduleData.scheduledBufferEndDate = window.scheduledBufferEndDate;
      scheduleData.scheduledBufferUnit = window.scheduledBufferUnit;
      scheduleData.scheduledStartTime = window.scheduledStartTime;
      scheduleData.scheduledEndTime = window.scheduledEndTime;
      if (window.assignedTeamMembers?.length) {
        scheduleData.assignedTeamMembers = window.assignedTeamMembers;
      } else if (Array.isArray(booking.assignedTeamMembers) && booking.assignedTeamMembers.length > 0) {
        scheduleData.assignedTeamMembers = booking.assignedTeamMembers;
      }
    }

    if (hasExplicitExtraOptions) {
      scheduleData.selectedExtraOptions = normalizeSelectedExtraOptions(selectedExtraOptions, projectDoc);
    }

    return { success: true, data: scheduleData };
  }

  const startDate = new Date(scheduledStartDate);
  if (isNaN(startDate.getTime()) || startDate < new Date()) {
    return {
      success: false,
      status: 400,
      error: { code: 'INVALID_DATE', message: 'Start date must be a valid future date' },
    };
  }

  return {
    success: true,
    data: {
      scheduledStartDate: startDate,
      scheduledExecutionEndDate: booking.scheduledExecutionEndDate,
      scheduledBufferStartDate: booking.scheduledBufferStartDate,
      scheduledBufferEndDate: booking.scheduledBufferEndDate,
      scheduledBufferUnit: booking.scheduledBufferUnit,
      scheduledStartTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
      scheduledEndTime: booking.scheduledEndTime,
      assignedTeamMembers: Array.isArray(booking.assignedTeamMembers) ? booking.assignedTeamMembers : undefined,
    },
  };
};

const refundCapturedBookingOnConflict = async (
  bookingId: string,
  reason: string
): Promise<{ success: boolean; error?: { code: string; message: string } }> => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found for compensating refund' } };
  }
  if (
    !booking.payment?.stripePaymentIntentId ||
    !['captured', 'completed'].includes(String(booking.payment.status))
  ) {
    return { success: false, error: { code: 'INVALID_STATUS', message: 'Captured booking payment is not refundable in current state' } };
  }

  const totalWithVat = booking.payment.totalWithVat ?? booking.payment.amount ?? 0;
  const refund = await stripe.refunds.create({
    payment_intent: booking.payment.stripePaymentIntentId,
  }, {
    idempotencyKey: generateIdempotencyKey({
      bookingId: booking._id.toString(),
      operation: 'refund',
      version: `conflict-${booking.payment.stripePaymentIntentId}`,
    })
  });

  if (booking.payment.stripeTransferId) {
    try {
      await stripe.transfers.createReversal(
        booking.payment.stripeTransferId,
        { metadata: { reason, bookingId: booking._id.toString() } }
      );
      booking.payment.refundSource = 'professional';
    } catch (error) {
      console.error('Transfer reversal failed during completion conflict refund:', error);
      booking.payment.refundSource = 'platform';
      booking.payment.refundNotes = 'Platform-funded refund after booking completion conflict';
    }
  } else {
    booking.payment.refundSource = 'platform';
  }

  booking.payment.status = 'refunded';
  booking.payment.refundedAt = new Date();
  booking.payment.refundReason = reason;
  booking.status = 'refunded';
  await booking.save();

  await Payment.findOneAndUpdate(
    { booking: booking._id },
    {
      $set: {
        status: 'refunded',
        refundedAt: booking.payment.refundedAt,
      },
      $push: {
        refunds: {
          amount: totalWithVat,
          reason,
          refundId: refund.id,
          refundedAt: booking.payment.refundedAt || new Date(),
          source: booking.payment.refundSource || 'platform',
          notes: booking.payment.refundNotes,
        },
      },
    },
    { upsert: false }
  );

  return { success: true };
};

const awardBookingCompletionPointsToUser = async (
  userId: any,
  amount: number,
  bookingId: any,
  description: string
) => {
  if (!userId || amount <= 0) return;

  const existing = await PointTransaction.findOne({ userId, relatedBooking: bookingId, source: 'booking_completion' });
  if (existing) return;

  try {
    await addPoints(userId, amount, 'booking_completion', description, { relatedBooking: bookingId });
  } catch (error: any) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }
};

const awardBookingCompletionPoints = async (
  professionalId: any,
  customerId: any,
  bookingId: any
) => {
  const pointsConfig = await PointsConfig.getCurrentConfig();
  if (!pointsConfig.isEnabled) return;
  await awardBookingCompletionPointsToUser(
    professionalId,
    pointsConfig.professionalEarningPerBooking,
    bookingId,
    'Earned for completing booking'
  );
  await awardBookingCompletionPointsToUser(
    customerId,
    pointsConfig.customerEarningPerBooking,
    bookingId,
    'Earned for completed booking'
  );
};

/**
 * Enhanced respond to quote handler with payment integration
 * Call this after customer accepts a quote
 */
export const respondToQuoteWithPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { action, pointsToRedeem } = req.body; // 'accept' or 'reject', optional pointsToRedeem
    const userId = (req as any).user?._id?.toString();

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

    // Verify customer
    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    // Verify status
    if (booking.status !== 'quoted') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Quote cannot be accepted in current status' }
      });
    }

    if (action === 'reject') {
      booking.status = 'quote_rejected';
      await booking.save();

      return res.json({
        success: true,
        data: { message: 'Quote rejected', booking }
      });
    }

    if (action === 'accept') {
      booking.status = 'quote_accepted';
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        status: 'quote_accepted',
        timestamp: new Date(),
        updatedBy: booking.customer,
        note: 'Customer accepted the quote',
      });
      await booking.save();

      return res.json({
        success: true,
        data: {
          message: 'Quote accepted. Please complete the booking wizard to proceed to payment.',
          booking,
          requiresBookingWizard: true,
        }
      });
    }

    res.status(400).json({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Action must be accept or reject' }
    });

  } catch (error: any) {
    console.error('Error responding to quote:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to process request'
      }
    });
  }
};

/**
 * Enhanced update booking status with payment capture
 * Call this when booking status changes to 'completed'
 */
export const updateBookingStatusWithPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { status } = req.body;
    const authUser = (req as any).user;
    const userIdStr = authUser?._id?.toString();
    const requestedStatusRaw =
      typeof status === 'string' ? status.trim() : '';

    if (!userIdStr) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    if (!requestedStatusRaw) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Status is required' }
      });
    }

    if (!isValidBookingStatus(requestedStatusRaw)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Unsupported booking status: ${requestedStatusRaw}` }
      });
    }

    const requestedStatus: BookingStatus = requestedStatusRaw;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Authorization check (professional, customer, or admin)
    const bookingProfessionalId = booking.professional ? booking.professional.toString() : undefined;
    const bookingCustomerId = booking.customer.toString();
    const isAdmin = authUser?.role === 'admin' || authUser?.isAdmin === true;
    const isAuthorized =
      isAdmin ||
      bookingProfessionalId === userIdStr ||
      bookingCustomerId === userIdStr;

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    if (requestedStatus === 'rescheduling_requested') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'Use the dedicated reschedule flow to request rescheduling'
        }
      });
    }

    if (!isTransitionAllowed(booking.status as BookingStatus, requestedStatus)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `Transition from ${booking.status} to ${requestedStatus} is not allowed`
        }
      });
    }

    if (requestedStatus === 'completed') {
      const paymentStatus = booking.payment?.status;
      const paymentStatusValue = paymentStatus ? String(paymentStatus) : '';
      const isAlreadyCaptured =
        paymentStatusValue === 'captured' || paymentStatusValue === 'completed';
      const completionDate = booking.actualEndDate || new Date();

      const finalizeCompletedBooking = async () => {
        const atomicUpdate = await Booking.findOneAndUpdate(
          { _id: booking._id, status: { $in: COMPLETABLE_BOOKING_STATUSES } },
          { $set: { status: 'completed', actualEndDate: completionDate } },
          { new: true }
        );

        if (!atomicUpdate) {
          const currentBooking = await Booking.findById(booking._id).select('status actualEndDate');
          if (currentBooking?.status === 'completed') {
            booking.status = currentBooking.status;
            booking.actualEndDate = currentBooking.actualEndDate || booking.actualEndDate;
            return { alreadyCompleted: true as const };
          }

          return {
            conflictStatus: currentBooking?.status || booking.status,
            alreadyCompleted: false as const
          };
        }

        const refreshed = await Booking.findById(booking._id);
        if (refreshed) {
          booking.status = refreshed.status;
          booking.actualEndDate = refreshed.actualEndDate;
          booking.milestonePayments = refreshed.milestonePayments;
          booking.__v = refreshed.__v;
        }
        return { alreadyCompleted: false as const };
      };

      if (isAlreadyCaptured) {
        const finalizeResult = await finalizeCompletedBooking();
        if (finalizeResult.conflictStatus) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'BOOKING_STATUS_CONFLICT',
              message: `Cannot mark booking completed while booking status is "${finalizeResult.conflictStatus}"`
            }
          });
        }

        markMilestonesCompleted(booking, completionDate);
        await ensureWarrantyCoverageSnapshot(booking);
        await booking.save();

        // Process referral completion for the customer
        try {
          const bookingAmount = booking.payment?.amount || 0;
          await processReferralCompletion(booking.customer, booking._id, bookingAmount);
        } catch (e) {
          console.error('Error processing referral completion:', e);
        }

        // Update professional's level after booking completion
        const proId = await getProfessionalId(booking);
        try {
          if (proId) await updateProfessionalLevel(proId);
        } catch (e) {
          console.error('Error updating professional level:', e);
        }

        try {
          await awardBookingCompletionPoints(proId, booking.customer, booking._id);
        } catch (e) {
          console.error('Error awarding booking completion points:', e);
        }

        return res.json({
          success: true,
          data: {
            message: finalizeResult.alreadyCompleted ? 'Booking is already completed' : 'Booking completed',
            booking
          }
        });
      }

      if (paymentStatus === 'authorized') {
        const captureResult = await captureAndTransferPayment(booking._id.toString());

        if (!captureResult.success) {
          return res.status(400).json({
            success: false,
            error: captureResult.error
          });
        }

        const finalizeResult = await finalizeCompletedBooking();
        if (finalizeResult.conflictStatus) {
          const refundReason = `Booking completion conflict after capture: status=${finalizeResult.conflictStatus}`;
          const refundResult = await refundCapturedBookingOnConflict(booking._id.toString(), refundReason);
          if (!refundResult.success) {
            return res.status(500).json({
              success: false,
              error: {
                code: 'BOOKING_STATUS_CONFLICT_REFUND_FAILED',
                message: `Payment was captured but booking could not be completed because status is "${finalizeResult.conflictStatus}". Compensating refund failed: ${refundResult.error?.message || 'unknown error'}`
              }
            });
          }

          return res.status(409).json({
            success: false,
            error: {
              code: 'BOOKING_STATUS_CONFLICT',
              message: `Booking status changed to "${finalizeResult.conflictStatus}" before completion could be finalized. Payment was refunded.`
            }
          });
        }

        markMilestonesCompleted(booking, completionDate);
        await ensureWarrantyCoverageSnapshot(booking);
        await booking.save();

        // Process referral completion for the customer
        try {
          const bookingAmount = booking.payment?.amount || 0;
          await processReferralCompletion(booking.customer, booking._id, bookingAmount);
        } catch (e) {
          console.error('Error processing referral completion:', e);
        }

        // Update professional's level after booking completion
        const proId2 = await getProfessionalId(booking);
        try {
          if (proId2) await updateProfessionalLevel(proId2);
        } catch (e) {
          console.error('Error updating professional level:', e);
        }

        try {
          await awardBookingCompletionPoints(proId2, booking.customer, booking._id);
        } catch (e) {
          console.error('Error awarding booking completion points:', e);
        }

        return res.json({
          success: true,
          data: {
            message: finalizeResult.alreadyCompleted
              ? 'Booking is already completed'
              : 'Booking completed and payment transferred to professional',
            booking
          }
        });
      }

      return res.status(400).json({
        success: false,
        error: {
          code: 'PAYMENT_NOT_CAPTURABLE',
          message: `Cannot mark booking completed while payment status is "${paymentStatus || 'missing'}"`
        }
      });
    }

    // For other status updates, update normally after validation.
    const previousStatus = booking.status as BookingStatus;
    booking.status = requestedStatus;

    // Set timestamps based on status
    if (requestedStatus === 'in_progress' && !booking.actualStartDate) {
      booking.actualStartDate = new Date();
    }
    if (requestedStatus !== previousStatus) {
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push(
        createStatusHistoryEntry(requestedStatus, authUser?._id, `Status changed from ${previousStatus} to ${requestedStatus}`)
      );
    }

    await booking.save();

    res.json({
      success: true,
      data: { message: 'Booking status updated', booking }
    });

  } catch (error: any) {
    console.error('Error updating booking status:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to process request'
      }
    });
  }
};

/**
 * Ensure a payment intent exists for a booking (customer-triggered)
 */
export const ensurePaymentIntent = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();

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
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to initialize payment for this booking' }
      });
    }

    if (!booking.quote) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_QUOTE', message: 'Quote is required before initiating payment' }
      });
    }

    const hasUnpaidMilestones = Array.isArray(booking.milestonePayments)
      && booking.milestonePayments.some((milestone: any) => milestone.status !== 'paid');

    // Only treat the booking as fully paid when all milestones are settled.
    if ((booking.payment?.status === 'authorized' || booking.payment?.status === 'completed') && !hasUnpaidMilestones) {
      return res.json({
        success: true,
        data: {
          message: 'Payment already processed',
          paymentStatus: booking.payment.status,
          booking,
          shouldRedirect: true,
          redirectTo: `/bookings/${bookingId}/payment/success`
        }
      });
    }

    const allowedStatuses = hasUnpaidMilestones
      ? ['quote_accepted', 'payment_pending', 'booked', 'in_progress', 'professional_completed']
      : ['quote_accepted', 'payment_pending', 'booked'];

    if (!allowedStatuses.includes(booking.status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot initiate payment while booking is ${booking.status}`
        }
      });
    }

    const { pointsToRedeem: pts, discountCode } = req.body || {};

    const requestedCodeLabel = typeof discountCode === 'string' && discountCode.trim()
      ? discountCode.trim().toUpperCase()
      : undefined;
    const storedCodeLabel = (booking.payment as any)?.discount?.codeLabel || undefined;
    const codeMatchesStored = storedCodeLabel === requestedCodeLabel;

    const requestedPoints = parseInt(pts) || 0;
    const storedPoints = Number((booking.payment as any)?.discount?.pointsRedeemed) || 0;
    const pointsMatchStored = storedPoints === requestedPoints;

    if (
      booking.payment?.stripeClientSecret &&
      booking.payment.status === 'pending' &&
      codeMatchesStored &&
      pointsMatchStored
    ) {
      return res.json({
        success: true,
        data: {
          clientSecret: booking.payment.stripeClientSecret,
          booking
        }
      });
    }
    const paymentResult = await createPaymentIntent(
      booking._id.toString(),
      userId,
      requestedPoints,
      undefined,
      requestedCodeLabel
    );
    if (!paymentResult.success) {
      return res.status(400).json({
        success: false,
        error: paymentResult.error
      });
    }

    const refreshedBooking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    return res.json({
      success: true,
      data: {
        clientSecret: paymentResult.clientSecret,
        booking: refreshedBooking || booking
      }
    });
  } catch (error: any) {
    console.error('Error ensuring payment intent:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to process request'
      }
    });
  }
};

export const setBookingSchedule = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { scheduledStartDate, scheduledStartTime, additionalNotes } = req.body;
    const hasExplicitExtraOptions = 'selectedExtraOptions' in req.body;
    const selectedExtraOptions = hasExplicitExtraOptions ? req.body.selectedExtraOptions : undefined;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!scheduledStartDate) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DATE', message: 'Start date is required' } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.customer._id.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer can set the schedule' } });
    }

    if (!['quote_accepted'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Schedule can only be set for accepted quotes' } });
    }

    const scheduleUpdate = await buildScheduleUpdatePayload({
      booking,
      scheduledStartDate,
      scheduledStartTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
      hasExplicitExtraOptions,
      selectedExtraOptions,
    });

    if (!scheduleUpdate.success) {
      return res.status(scheduleUpdate.status).json({ success: false, error: scheduleUpdate.error });
    }

    applyScheduleFields(booking, scheduleUpdate.data);
    if (typeof scheduleUpdate.data.selectedSubprojectIndex === 'number') {
      booking.selectedSubprojectIndex = scheduleUpdate.data.selectedSubprojectIndex;
    }
    if (hasExplicitExtraOptions) {
      booking.selectedExtraOptions = scheduleUpdate.data.selectedExtraOptions;
    }

    if (additionalNotes) {
      booking.rfqData = booking.rfqData || {} as any;
      booking.rfqData.additionalNotes = additionalNotes;
    }

    await booking.save();

    try {
      const professional = booking.professional as any;
      const customer = booking.customer as any;
      if (professional?.email) {
        await sendBookingScheduledEmail(
          professional.email,
          getProfessionalDisplayName(professional),
          customer?.name || 'the customer',
          (booking as any).scheduledStartDate,
          String(booking._id)
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send booking-scheduled email:', emailError?.message || emailError);
    }

    return res.json({
      success: true,
      data: { message: 'Schedule set successfully', booking }
    });
  } catch (error: any) {
    console.error('Error setting booking schedule:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to set schedule' } });
  }
};

export const requestBookingReschedule = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { scheduledStartDate, scheduledStartTime, reason, note, description } = req.body;
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    const normalizedNote = normalizeOptionalText(note);
    const normalizedDescription = normalizeOptionalText(description);

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!scheduledStartDate || typeof scheduledStartDate !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DATE', message: 'A proposed start date is required' } });
    }

    if (!normalizedReason || normalizedReason.length < 3 || normalizedReason.length > MAX_RESCHEDULE_REASON_LENGTH) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_REASON',
          message: `A rescheduling reason between 3 and ${MAX_RESCHEDULE_REASON_LENGTH} characters is required`
        }
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    const professionalId = await getProfessionalId(booking);
    const customerId = booking.customer?._id?.toString?.() || booking.customer?.toString?.();
    const isProfessional = professionalId === userId;
    const isCustomer = customerId === userId;
    if (!isProfessional && !isCustomer) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer or assigned professional can request rescheduling' } });
    }

    if (booking.status !== 'booked' && booking.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Rescheduling can only be requested for booked or in-progress work' } });
    }

    const completedRescheduleCount = (booking.rescheduleHistory || []).length;
    if (completedRescheduleCount >= MAX_RESCHEDULES_PER_BOOKING) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'MAX_RESCHEDULES_REACHED',
          message: `This booking has reached the maximum of ${MAX_RESCHEDULES_PER_BOOKING} reschedules`,
        },
      });
    }

    const proposedSchedule = await buildScheduleUpdatePayload({
      booking,
      scheduledStartDate,
      scheduledStartTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
    });

    if (!proposedSchedule.success) {
      return res.status(proposedSchedule.status).json({ success: false, error: proposedSchedule.error });
    }

    const proposedTeamMembers =
      Array.isArray(proposedSchedule.data.assignedTeamMembers) && proposedSchedule.data.assignedTeamMembers.length > 0
        ? proposedSchedule.data.assignedTeamMembers
        : booking.assignedTeamMembers || [];
    const proposedStart = proposedSchedule.data.scheduledStartDate;
    const proposedEnd =
      proposedSchedule.data.scheduledBufferEndDate || proposedSchedule.data.scheduledExecutionEndDate;

    if (proposedStart && proposedEnd && proposedTeamMembers.length > 0) {
      const conflicts = await findTeamConflicts(
        String(booking._id),
        proposedTeamMembers as any,
        proposedStart,
        proposedEnd
      );
      if (conflicts.length > 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'TEAM_CONFLICT',
            message: 'The proposed schedule conflicts with another booking on the same team member(s)',
            conflicts,
          },
        });
      }
    }

    booking.status = 'rescheduling_requested';
    booking.rescheduleRequest = {
      status: 'pending',
      requestedBy: (req as any).user._id,
      requestedAt: new Date(),
      reason: normalizedReason,
      description: normalizedDescription,
      note: normalizedNote,
      previousSchedule: snapshotCurrentSchedule(booking),
      proposedSchedule: {
        scheduledStartDate: proposedSchedule.data.scheduledStartDate,
        scheduledExecutionEndDate: proposedSchedule.data.scheduledExecutionEndDate,
        scheduledBufferStartDate: proposedSchedule.data.scheduledBufferStartDate,
        scheduledBufferEndDate: proposedSchedule.data.scheduledBufferEndDate,
        scheduledBufferUnit: proposedSchedule.data.scheduledBufferUnit,
        scheduledStartTime: proposedSchedule.data.scheduledStartTime,
        scheduledEndTime: proposedSchedule.data.scheduledEndTime,
        assignedTeamMembers: proposedSchedule.data.assignedTeamMembers,
      },
    } as any;
    booking.statusHistory = booking.statusHistory || [];
    const requesterLabel = isCustomer ? 'Customer' : 'Professional';
    booking.statusHistory.push(
      createStatusHistoryEntry(
        'rescheduling_requested',
        (req as any).user._id,
        truncateStatusHistoryNote(`${requesterLabel} requested rescheduling: ${normalizedReason}`)
      )
    );

    await booking.save();

    try {
      const customer = booking.customer as any;
      const professional = booking.professional as any;
      if (customer?.email) {
        const oldDate = booking.rescheduleRequest?.previousSchedule?.scheduledStartDate;
        const newDate = booking.rescheduleRequest?.proposedSchedule?.scheduledStartDate;
        await sendRescheduleRequestedEmail(
          customer.email,
          customer.name || 'Customer',
          getProfessionalDisplayName(professional, 'the professional'),
          oldDate,
          newDate,
          normalizedReason,
          String(booking._id)
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send reschedule-requested email:', emailError?.message || emailError);
    }

    return res.json({
      success: true,
      data: { message: 'Rescheduling request submitted', booking },
    });
  } catch (error: any) {
    console.error('Error requesting booking reschedule:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to request rescheduling' } });
  }
};

export const respondToBookingReschedule = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { action, note, reason, description } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const normalizedAction = action === 'decline' ? 'refund' : action;
    if (!['accept', 'refund', 'dispute'].includes(normalizedAction)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ACTION', message: 'Action must be accept, refund, or dispute' } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.customer?._id?.toString?.() !== userId && booking.customer?.toString?.() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer can respond to a rescheduling request' } });
    }

    if (booking.status !== 'rescheduling_requested' || booking.rescheduleRequest?.status !== 'pending') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'There is no pending rescheduling request for this booking' } });
    }

    booking.rescheduleRequest.respondedAt = new Date();
    booking.rescheduleRequest.respondedBy = (req as any).user._id;
    booking.rescheduleRequest.responseNote = typeof note === 'string' ? note.trim() : undefined;
    booking.statusHistory = booking.statusHistory || [];

    if (normalizedAction === 'accept') {
      const proposedTeamMembers =
        Array.isArray(booking.rescheduleRequest.proposedSchedule?.assignedTeamMembers) &&
        booking.rescheduleRequest.proposedSchedule!.assignedTeamMembers!.length > 0
          ? booking.rescheduleRequest.proposedSchedule!.assignedTeamMembers
          : booking.assignedTeamMembers || [];
      const proposedStart = booking.rescheduleRequest.proposedSchedule?.scheduledStartDate;
      const proposedEnd =
        booking.rescheduleRequest.proposedSchedule?.scheduledBufferEndDate ||
        booking.rescheduleRequest.proposedSchedule?.scheduledExecutionEndDate;

      if (proposedStart && proposedEnd && proposedTeamMembers.length > 0) {
        const conflicts = await findTeamConflicts(
          String(booking._id),
          proposedTeamMembers as any,
          proposedStart as Date,
          proposedEnd as Date
        );
        if (conflicts.length > 0) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'TEAM_CONFLICT',
              message: 'The proposed schedule now conflicts with another booking on the same team member(s)',
              conflicts,
            },
          });
        }
      }

      booking.rescheduleRequest.status = 'accepted';
      applyScheduleFields(booking, booking.rescheduleRequest.proposedSchedule || {});
      booking.status = 'booked';
      booking.statusHistory.push(
        createStatusHistoryEntry('booked', (req as any).user._id, 'Customer accepted the rescheduling request')
      );
    } else if (normalizedAction === 'refund') {
      booking.rescheduleRequest.status = 'declined';
      const refundReasonText = typeof note === 'string' && note.trim()
        ? `Customer declined rescheduling request: ${note.trim()}`
        : 'Customer declined rescheduling request';
      booking.cancellation = {
        cancelledBy: (req as any).user._id,
        reason: refundReasonText,
        cancelledAt: new Date(),
      } as any;

      const hasPayment = !!booking.payment?.stripePaymentIntentId;
      let refundAmount = 0;
      if (hasPayment && booking.payment && REFUNDABLE_PAYMENT_STATUSES.has(booking.payment.status)) {
        try {
          const result = await executeRefund(String(booking._id), { reason: refundReasonText });
          refundAmount = result.amount;
          if (booking.cancellation) {
            (booking.cancellation as any).refundAmount = refundAmount || undefined;
          }
        } catch (refundError: any) {
          if (refundError instanceof RefundError) {
            return res.status(refundError.httpStatus).json({
              success: false,
              error: { code: refundError.code || 'REFUND_FAILED', message: `Refund failed: ${refundError.message}` },
            });
          }
          throw refundError;
        }
      }

      booking.status = 'cancelled';
      booking.statusHistory.push(
        createStatusHistoryEntry('cancelled', (req as any).user._id, 'Customer declined rescheduling and refund issued')
      );
      releaseScheduleSlots(booking, (req as any).user._id);
    } else if (normalizedAction === 'dispute') {
      booking.rescheduleRequest.status = 'declined';
      const disputeReason = typeof reason === 'string' && reason.trim()
        ? reason.trim()
        : 'Reschedule dispute';
      const disputeDescription = typeof description === 'string' && description.trim()
        ? description.trim()
        : (typeof note === 'string' && note.trim() ? note.trim() : '');
      const disputedAt = new Date();
      const slaDeadline = new Date(disputedAt.getTime() + DISPUTE_SLA_HOURS * 60 * 60 * 1000);
      booking.dispute = {
        raisedBy: (req as any).user._id,
        reason: disputeReason,
        description: disputeDescription,
        raisedAt: disputedAt,
        slaDeadline,
        type: 'reschedule',
        attachments: [],
      } as any;
      booking.status = 'dispute';
      booking.statusHistory.push(
        createStatusHistoryEntry('dispute', (req as any).user._id, `Customer disputed rescheduling: ${disputeReason}`)
      );
    }

    booking.rescheduleHistory = booking.rescheduleHistory || [];
    booking.rescheduleHistory.push({
      requestedBy: booking.rescheduleRequest.requestedBy,
      requestedAt: booking.rescheduleRequest.requestedAt,
      reason: booking.rescheduleRequest.reason,
      note: booking.rescheduleRequest.note,
      previousSchedule: booking.rescheduleRequest.previousSchedule,
      proposedSchedule: booking.rescheduleRequest.proposedSchedule,
      status: normalizedAction === 'accept' ? 'accepted' : 'declined',
      respondedAt: booking.rescheduleRequest.respondedAt,
      respondedBy: booking.rescheduleRequest.respondedBy,
      responseNote: booking.rescheduleRequest.responseNote,
    } as any);
    booking.rescheduleRequest = undefined;

    await booking.save();

    if (normalizedAction === 'accept') {
      try {
        await WarrantyClaim.updateMany(
          {
            booking: booking._id,
            'resolution.resolvedAt': { $exists: false },
          },
          {
            $unset: {
              'sla.professionalResponseDueAt': '',
              'sla.customerConfirmationDueAt': '',
              'proposal.resolveByDate': '',
            },
          }
        );
      } catch (slaErr: any) {
        console.error('Failed to reset warranty SLA on reschedule:', slaErr?.message || slaErr);
      }
    }

    if (normalizedAction !== 'dispute') {
      try {
        const professional = booking.professional as any;
        if (professional?.email) {
          await sendRescheduleResolvedEmail(
            professional.email,
            getProfessionalDisplayName(professional),
            normalizedAction === 'accept' ? 'accept' : 'decline',
            typeof note === 'string' ? note.trim() : undefined,
            String(booking._id)
          );
        }
      } catch (emailError: any) {
        console.error('Failed to send reschedule-resolved email:', emailError?.message || emailError);
      }
    }

    const messageByAction: Record<string, string> = {
      accept: 'Rescheduling request accepted',
      refund: 'Rescheduling request declined and refund issued',
      dispute: 'Rescheduling dispute raised',
    };

    return res.json({
      success: true,
      data: {
        message: messageByAction[normalizedAction] || 'Rescheduling request processed',
        booking,
      },
    });
  } catch (error: any) {
    console.error('Error responding to booking reschedule:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to respond to rescheduling request' } });
  }
};

export const extendBookingExecution = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { newExecutionEndDate, note } = req.body;
    const normalizedNote = normalizeOptionalText(note);

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!newExecutionEndDate || typeof newExecutionEndDate !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DATE', message: 'A new execution end date is required' } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    const professionalId = await getProfessionalId(booking);
    if (professionalId !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can extend execution' } });
    }

    if (booking.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Execution can only be extended while work is in progress' } });
    }

    const nextExecutionEndDate = new Date(newExecutionEndDate);
    if (isNaN(nextExecutionEndDate.getTime())) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'Provide a valid execution end date' } });
    }

    const currentExecutionEndDate = booking.scheduledExecutionEndDate || booking.scheduledStartDate;
    if (!currentExecutionEndDate || nextExecutionEndDate <= currentExecutionEndDate) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'The new execution end date must be later than the current schedule' } });
    }

    const extensionMs = nextExecutionEndDate.getTime() - currentExecutionEndDate.getTime();
    booking.scheduledExecutionEndDate = nextExecutionEndDate;

    if (booking.scheduledBufferStartDate) {
      booking.scheduledBufferStartDate = new Date(booking.scheduledBufferStartDate.getTime() + extensionMs);
    } else if (booking.scheduledBufferEndDate) {
      booking.scheduledBufferStartDate = nextExecutionEndDate;
    }

    if (booking.scheduledBufferEndDate) {
      booking.scheduledBufferEndDate = new Date(booking.scheduledBufferEndDate.getTime() + extensionMs);
    }

    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push(
      createStatusHistoryEntry(
        'in_progress',
        (req as any).user._id,
        normalizedNote
          ? truncateStatusHistoryNote(`Execution extended: ${normalizedNote}`)
          : truncateStatusHistoryNote(`Execution end date moved to ${nextExecutionEndDate.toISOString()}`)
      )
    );

    await booking.save();

    return res.json({
      success: true,
      data: { message: 'Execution extended successfully', booking },
    });
  } catch (error: any) {
    console.error('Error extending booking execution:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to extend execution' } });
  }
};
