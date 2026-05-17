import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import ServiceView from '../../models/serviceView';
import User from '../../models/user';

const hashVisitor = (ip: string, userAgent: string): string =>
  crypto.createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 32);

const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9\-_]{0,80}$/i;

export const recordServiceView = async (req: Request, res: Response) => {
  try {
    const rawServiceId = (req.params.serviceId || '').trim();
    if (!rawServiceId || !SERVICE_ID_PATTERN.test(rawServiceId)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_SERVICE_ID', message: 'Invalid service id' } });
    }
    const serviceId = rawServiceId.toLowerCase();

    const viewerId = (req as any).user?._id ? new mongoose.Types.ObjectId((req as any).user._id) : undefined;

    let city: string | null = null;
    if (viewerId) {
      const user = await User.findById(viewerId).select('location.city companyAddress.city businessInfo.city').lean();
      const u: any = user;
      city =
        (u?.location?.city && String(u.location.city).trim()) ||
        (u?.companyAddress?.city && String(u.companyAddress.city).trim()) ||
        (u?.businessInfo?.city && String(u.businessInfo.city).trim()) ||
        null;
    }

    const ip = req.ip || 'unknown';
    const ua = (req.headers['user-agent'] as string) || 'unknown';
    const visitorKey = viewerId ? `u:${viewerId.toString()}` : `ip:${hashVisitor(ip, ua)}`;
    const dayKey = new Date().toISOString().slice(0, 10);

    try {
      await ServiceView.create({
        serviceId,
        viewer: viewerId,
        visitorKey,
        dayKey,
        city,
      });
      return res.json({ success: true, data: { recorded: true } });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.json({ success: true, data: { recorded: false, reason: 'duplicate' } });
      }
      throw err;
    }
  } catch (error: any) {
    console.error('Error recording service view:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to record view' } });
  }
};
