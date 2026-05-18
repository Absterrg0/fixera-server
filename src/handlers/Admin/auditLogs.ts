import { Request, Response } from 'express';
import mongoose from 'mongoose';
import AuditLog from '../../models/auditLog';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const buildAuditLogQuery = (query: Request['query']): Record<string, any> => {
  const { action, actor, actorEmail, targetType, targetId, status, from, until } = query;
  const out: Record<string, any> = {};

  if (typeof action === 'string' && action.trim()) {
    out.action = action.trim();
  }

  if (typeof actor === 'string' && mongoose.Types.ObjectId.isValid(actor)) {
    out.actor = new mongoose.Types.ObjectId(actor);
  }

  if (typeof actorEmail === 'string' && actorEmail.trim().length >= 2) {
    out.actorEmail = new RegExp(escapeRegex(actorEmail.trim().toLowerCase()), 'i');
  }

  if (typeof targetType === 'string' && targetType.trim()) {
    out.targetType = targetType.trim();
  }

  if (typeof targetId === 'string' && mongoose.Types.ObjectId.isValid(targetId)) {
    out.targetId = new mongoose.Types.ObjectId(targetId);
  }

  if (typeof status === 'string' && (status === 'success' || status === 'failure')) {
    out.status = status;
  }

  const fromDate = parseDate(from);
  const untilDate = parseDate(until);
  if (
    untilDate &&
    untilDate.getUTCHours() === 0 &&
    untilDate.getUTCMinutes() === 0 &&
    untilDate.getUTCSeconds() === 0 &&
    untilDate.getUTCMilliseconds() === 0
  ) {
    untilDate.setUTCHours(23, 59, 59, 999);
  }
  if (fromDate || untilDate) {
    out.createdAt = {};
    if (fromDate) out.createdAt.$gte = fromDate;
    if (untilDate) out.createdAt.$lte = untilDate;
  }

  return out;
};

export const listAuditLogs = async (req: Request, res: Response) => {
  try {
    const { page, limit } = req.query;

    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const skip = (pageNumber - 1) * limitNumber;

    const query = buildAuditLogQuery(req.query);

    const [logs, totalCount] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.max(1, Math.ceil(totalCount / limitNumber)),
        },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS] Failed to list logs', error);
    return res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to load audit logs',
    });
  }
};

export const getAuditLogStats = async (req: Request, res: Response) => {
  try {
    const query = buildAuditLogQuery(req.query);

    const [total, failures, uniqueActors] = await Promise.all([
      AuditLog.countDocuments(query),
      AuditLog.countDocuments({ ...query, status: 'failure' }),
      AuditLog.distinct('actor', query),
    ]);

    return res.json({
      success: true,
      data: {
        total,
        failures,
        uniqueActors: uniqueActors.filter(Boolean).length,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS][STATS] Failed', error);
    return res.status(500).json({ success: false, msg: error?.message || 'Failed to load audit stats' });
  }
};
