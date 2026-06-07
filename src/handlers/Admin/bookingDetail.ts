import { Request, Response } from "express";
import mongoose from "mongoose";
import Booking from "../../models/booking";
import Payment from "../../models/payment";
import CancellationRequest from "../../models/cancellationRequest";
import { auditLog } from "../../utils/auditLogger";

export const ADMIN_FORCEABLE_STATUSES = [
  "payment_pending",
  "booked",
  "in_progress",
  "professional_completed",
  "completed",
  "dispute",
];

export const getAdminBookingDetail = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }

    const booking = await Booking.findById(id)
      .populate("customer", "name email phone role")
      .populate("professional", "name email username role")
      .populate("project", "title category service")
      .populate("rescheduleHistory.requestedBy", "name email")
      .populate("rescheduleHistory.respondedBy", "name email")
      .populate("dispute.raisedBy", "name email")
      .populate("dispute.resolvedBy", "name email")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const [payment, cancellationRequests] = await Promise.all([
      Payment.findOne({ booking: id })
        .populate("customer", "name email")
        .populate("professional", "name email")
        .lean(),
      CancellationRequest.find({ booking: id })
        .sort({ createdAt: -1 })
        .populate("requestedBy", "name email")
        .populate("resolvedBy", "name email")
        .lean(),
    ]);

    return res.json({
      success: true,
      data: {
        booking,
        payment,
        cancellationRequests,
      },
    });
  } catch (error: any) {
    console.error("Admin booking detail error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load booking detail" });
  }
};

export const forceBookingStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body || {};
    const adminUser = (req as any).user || (req as any).admin;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    if (typeof status !== "string" || !ADMIN_FORCEABLE_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        msg: `status must be one of: ${ADMIN_FORCEABLE_STATUSES.join(", ")}`,
      });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const previousStatus = booking.status;
    if (previousStatus === status) {
      return res.status(400).json({ success: false, msg: `Booking is already "${status}"` });
    }

    const trimmedNote = typeof note === "string" ? note.trim().slice(0, 500) : "";
    booking.status = status as any;
    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push({
      status: status as any,
      timestamp: new Date(),
      updatedBy: adminUser?._id,
      note: trimmedNote || `Status force-set by admin (was ${previousStatus})`,
    } as any);
    await booking.save();

    try {
      await auditLog({
        req,
        action: "admin.bookings.force_status",
        targetType: "Booking",
        targetId: id,
        details: { from: previousStatus, to: status, note: trimmedNote || undefined },
        status: "success",
        statusCode: 200,
      });
    } catch (auditError) {
      console.error("Audit log failed for force booking status:", auditError);
    }

    return res.json({ success: true, data: { status: booking.status, previousStatus } });
  } catch (error: any) {
    console.error("Force booking status error:", error);
    return res.status(500).json({ success: false, msg: "Failed to force booking status" });
  }
};
