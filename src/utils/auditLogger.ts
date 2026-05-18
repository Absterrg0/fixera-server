import { Request } from 'express';
import mongoose from 'mongoose';
import AuditLog, { AuditLogStatus } from '../models/auditLog';

interface AuditLogInput {
  req: Request;
  action: string;
  targetType?: string;
  targetId?: string | mongoose.Types.ObjectId;
  details?: Record<string, any>;
  status?: AuditLogStatus;
  statusCode?: number;
  errorMessage?: string;
}

const SENSITIVE_KEY_PATTERN = /password|token|secret|cvv|cardNumber|verificationCode|idProof/i;
const MAX_STRING_LENGTH = 2048;

export const getRequestIp = (req: Request): string | undefined => {
  const forwardedFor = req.headers['x-forwarded-for']?.toString();
  const fromHeader = forwardedFor ? forwardedFor.split(',')[0].trim() : '';
  return fromHeader || req.ip || undefined;
};

export const sanitizeForAudit = (value: any, depth = 0): any => {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[truncated:depth]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return '[binary]';
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (value.length > 50) return `[array length=${value.length} truncated]`;
    return value.map((item) => sanitizeForAudit(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = sanitizeForAudit(val, depth + 1);
    }
    return out;
  }

  return undefined;
};

const toObjectId = (value?: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId | undefined => {
  if (!value) return undefined;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === 'string' && mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return undefined;
};

export const auditLog = async (input: AuditLogInput): Promise<void> => {
  try {
    const { req, action, targetType, targetId, details, status, statusCode, errorMessage } = input;

    (req as any).__auditLogged = true;

    const actorUser = (req as any).user || (req as any).admin;
    const actorId = actorUser?._id;
    const actorRole: string | undefined = actorUser?.role;
    const actorEmail: string | undefined = actorUser?.email;

    await AuditLog.create({
      actor: actorId,
      actorRole,
      actorEmail,
      action,
      targetType,
      targetId: toObjectId(targetId),
      method: req.method,
      path: req.originalUrl?.split('?')[0] || req.path,
      details: details ? sanitizeForAudit(details) : undefined,
      ip: getRequestIp(req),
      userAgent: req.headers['user-agent']?.toString().slice(0, 500),
      status: status ?? 'success',
      statusCode,
      errorMessage,
    });
  } catch (err: any) {
    console.error('Failed to write AuditLog entry:', err?.message || err);
  }
};
