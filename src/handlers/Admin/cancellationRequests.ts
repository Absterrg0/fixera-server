import { Request, Response } from "express";
import mongoose from "mongoose";
import CancellationRequest from "../../models/cancellationRequest";
import Booking from "../../models/booking";
import Payment from "../../models/payment";
import User from "../../models/user";
import { executeRefund, RefundError } from "../Stripe/payment";
import { releaseScheduleSlots } from "../../utils/scheduleRelease";
import {
  sendBookingCancelledEmail,
  sendRefundProcessedEmail,
  sendRefundDeniedEmail,
} from "../../utils/emailService";
import { auditLog } from "../../utils/auditLogger";

const VALID_STATUSES = ["pending", "processing", "approved", "denied"] as const;

const parsePagination = (query: any) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
  return { page, limit, skip: (page - 1) * limit };
};

export const listCancellationRequests = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const filter: any = {};
    if (typeof status === "string" && (VALID_STATUSES as readonly string[]).includes(status)) {
      filter.status = status;
    }

    const [items, total] = await Promise.all([
      CancellationRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: "booking",
          select: "bookingNumber status customer professional payment scheduledStartDate",
          populate: [
            { path: "customer", select: "name email" },
            { path: "professional", select: "name email" },
          ],
        })
        .populate("requestedBy", "name email")
        .populate("resolvedBy", "name email")
        .lean(),
      CancellationRequest.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: { items, total, page, limit },
    });
  } catch (error: any) {
    console.error("List cancellation requests error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load cancellation requests" });
  }
};

export const getCancellationRequest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const item = await CancellationRequest.findById(id)
      .populate({
        path: "booking",
        populate: [
          { path: "customer", select: "name email" },
          { path: "professional", select: "name email" },
        ],
      })
      .populate("requestedBy", "name email")
      .populate("resolvedBy", "name email")
      .lean();
    if (!item) {
      return res.status(404).json({ success: false, msg: "Not found" });
    }
    return res.json({ success: true, data: item });
  } catch (error: any) {
    console.error("Get cancellation request error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load cancellation request" });
  }
};

