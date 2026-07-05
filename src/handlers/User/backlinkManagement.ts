import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import {
  BacklinkError,
  createBacklinkSubmission,
  getUserBacklinkStats,
} from '../../utils/backlink';
import BacklinkSubmission from '../../models/backlinkSubmission';
import { BACKLINK_SUBMISSION_PUBLIC_FIELDS } from '../../utils/backlink/constants';
import { params } from '../../utils/requestParams';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function getUserId(req: Request): mongoose.Types.ObjectId | null {
  const id = req.user?._id;
  if (!id) return null;
  return new mongoose.Types.ObjectId(id);
}

function extractIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || '';
}

// ------------------------------------------------------------------
// POST /api/user/backlinks/submit
// ------------------------------------------------------------------

/**
 * Submit a new external URL for backlink verification.
 * Returns 202 immediately — verification is async.
 */
export const submitBacklink = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const { url } = req.body as { url?: unknown };
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ success: false, msg: 'url is required' });
    }

    const submission = await createBacklinkSubmission(userId, url.trim(), extractIp(req));

    return res.status(202).json({
      success: true,
      msg: 'Submission received — verification is in progress',
      data: {
        submissionId: submission._id,
        status: submission.status,
        submittedUrl: submission.submittedUrl,
        domain: submission.domain,
      },
    });
  } catch (error: unknown) {
    if (error instanceof BacklinkError) {
      return res.status(error.httpStatus).json({
        success: false,
        msg: error.message,
        ...(error.cooldownExpiresAt ? { cooldownExpiresAt: error.cooldownExpiresAt } : {}),
      });
    }
    next(error);
  }
};

// ------------------------------------------------------------------
// GET /api/user/backlinks
// ------------------------------------------------------------------

/**
 * List the authenticated user's own submissions (paginated).
 */
export const listBacklinks = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));
    const skip = (page - 1) * limit;

    const [submissions, total] = await Promise.all([
      BacklinkSubmission.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(BACKLINK_SUBMISSION_PUBLIC_FIELDS),
      BacklinkSubmission.countDocuments({ userId }),
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
// GET /api/user/backlinks/stats
// ------------------------------------------------------------------

/**
 * Aggregate stats for the benefits dashboard — program config, verified
 * count, total points earned, and recent submission history.
 */
export const getBacklinkStats = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const stats = await getUserBacklinkStats(userId);

    return res.status(200).json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------
// GET /api/user/backlinks/:id
// ------------------------------------------------------------------

/**
 * Fetch a single submission by ID — only the owning user can access it.
 */
export const getBacklinkById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid submission ID' });
    }

    const submission = await BacklinkSubmission.findOne({
      _id: id,
      userId,
    }).select(BACKLINK_SUBMISSION_PUBLIC_FIELDS);

    if (!submission) {
      return res.status(404).json({ success: false, msg: 'Submission not found' });
    }

    return res.status(200).json({ success: true, data: submission });
  } catch (error) {
    next(error);
  }
};
