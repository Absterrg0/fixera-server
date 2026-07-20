import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Notification from '../../models/notification';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * GET /api/user/notifications
 * Cursor pagination via `before` (ISO date or ObjectId createdAt of last item).
 */
export const listNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const limit = parseLimit(req.query.limit);
    const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;

    const filter: Record<string, unknown> = { userId };
    if (unreadOnly) filter.readAt = null;
    if (before) {
      const sep = before.indexOf('|');
      if (sep !== -1) {
        const beforeDate = new Date(before.slice(0, sep));
        const beforeId = before.slice(sep + 1);
        if (Number.isNaN(beforeDate.getTime()) || !mongoose.Types.ObjectId.isValid(beforeId)) {
          res.status(400).json({ success: false, msg: 'Invalid pagination cursor' });
          return;
        }
        filter.$or = [
          { createdAt: { $lt: beforeDate } },
          { createdAt: beforeDate, _id: { $lt: new mongoose.Types.ObjectId(beforeId) } },
        ];
      } else {
        // Legacy ISO-only cursors
        const beforeDate = new Date(before);
        if (Number.isNaN(beforeDate.getTime())) {
          res.status(400).json({ success: false, msg: 'Invalid pagination cursor' });
          return;
        }
        filter.createdAt = { $lt: beforeDate };
      }
    }

    const items = await Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore && page.length
      ? `${page[page.length - 1].createdAt.toISOString()}|${page[page.length - 1]._id.toString()}`
      : null;

    const unreadCount = await Notification.countDocuments({ userId, readAt: null });

    res.status(200).json({
      success: true,
      data: {
        items: page.map((n) => ({
          id: n._id.toString(),
          eventKey: n.eventKey,
          category: n.category,
          title: n.title,
          body: n.body,
          clickUrl: n.clickUrl,
          entityType: n.entityType,
          entityId: n.entityId?.toString(),
          readAt: n.readAt,
          createdAt: n.createdAt,
        })),
        unreadCount,
        nextCursor,
      },
    });
  } catch (err) {
    console.error('listNotifications error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};

/**
 * GET /api/user/notifications/unread-count
 */
export const getUnreadNotificationCount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const unreadCount = await Notification.countDocuments({ userId, readAt: null });
    res.status(200).json({ success: true, data: { unreadCount } });
  } catch (err) {
    console.error('getUnreadNotificationCount error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};

/**
 * PATCH /api/user/notifications/:id/read
 */
export const markNotificationRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const idRaw = req.params.id;
    const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, msg: 'Invalid notification id' });
      return;
    }

    const updated = await Notification.findOneAndUpdate(
      { _id: id, userId, readAt: null },
      { $set: { readAt: new Date() } },
      { new: true },
    );

    if (!updated) {
      const existing = await Notification.findOne({ _id: id, userId }).select('_id readAt');
      if (!existing) {
        res.status(404).json({ success: false, msg: 'Notification not found' });
        return;
      }
      // Already read — idempotent success
      res.status(200).json({ success: true, data: { id, readAt: existing.readAt } });
      return;
    }

    res.status(200).json({
      success: true,
      data: { id: updated._id.toString(), readAt: updated.readAt },
    });
  } catch (err) {
    console.error('markNotificationRead error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};

/**
 * POST /api/user/notifications/read-all
 */
export const markAllNotificationsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const result = await Notification.updateMany(
      { userId, readAt: null },
      { $set: { readAt: new Date() } },
    );

    res.status(200).json({
      success: true,
      data: { modifiedCount: result.modifiedCount },
    });
  } catch (err) {
    console.error('markAllNotificationsRead error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};
