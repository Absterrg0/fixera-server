import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import BacklinkConfig from '../../models/backlinkConfig';
import BacklinkSubmission from '../../models/backlinkSubmission';
import PointTransaction from '../../models/pointTransaction';
import {
  adminApproveSubmission,
  adminRejectSubmission,
  adminRevokeSubmission,
  adminReprocessSubmission,
  BacklinkError,
} from '../../utils/backlink';
import { params } from '../../utils/requestParams';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function getAdminId(req: Request): mongoose.Types.ObjectId | null {
  const id = (req as any).admin?._id;
  if (!id) return null;
  return new mongoose.Types.ObjectId(id.toString());
}

function parsePagination(query: Record<string, unknown>): { page: number; limit: number; skip: number } {
  let page = parseInt(query.page as string, 10);
  let limit = parseInt(query.limit as string, 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  return { page, limit, skip: (page - 1) * limit };
}

function respondBacklinkError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof BacklinkError) {
    return res.status(error.httpStatus).json({ success: false, msg: error.message });
  }
  return next(error);
}

const VALID_STATUSES = ['pending_verification', 'verifying', 'verified', 'rejected', 'revoked'] as const;

// ------------------------------------------------------------------
// GET /api/admin/backlinks/config
// ------------------------------------------------------------------

export const getBacklinkConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const config = await BacklinkConfig.getCurrentConfig();
    return res.status(200).json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------
// PUT /api/admin/backlinks/config
// ------------------------------------------------------------------

export const updateBacklinkConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const adminId = getAdminId(req);
    if (!adminId) {
      return res.status(401).json({ success: false, msg: 'Admin authentication required' });
    }

    const {
      isEnabled,
      customerRewardPoints,
      professionalRewardPoints,
      allowedTargetDomains,
      crawlTimeoutMs,
      requireFollowLink,
      resubmitCooldownHours,
    } = req.body as Record<string, unknown>;

    const config = await BacklinkConfig.getCurrentConfig();

    if (typeof isEnabled === 'boolean') config.isEnabled = isEnabled;

    if (customerRewardPoints !== undefined) {
      const n = Number(customerRewardPoints);
      if (isNaN(n) || n < 0) {
        return res.status(400).json({ success: false, msg: 'customerRewardPoints must be a non-negative number' });
      }
      config.customerRewardPoints = n;
    }

    if (professionalRewardPoints !== undefined) {
      const n = Number(professionalRewardPoints);
      if (isNaN(n) || n < 0) {
        return res.status(400).json({ success: false, msg: 'professionalRewardPoints must be a non-negative number' });
      }
      config.professionalRewardPoints = n;
    }

    if (allowedTargetDomains !== undefined) {
      if (!Array.isArray(allowedTargetDomains) || allowedTargetDomains.some((d) => typeof d !== 'string')) {
        return res.status(400).json({ success: false, msg: 'allowedTargetDomains must be an array of strings' });
      }
      config.allowedTargetDomains = allowedTargetDomains as string[];
    }

    if (crawlTimeoutMs !== undefined) {
      const n = Number(crawlTimeoutMs);
      if (isNaN(n) || n < 5000 || n > 120000) {
        return res.status(400).json({ success: false, msg: 'crawlTimeoutMs must be between 5000 and 120000' });
      }
      config.crawlTimeoutMs = n;
    }

    if (typeof requireFollowLink === 'boolean') config.requireFollowLink = requireFollowLink;

    if (resubmitCooldownHours !== undefined) {
      const n = Number(resubmitCooldownHours);
      if (isNaN(n) || n < 0) {
        return res.status(400).json({ success: false, msg: 'resubmitCooldownHours must be a non-negative number' });
      }
      config.resubmitCooldownHours = n;
    }

    config.lastModifiedBy = adminId;
    config.lastModified = new Date();
    await config.save();

    return res.status(200).json({
      success: true,
      msg: 'Backlink configuration updated',
      data: config,
    });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------
// GET /api/admin/backlinks/analytics
// ------------------------------------------------------------------

