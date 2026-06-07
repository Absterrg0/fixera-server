import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking from '../../models/booking';
import User from '../../models/user';
import CancellationRequest from '../../models/cancellationRequest';
import { executeRefund, RefundError } from '../Stripe/payment';
import { getProfessionalDisplayName } from '../../utils/displayName';
import {
  sendRefundProcessedEmail,
  sendRefundCounterOfferEmail,
  sendRefundEscalatedEmail,
} from '../../utils/emailService';

const REFUND_FINALIZED_BOOKING_STATUS = 'cancelled';

const getUserId = (req: Request): string | undefined =>
  (req as any).user?._id ? String((req as any).user._id) : undefined;

const loadActiveCustomerRequest = async (bookingId: string) =>
  CancellationRequest.findOne({
    booking: bookingId,
    requestedRole: 'customer',
    status: { $in: ['pending', 'negotiating', 'escalated'] },
  });

const finalizeRefund = async (
  booking: any,
  request: any,
  amount: number | undefined,
  reason: string
): Promise<{ ok: true; refundAmount: number } | { ok: false; status: number; message: string; code?: string }> => {
  if (request.status === 'approved' || request.refundedAt) {
    return { ok: true, refundAmount: request.refundAmount || 0 };
  }

  const claimed = await CancellationRequest.findOneAndUpdate(
    { _id: request._id, status: { $in: ['pending', 'negotiating'] } },
    { $set: { status: 'processing' } }
  );
  if (!claimed) {
    return { ok: false, status: 409, message: 'This refund request is already being processed' };
  }

  let result;
  try {
    result = await executeRefund(String(booking._id), { amount, reason });
  } catch (error: any) {
    await CancellationRequest.updateOne(
      { _id: request._id, status: 'processing' },
      { $set: { status: claimed.status } }
    ).catch(() => null);
    if (error instanceof RefundError) {
      return { ok: false, status: error.httpStatus, message: error.message, code: error.code };
    }
    throw error;
  }

  request.status = 'approved';
  request.resolvedAt = new Date();
  request.refundAmount = result.amount;
  request.refundedAt = new Date();
  await request.save();

  booking.status = REFUND_FINALIZED_BOOKING_STATUS;
  booking.cancellation = {
    cancelledBy: request.requestedBy,
    reason,
    cancelledAt: new Date(),
    refundAmount: result.amount,
  } as any;
  booking.statusHistory = booking.statusHistory || [];
  booking.statusHistory.push({
    status: REFUND_FINALIZED_BOOKING_STATUS,
    timestamp: new Date(),
    updatedBy: request.requestedBy,
    note: `Refund issued (${result.amount}) — ${reason}`,
  });
  await booking.save();

  return { ok: true, refundAmount: result.amount };
};

const escalateRequest = async (
  request: any,
  reason: 'rejected' | 'refused' | 'no_response'
) => {
  request.status = 'escalated';
  request.escalatedAt = new Date();
  request.escalationReason = reason;
  await request.save();

  try {
    const booking = await Booking.findById(request.booking);
    if (booking && (booking.status === 'booked' || booking.status === 'in_progress')) {
      booking.statusBeforeDispute = booking.status;
      booking.status = 'dispute';
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        status: 'dispute',
        timestamp: new Date(),
        updatedBy: request.requestedBy,
        note: `Refund dispute escalated (${reason})`,
      } as any);
      await booking.save();
    }
  } catch (err) {
    console.error('Failed to set booking status to dispute on refund escalation:', err);
  }
};

export const listProfessionalRefundRequests = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const bookingIds = await Booking.find({ professional: userId }).distinct('_id');
    if (bookingIds.length === 0) {
      return res.json({ success: true, data: { requests: [] } });
    }

    const requests = await CancellationRequest.find({
      booking: { $in: bookingIds },
      requestedRole: 'customer',
      status: { $in: ['pending', 'negotiating'] },
    })
      .populate({ path: 'booking', select: 'bookingNumber status payment project', populate: { path: 'project', select: 'title' } })
      .populate('requestedBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: { requests } });
  } catch (error: any) {
    console.error('listProfessionalRefundRequests error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load refund requests' });
  }
};

export const getBookingCancellationRequest = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { bookingId } = req.params;
    if (!userId) return res.status(401).json({ success: false, msg: 'Authentication required' });
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId).select('customer professional');
    if (!booking) return res.status(404).json({ success: false, msg: 'Booking not found' });
    const isParty =
      booking.customer?.toString() === userId || booking.professional?.toString() === userId;
    if (!isParty) return res.status(403).json({ success: false, msg: 'Not authorized' });

    const request = await CancellationRequest.findOne({ booking: bookingId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: { request: request || null } });
  } catch (error: any) {
    console.error('getBookingCancellationRequest error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load cancellation request' });
  }
};

