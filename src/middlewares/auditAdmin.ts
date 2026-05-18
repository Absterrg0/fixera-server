import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import AuditLog from '../models/auditLog';
import { getRequestIp, sanitizeForAudit } from '../utils/auditLogger';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const PARAM_TO_TARGET_TYPE: Record<string, string> = {
  professionalId: 'User',
  customerId: 'User',
  userId: 'User',
  bookingId: 'Booking',
  paymentId: 'Payment',
  referralId: 'Referral',
};

const METHOD_VERB: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

const deriveAction = (req: Request): string => {
  const baseUrl = req.baseUrl || '';
  const routePath = req.route?.path || '';
  const fullPattern = `${baseUrl}${routePath}`;

  const stripped = fullPattern.replace(/^\/api\/admin\/?/, '').replace(/^\/admin\/?/, '');
  const segments = stripped.split('/').filter((s) => s.length > 0);

  const nonParamSegments = segments.filter((s) => !s.startsWith(':'));
  const lastIsParam = segments.length > 0 && segments[segments.length - 1].startsWith(':');

  const parts = [...nonParamSegments];
  if (lastIsParam || parts.length === 0) {
    parts.push(METHOD_VERB[req.method] || req.method.toLowerCase());
  }

  return ['admin', ...parts].join('.');
};

const deriveTarget = (req: Request): { targetType?: string; targetId?: mongoose.Types.ObjectId } => {
  const params = req.params || {};
  for (const [key, value] of Object.entries(params)) {
    const targetType = PARAM_TO_TARGET_TYPE[key];
    if (targetType && typeof value === 'string' && mongoose.Types.ObjectId.isValid(value)) {
      return { targetType, targetId: new mongoose.Types.ObjectId(value) };
    }
  }
  // Fallback: generic :id without context — log id but no targetType
  if (params.id && typeof params.id === 'string' && mongoose.Types.ObjectId.isValid(params.id)) {
    return { targetId: new mongoose.Types.ObjectId(params.id) };
  }
  return {};
};

export const auditAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    return next();
  }

  const bodySnapshot = sanitizeForAudit(req.body);
  const querySnapshot = sanitizeForAudit(req.query);

  res.on('finish', () => {
    try {
      if ((req as any).__auditLogged) return;

      const statusCode = res.statusCode;
      if (statusCode === 404) return;

      const actorUser = (req as any).user || (req as any).admin;
      const action = deriveAction(req);
      const { targetType, targetId } = deriveTarget(req);

      const status = statusCode >= 200 && statusCode < 400 ? 'success' : 'failure';

      AuditLog.create({
        actor: actorUser?._id,
        actorRole: actorUser?.role,
        actorEmail: actorUser?.email,
        action,
        targetType,
        targetId,
        method: req.method,
        path: req.originalUrl?.split('?')[0] || req.path,
        details: {
          body: bodySnapshot,
          query: Object.keys(querySnapshot || {}).length > 0 ? querySnapshot : undefined,
          params: Object.keys(req.params || {}).length > 0 ? req.params : undefined,
        },
        ip: getRequestIp(req),
        userAgent: req.headers['user-agent']?.toString().slice(0, 500),
        status,
        statusCode,
      }).catch((err: any) => {
        console.error('auditAdmin: failed to persist log', err?.message || err);
      });
    } catch (err: any) {
      console.error('auditAdmin: error in finish handler', err?.message || err);
    }
  });

  next();
};