export const getBacklinkAnalytics = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      total,
      pending,
      verified,
      rejected,
      revoked,
      thisMonth,
      totalPointsResult,
      unclawedPointsResult,
      topSubmitters,
    ] = await Promise.all([
      BacklinkSubmission.countDocuments(),
      BacklinkSubmission.countDocuments({ status: { $in: ['pending_verification', 'verifying'] } }),
      BacklinkSubmission.countDocuments({ status: 'verified' }),
      BacklinkSubmission.countDocuments({ status: 'rejected' }),
      BacklinkSubmission.countDocuments({ status: 'revoked' }),
      BacklinkSubmission.countDocuments({ createdAt: { $gte: thisMonthStart } }),
      PointTransaction.aggregate([
        { $match: { source: 'backlink', type: 'earn' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      BacklinkSubmission.aggregate([
        { $match: { unclawedPoints: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$unclawedPoints' } } },
      ]),
      BacklinkSubmission.aggregate([
        { $match: { status: 'verified' } },
        { $group: { _id: '$userId', count: { $sum: 1 }, totalPoints: { $sum: '$rewardPoints' } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: '$user' },
        {
          $project: {
            _id: 1,
            name: '$user.name',
            email: '$user.email',
            role: '$user.role',
            verifiedCount: '$count',
            totalPoints: 1,
          },
        },
      ]),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        total,
        pending,
        verified,
        rejected,
        revoked,
        thisMonth,
        totalPointsIssued: totalPointsResult[0]?.total ?? 0,
        totalUnclawedPoints: unclawedPointsResult[0]?.total ?? 0,
        topSubmitters,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------
// GET /api/admin/backlinks/list
// ------------------------------------------------------------------

export const listBacklinkSubmissions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { status, userId, domain, dateFrom, dateTo } = req.query;

    const filter: Record<string, unknown> = {};

    if (status && VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
      filter.status = status;
    }

    if (userId && mongoose.Types.ObjectId.isValid(userId as string)) {
      filter.userId = new mongoose.Types.ObjectId(userId as string);
    }

    if (domain && typeof domain === 'string') {
      filter.domain = domain.toLowerCase();
    }

    if (dateFrom || dateTo) {
      const dateFilter: Record<string, Date> = {};
      if (dateFrom) {
        const from = new Date(dateFrom as string);
        if (isNaN(from.getTime())) {
          return res.status(400).json({ success: false, msg: 'dateFrom must be a valid date' });
        }
        dateFilter.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo as string);
        if (isNaN(to.getTime())) {
          return res.status(400).json({ success: false, msg: 'dateTo must be a valid date' });
        }
        dateFilter.$lte = to;
      }
      filter.createdAt = dateFilter;
    }

    const [submissions, total] = await Promise.all([
      BacklinkSubmission.find(filter)
        .populate('userId', 'name email role')
        .populate('revokedBy', 'name email')
        .populate('reviewedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      BacklinkSubmission.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        submissions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------
// POST /api/admin/backlinks/:id/approve
// ------------------------------------------------------------------

export const approveBacklink = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const adminId = getAdminId(req);
    if (!adminId) {
      return res.status(401).json({ success: false, msg: 'Admin authentication required' });
    }

    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid submission ID' });
    }

    const updated = await adminApproveSubmission(
      new mongoose.Types.ObjectId(id),
      adminId,
    );

    return res.status(200).json({
      success: true,
      msg: 'Submission approved and points awarded',
      data: updated,
    });
  } catch (error) {
    return respondBacklinkError(error, res, next);
  }
};

// ------------------------------------------------------------------
// POST /api/admin/backlinks/:id/reject
// ------------------------------------------------------------------

export const rejectBacklink = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const adminId = getAdminId(req);
    if (!adminId) {
      return res.status(401).json({ success: false, msg: 'Admin authentication required' });
    }

    const { id } = params(req.params);
    const { reason } = req.body as { reason?: unknown };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid submission ID' });
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ success: false, msg: 'reason is required' });
    }

    const updated = await adminRejectSubmission(
      new mongoose.Types.ObjectId(id),
      adminId,
      reason.trim(),
    );

    return res.status(200).json({
      success: true,
      msg: 'Submission rejected',
      data: updated,
    });
  } catch (error) {
    return respondBacklinkError(error, res, next);
  }
};

// ------------------------------------------------------------------
// POST /api/admin/backlinks/:id/revoke
// ------------------------------------------------------------------

export const revokeBacklink = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const adminId = getAdminId(req);
    if (!adminId) {
      return res.status(401).json({ success: false, msg: 'Admin authentication required' });
    }

    const { id } = params(req.params);
    const { reason } = req.body as { reason?: unknown };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid submission ID' });
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ success: false, msg: 'reason is required' });
    }

    const updated = await adminRevokeSubmission(
      new mongoose.Types.ObjectId(id),
      adminId,
      reason.trim(),
    );

    const unclawed = updated.unclawedPoints ?? 0;
    const msg = unclawed > 0
      ? `Submission revoked. ${unclawed} points could not be clawed back (already spent).`
      : 'Submission revoked and points clawed back';

    return res.status(200).json({ success: true, msg, data: updated });
  } catch (error) {
    return respondBacklinkError(error, res, next);
  }
};

// ------------------------------------------------------------------
// POST /api/admin/backlinks/:id/reprocess
// ------------------------------------------------------------------

export const reprocessBacklink = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid submission ID' });
    }

    await adminReprocessSubmission(new mongoose.Types.ObjectId(id));

    return res.status(202).json({
      success: true,
      msg: 'Reprocessing started — verification is running in the background',
    });
  } catch (error) {
    return respondBacklinkError(error, res, next);
  }
};
