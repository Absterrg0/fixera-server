import { Request, Response } from "express";
import mongoose from "mongoose";
import SupportTicket, { SUPPORT_TICKET_STATUSES, SupportTicketStatus } from "../../models/supportTicket";
import MeetingRequest, {
  MEETING_REQUEST_STATUSES,
  MeetingRequestStatus,
} from "../../models/meetingRequest";
import connectDB from "../../config/db";
import { IUser } from "../../models/user";
import { params } from "../../utils/requestParams";

const isValidObjectId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const parsePagination = (req: Request): { page: number; limit: number; skip: number } => {
  const rawPage = Number(req.query.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const rawLimit = Number(req.query.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.trunc(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
};

export const adminListTickets = async (req: Request, res: Response) => {
  try {
    const statusQuery = typeof req.query.status === "string" ? req.query.status : undefined;
    const filter: Record<string, unknown> = {};
    if (statusQuery !== undefined) {
      if (!SUPPORT_TICKET_STATUSES.includes(statusQuery as SupportTicketStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${statusQuery}` });
      }
      filter.status = statusQuery;
    }

    const { page, limit, skip } = parsePagination(req);

    await connectDB();
    const [items, total] = await Promise.all([
      SupportTicket.find(filter)
        .populate("userId", "name email role")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupportTicket.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error("Admin list tickets error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load tickets" });
  }
};

export const adminUpdateTicket = async (req: Request, res: Response) => {
  try {
    const admin = (req as Request & { admin?: IUser }).admin;
    if (!admin) return res.status(401).json({ success: false, msg: "Unauthorized" });

    const { id } = params(req.params);
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, msg: "Invalid ticket ID" });

    await connectDB();
    const ticket = await SupportTicket.findById(id);
    if (!ticket) return res.status(404).json({ success: false, msg: "Ticket not found" });

    let nextStatus: SupportTicketStatus | undefined;
    if (req.body?.status !== undefined) {
      if (typeof req.body.status !== "string" || !SUPPORT_TICKET_STATUSES.includes(req.body.status as SupportTicketStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${req.body.status}` });
      }
      nextStatus = req.body.status as SupportTicketStatus;
    }

    const hasReply = typeof req.body?.reply === "string" && req.body.reply.trim();

    if (hasReply && ticket.status === "closed" && (nextStatus ?? ticket.status) === "closed") {
      return res.status(400).json({
        success: false,
        msg: "Cannot reply on a closed ticket. Reopen it by setting a non-closed status first.",
      });
    }

    if (nextStatus) ticket.status = nextStatus;

    if (hasReply) {
      const body = req.body.reply.trim().slice(0, 5000);
      ticket.replies.push({
        authorId: admin._id,
        authorRole: "admin",
        body,
        createdAt: new Date(),
      });
    }

    await ticket.save();
    return res.status(200).json({ success: true, data: ticket });
  } catch (error) {
    console.error("Admin update ticket error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update ticket" });
  }
};

export const adminListMeetingRequests = async (req: Request, res: Response) => {
  try {
    const statusQuery = typeof req.query.status === "string" ? req.query.status : undefined;
    const filter: Record<string, unknown> = {};
    if (statusQuery !== undefined) {
      if (!MEETING_REQUEST_STATUSES.includes(statusQuery as MeetingRequestStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${statusQuery}` });
      }
      filter.status = statusQuery;
    }

    const { page, limit, skip } = parsePagination(req);

    await connectDB();
    const [items, total] = await Promise.all([
      MeetingRequest.find(filter)
        .populate("userId", "name email role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MeetingRequest.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error("Admin list meeting requests error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load meeting requests" });
  }
};

export const adminUpdateMeetingRequest = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, msg: "Invalid request ID" });

    await connectDB();
    const doc = await MeetingRequest.findById(id);
    if (!doc) return res.status(404).json({ success: false, msg: "Request not found" });

    let nextStatus: MeetingRequestStatus | undefined;
    if (req.body?.status !== undefined) {
      if (typeof req.body.status !== "string" || !MEETING_REQUEST_STATUSES.includes(req.body.status as MeetingRequestStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${req.body.status}` });
      }
      nextStatus = req.body.status as MeetingRequestStatus;
    }

    let parsedScheduledAt: Date | undefined;
    const clearScheduledAt = req.body?.scheduledAt === null || req.body?.scheduledAt === "";
    if (!clearScheduledAt && req.body?.scheduledAt !== undefined) {
      if (typeof req.body.scheduledAt !== "string" || !req.body.scheduledAt.trim()) {
        return res.status(400).json({ success: false, msg: "Invalid scheduledAt date" });
      }
      const when = new Date(req.body.scheduledAt);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ success: false, msg: "Invalid scheduledAt date" });
      }
      parsedScheduledAt = when;
    }

    const willBeScheduled = (nextStatus ?? doc.status) === "scheduled";
    const effectiveScheduledAt = parsedScheduledAt ?? (clearScheduledAt ? undefined : doc.scheduledAt);
    if (willBeScheduled && !effectiveScheduledAt) {
      return res.status(400).json({
        success: false,
        msg: "scheduledAt is required when status is 'scheduled'",
      });
    }

    if (nextStatus) doc.status = nextStatus;
    if (parsedScheduledAt) doc.scheduledAt = parsedScheduledAt;
    else if (clearScheduledAt) doc.scheduledAt = undefined;
    if (typeof req.body?.adminResponse === "string") {
      doc.adminResponse = req.body.adminResponse.trim().slice(0, 2000);
    }

    await doc.save();
    return res.status(200).json({ success: true, data: doc });
  } catch (error) {
    console.error("Admin update meeting request error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update request" });
  }
};