export const professionalRespondToCancellation = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { bookingId } = req.params;
    const { decision, amount, note } = req.body || {};
    if (!userId) return res.status(401).json({ success: false, msg: 'Authentication required' });
    if (!['approve', 'counter', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, msg: 'decision must be approve, counter, or reject' });
    }
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, msg: 'Booking not found' });
    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: 'Only the assigned professional can respond' });
    }

    const request = await loadActiveCustomerRequest(bookingId);
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ success: false, msg: 'No pending refund request awaiting your response' });
    }

    const bookingPrice = Number(booking.payment?.amount || 0);
    request.professionalRespondedAt = new Date();
    request.professionalNote = typeof note === 'string' ? note.trim().slice(0, 1000) : undefined;

    const [customerUser, professionalUser] = await Promise.all([
      User.findById(booking.customer).select('email name').lean(),
      User.findById(booking.professional).select('email name username').lean(),
    ]);

    if (decision === 'approve') {
      request.professionalDecision = 'approved';
      const result = await finalizeRefund(booking, request, undefined, `Professional approved full refund: ${request.reason}`);
      if (!result.ok) {
        return res.status(result.status).json({ success: false, msg: result.message, code: result.code });
      }
      try {
        if (customerUser?.email) {
          await sendRefundProcessedEmail(customerUser.email, customerUser.name || 'Customer', result.refundAmount, booking.payment?.currency || 'EUR', false, String(booking._id));
        }
      } catch (e) { console.error('refund email failed', e); }
      return res.json({ success: true, data: { status: 'approved', refundAmount: result.refundAmount } });
    }

    if (decision === 'counter') {
      const counter = Number(amount);
      if (!Number.isFinite(counter) || counter < 1 || counter > bookingPrice) {
        return res.status(400).json({ success: false, msg: `Counter-offer must be between 1 and the booking price (${bookingPrice.toFixed(2)})` });
      }
      request.professionalDecision = 'counter';
      request.counterOfferAmount = Math.round(counter * 100) / 100;
      request.status = 'negotiating';
      await request.save();
      try {
        if (customerUser?.email) {
          await sendRefundCounterOfferEmail({
            customerEmail: customerUser.email,
            customerName: customerUser.name || 'Customer',
            professionalName: getProfessionalDisplayName(professionalUser),
            amount: request.counterOfferAmount,
            note: request.professionalNote,
            bookingId: String(booking._id),
            currency: booking.payment?.currency || 'EUR',
          });
        }
      } catch (e) { console.error('counter-offer email failed', e); }
      return res.json({ success: true, data: { status: 'negotiating', counterOfferAmount: request.counterOfferAmount } });
    }

    // reject
    request.professionalDecision = 'rejected';
    await escalateRequest(request, 'rejected');
    try {
      await sendRefundEscalatedEmail({
        bookingId: String(booking._id),
        reason: 'rejected',
        customerEmail: customerUser?.email,
        customerName: customerUser?.name || 'Customer',
      });
    } catch (e) { console.error('escalation email failed', e); }
    return res.json({ success: true, data: { status: 'escalated', escalationReason: 'rejected' } });
  } catch (error: any) {
    console.error('professionalRespondToCancellation error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to respond to refund request' });
  }
};

export const customerRespondToCounterOffer = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { bookingId } = req.params;
    const { decision } = req.body || {};
    if (!userId) return res.status(401).json({ success: false, msg: 'Authentication required' });
    if (!['accept', 'refuse'].includes(decision)) {
      return res.status(400).json({ success: false, msg: 'decision must be accept or refuse' });
    }
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, msg: 'Booking not found' });
    if (booking.customer?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: 'Only the customer can respond to the counter-offer' });
    }

    const request = await loadActiveCustomerRequest(bookingId);
    if (!request || request.status !== 'negotiating' || request.counterOfferAmount == null) {
      return res.status(400).json({ success: false, msg: 'No counter-offer awaiting your response' });
    }

    request.customerRespondedAt = new Date();

    if (decision === 'accept') {
      request.customerDecision = 'accepted';
      const result = await finalizeRefund(booking, request, request.counterOfferAmount, `Customer accepted negotiated refund: ${request.reason}`);
      if (!result.ok) {
        return res.status(result.status).json({ success: false, msg: result.message, code: result.code });
      }
      try {
        const customerUser = await User.findById(booking.customer).select('email name').lean();
        if (customerUser?.email) {
          await sendRefundProcessedEmail(customerUser.email, customerUser.name || 'Customer', result.refundAmount, booking.payment?.currency || 'EUR', false, String(booking._id));
        }
      } catch (e) { console.error('refund email failed', e); }
      return res.json({ success: true, data: { status: 'approved', refundAmount: result.refundAmount } });
    }

    // refuse → escalate to admin
    request.customerDecision = 'refused';
    await escalateRequest(request, 'refused');
    try {
      const customerUser = await User.findById(booking.customer).select('email name').lean();
      await sendRefundEscalatedEmail({
        bookingId: String(booking._id),
        reason: 'refused',
        customerEmail: customerUser?.email,
        customerName: customerUser?.name || 'Customer',
      });
    } catch (e) { console.error('escalation email failed', e); }
    return res.json({ success: true, data: { status: 'escalated', escalationReason: 'refused' } });
  } catch (error: any) {
    console.error('customerRespondToCounterOffer error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to respond to counter-offer' });
  }
};
