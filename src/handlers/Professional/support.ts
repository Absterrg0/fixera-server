import { Request, Response } from "express";
import mongoose from "mongoose";
import SupportTicket from "../../models/supportTicket";
import MeetingRequest from "../../models/meetingRequest";
import connectDB from "../../config/db";
import { IUser } from "../../models/user";
import { params } from "../../utils/requestParams";

const isValidObjectId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

export const createSupportTicket = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";

    if (!subject || subject.length > 200) {
      return res.status(400).json({ success: false, msg: "Subject is required (max 200 chars)" });
    }
    if (!description || description.length > 5000) {
      return res.status(400).json({ success: false, msg: "Description is required (max 5000 chars)" });
    }

    await connectDB();
    const ticket = await SupportTicket.create({
      userId: user._id,
      subject,
      description,
    });

    return res.status(201).json({ success: true, data: ticket });
  } catch (error) {
    console.error("Create support ticket error:", error);
    return res.status(500).json({ success: false, msg: "Failed to create ticket" });
  }
};

export const listMyTickets = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    await connectDB();
    const items = await SupportTicket.find({ userId: user._id })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    console.error("List my tickets error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load tickets" });
  }
};

export const replyToMyTicket = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    const { id } = params(req.params);
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, msg: "Invalid ticket ID" });

    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body || body.length > 5000) {
      return res.status(400).json({ success: false, msg: "Reply body is required (max 5000 chars)" });
    }

    await connectDB();
    const ticket = await SupportTicket.findOne({ _id: id, userId: user._id });
    if (!ticket) return res.status(404).json({ success: false, msg: "Ticket not found" });
    if (ticket.status === "closed") {
      return res.status(400).json({ success: false, msg: "Ticket is closed" });
    }

    ticket.replies.push({
      authorId: user._id,
      authorRole: "professional",
      body,
      createdAt: new Date(),
    });
    await ticket.save();
    return res.status(200).json({ success: true, data: ticket });
  } catch (error) {
    console.error("Reply to ticket error:", error);
    return res.status(500).json({ success: false, msg: "Failed to reply" });
  }
};

export const createMeetingRequest = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
    const preferredTimes = typeof req.body?.preferredTimes === "string" ? req.body.preferredTimes.trim() : "";
    const durationProvided = req.body?.durationMinutes !== undefined && req.body?.durationMinutes !== null;
    let durationMinutes = 30;
    if (durationProvided) {
      const durationRaw = Number(req.body.durationMinutes);
      if (!Number.isInteger(durationRaw) || durationRaw < 15 || durationRaw > 240) {
        return res.status(400).json({ success: false, msg: "durationMinutes must be between 15 and 240" });
      }
      durationMinutes = durationRaw;
    }

    if (!topic || topic.length > 200) {
      return res.status(400).json({ success: false, msg: "Topic is required (max 200 chars)" });
    }
    if (!preferredTimes || preferredTimes.length > 1000) {
      return res.status(400).json({ success: false, msg: "Preferred times are required (max 1000 chars)" });
    }

    await connectDB();
    const request = await MeetingRequest.create({
      userId: user._id,
      topic,
      preferredTimes,
      durationMinutes,
    });

    return res.status(201).json({ success: true, data: request });
  } catch (error) {
    console.error("Create meeting request error:", error);
    return res.status(500).json({ success: false, msg: "Failed to create meeting request" });
  }
};

export const listMyMeetingRequests = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    await connectDB();
    const items = await MeetingRequest.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    console.error("List my meeting requests error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load meeting requests" });
  }
};
