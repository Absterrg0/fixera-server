import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import ProfileView from '../../models/profileView';
import User from '../../models/user';
import { params } from '../../utils/requestParams';

const hashVisitor = (ip: string, userAgent: string): string =>
  crypto.createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 32);

export const recordProfessionalView = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid professional id' } });
    }

    const professionalId = new mongoose.Types.ObjectId(id);
    const pro = await User.findOne({ _id: professionalId, role: 'professional' }).select('_id');
    if (!pro) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Professional not found' } });
    }

    const viewerId = (req as any).user?._id ? new mongoose.Types.ObjectId((req as any).user._id) : undefined;

    if (viewerId && viewerId.equals(professionalId)) {
      return res.json({ success: true, data: { recorded: false, reason: 'self_view' } });
    }

    const ip = req.ip || 'unknown';
    const ua = (req.headers['user-agent'] as string) || 'unknown';
    const visitorKey = viewerId ? `u:${viewerId.toString()}` : `ip:${hashVisitor(ip, ua)}`;
    const dayKey = new Date().toISOString().slice(0, 10);

    try {
      await ProfileView.create({
        professional: professionalId,
        viewer: viewerId,
        visitorKey,
        dayKey,
      });
      return res.json({ success: true, data: { recorded: true } });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.json({ success: true, data: { recorded: false, reason: 'duplicate' } });
      }
      throw err;
    }
  } catch (error: any) {
    console.error('Error recording profile view:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to record view' } });
  }
};