export const approveCancellationRequest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const cancellation = await CancellationRequest.findOneAndUpdate(
      { _id: id, status: "pending" },
      { $set: { status: "processing", resolvedBy: adminObjectId, resolvedAt: new Date() } },
      { new: true }
    );
    if (!cancellation) {
      const existing = await CancellationRequest.findById(id).lean();
      if (!existing) {
        return res.status(404).json({ success: false, msg: "Cancellation request not found" });
      }
      return res.status(409).json({ success: false, msg: `Request is already ${existing.status}` });
    }

    const booking = await Booking.findById(cancellation.booking);
    if (!booking) {
      await CancellationRequest.updateOne(
        { _id: cancellation._id, status: "processing" },
        { $set: { status: "pending" }, $unset: { resolvedBy: "", resolvedAt: "" } }
      );
      return res.status(404).json({ success: false, msg: "Linked booking not found" });
    }

    let refundAmount = 0;
    let refundedAt: Date | undefined;
    const totalWithVat = booking.payment?.totalWithVat ?? 0;
    const hasPayment = !!booking.payment?.stripePaymentIntentId;
    const refundableStatuses = ["authorized", "completed", "partially_refunded"];

    if (hasPayment && booking.payment && refundableStatuses.includes(booking.payment.status)) {
      try {
        const result = await executeRefund(String(booking._id), {
          reason: cancellation.reason,
        });
        refundAmount = result.amount;
        refundedAt = new Date();
      } catch (error: any) {
        await CancellationRequest.updateOne(
          { _id: cancellation._id, status: "processing" },
          { $set: { status: "pending" }, $unset: { resolvedBy: "", resolvedAt: "" } }
        );
        if (error instanceof RefundError) {
          return res.status(error.httpStatus).json({
            success: false,
            msg: `Refund failed: ${error.message}`,
            code: error.code,
          });
        }
        throw error;
      }
    }

    const freshBooking = await Booking.findById(cancellation.booking);
    if (!freshBooking) {
      return res.status(404).json({ success: false, msg: "Booking disappeared during refund" });
    }

    freshBooking.cancellation = {
      cancelledBy: cancellation.requestedBy,
      reason: cancellation.reason,
      cancelledAt: new Date(),
      refundAmount: refundAmount || undefined,
    } as any;

    if (freshBooking.status !== "cancelled" && freshBooking.status !== "refunded") {
      await (freshBooking as any).updateStatus(
        "cancelled",
        adminId,
        `Cancellation approved by admin: ${cancellation.reason}`
      );
    } else {
      freshBooking.statusHistory = freshBooking.statusHistory || [];
      freshBooking.statusHistory.push({
        status: freshBooking.status,
        timestamp: new Date(),
        updatedBy: adminId,
        note: `Cancellation approved by admin: ${cancellation.reason}`,
      } as any);
    }

    releaseScheduleSlots(freshBooking, adminId);
    await freshBooking.save();

    cancellation.status = "approved";
    cancellation.resolvedAt = new Date();
    cancellation.resolvedBy = new mongoose.Types.ObjectId(adminId);
    cancellation.refundAmount = refundAmount || undefined;
    cancellation.refundedAt = refundedAt;
    await cancellation.save();

    try {
      const [customerUser, professionalUser] = await Promise.all([
        freshBooking.customer ? User.findById(freshBooking.customer).select("email name").lean() : null,
        freshBooking.professional ? User.findById(freshBooking.professional).select("email name").lean() : null,
      ]);
      if (customerUser?.email && professionalUser?.email) {
        await sendBookingCancelledEmail(
          customerUser.email,
          professionalUser.email,
          customerUser.name || "Customer",
          professionalUser.name || "Professional",
          cancellation.reason,
          "admin",
          String(freshBooking._id)
        );
      }
      if (customerUser?.email && refundAmount > 0) {
        await sendRefundProcessedEmail(
          customerUser.email,
          customerUser.name || "Customer",
          refundAmount,
          freshBooking.payment?.currency || "EUR",
          refundAmount < totalWithVat,
          String(freshBooking._id)
        );
      }
    } catch (emailError: any) {
      console.error("Approve cancellation email error:", emailError?.message || emailError);
    }

    await auditLog({
      req,
      action: 'admin.cancellation_requests.approve',
      targetType: 'Booking',
      targetId: freshBooking._id,
      details: {
        cancellationRequestId: cancellation._id,
        reason: cancellation.reason,
        refundAmount,
        totalWithVat,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.json({
      success: true,
      data: { cancellationRequest: cancellation, refundAmount },
    });
  } catch (error: any) {
    console.error("Approve cancellation request error:", error);
    await auditLog({
      req,
      action: 'admin.cancellation_requests.approve',
      targetType: 'CancellationRequest',
      targetId: req.params.id,
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: "Failed to approve cancellation" });
  }
};

export const denyCancellationRequest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { denyReason } = req.body || {};
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    if (typeof denyReason !== "string" || !denyReason.trim() || denyReason.trim().length > 500) {
      return res.status(400).json({ success: false, msg: "denyReason is required (max 500 chars)" });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const cancellation = await CancellationRequest.findOneAndUpdate(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "denied",
          denyReason: denyReason.trim(),
          resolvedAt: new Date(),
          resolvedBy: adminObjectId,
        },
      },
      { new: true }
    ).populate("requestedBy", "email name");
    if (!cancellation) {
      const existing = await CancellationRequest.findById(id).lean();
      if (!existing) {
        return res.status(404).json({ success: false, msg: "Cancellation request not found" });
      }
      return res.status(409).json({ success: false, msg: `Request is already ${existing.status}` });
    }

    try {
      const requester: any = cancellation.requestedBy;
      if (requester?.email) {
        await sendRefundDeniedEmail({
          requesterEmail: requester.email,
          requesterName: requester.name || (cancellation.requestedRole === "customer" ? "Customer" : "Professional"),
          bookingId: String(cancellation.booking),
          denyReason: cancellation.denyReason || denyReason.trim(),
        });
      }
    } catch (emailError: any) {
      console.error("Deny cancellation email error:", emailError?.message || emailError);
    }

    await auditLog({
      req,
      action: 'admin.cancellation_requests.deny',
      targetType: 'CancellationRequest',
      targetId: cancellation._id,
      details: {
        bookingId: String(cancellation.booking),
        denyReason: denyReason.trim(),
      },
      status: 'success',
      statusCode: 200,
    });

    return res.json({ success: true, data: { cancellationRequest: cancellation } });
  } catch (error: any) {
    console.error("Deny cancellation request error:", error);
    await auditLog({
      req,
      action: 'admin.cancellation_requests.deny',
      targetType: 'CancellationRequest',
      targetId: req.params.id,
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: "Failed to deny cancellation" });
  }
};
