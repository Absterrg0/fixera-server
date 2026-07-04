import mongoose, { Document, Schema } from 'mongoose';

export type BacklinkStatus =
  | 'pending_verification'
  | 'verifying'
  | 'verified'
  | 'rejected'
  | 'revoked';

export type VerificationMethod = 'firecrawl' | 'manual';

export interface ICrawlResult {
  crawledAt: Date;
  pageTitle?: string;
  foundLinks: Array<{
    href: string;
    anchorText?: string;
    rel?: string;
  }>;
  rawMarkdownLength?: number;
  firecrawlJobId?: string;
}

export interface IBacklinkSubmission extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  /** Raw URL as submitted by the user */
  submittedUrl: string;
  /** Canonical form used for deduplication (lowercase host, no hash, no trailing slash) */
  normalizedUrl: string;
  /** Hostname of the submitted page — used for rate-limit display */
  domain: string;
  status: BacklinkStatus;
  verificationMethod: VerificationMethod;
  crawlResult?: ICrawlResult;
  /** Points snapshot captured at verification time */
  rewardPoints?: number;
  rewardIssuedAt?: Date;
  pointTransactionId?: mongoose.Types.ObjectId;
  rejectionReason?: string;
  /** Set when automated verification needs admin follow-up (distinct from rejectionReason). */
  adminReviewReason?: string;
  /**
   * Timestamp set when a submission is rejected.
   * Used to enforce the per-URL resubmit cooldown.
   */
  lastRejectedAt?: Date;
  revokedReason?: string;
  revokedAt?: Date;
  revokedBy?: mongoose.Types.ObjectId;
  /**
   * Points the admin tried to claw back but couldn't because
   * the user had already spent them. Recorded for audit visibility.
   */
  unclawedPoints?: number;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  /** Submitter IP stored for abuse detection — mirrors referral model */
  ipAddress?: string;
  createdAt: Date;
  updatedAt: Date;
}

const crawlResultSchema = new Schema<ICrawlResult>(
  {
    crawledAt: { type: Date, required: true },
    pageTitle: { type: String, required: false },
    foundLinks: [
      {
        href: { type: String, required: true },
        anchorText: { type: String, required: false },
        rel: { type: String, required: false },
        _id: false,
      },
    ],
    rawMarkdownLength: { type: Number, required: false },
    firecrawlJobId: { type: String, required: false },
  },
  { _id: false },
);

const backlinkSubmissionSchema = new Schema<IBacklinkSubmission>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    submittedUrl: {
      type: String,
      required: true,
      maxlength: 2048,
      trim: true,
    },
    normalizedUrl: {
      type: String,
      required: true,
      maxlength: 2048,
    },
    domain: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending_verification', 'verifying', 'verified', 'rejected', 'revoked'],
      default: 'pending_verification',
      index: true,
    },
    verificationMethod: {
      type: String,
      enum: ['firecrawl', 'manual'],
      required: true,
    },
    crawlResult: {
      type: crawlResultSchema,
      required: false,
    },
    rewardPoints: {
      type: Number,
      required: function (this: IBacklinkSubmission) {
        return this.status === 'verified';
      },
      min: 0,
    },
    rewardIssuedAt: {
      type: Date,
      required: false,
    },
    pointTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PointTransaction',
      required: false,
    },
    rejectionReason: {
      type: String,
      required: false,
      maxlength: 500,
    },
    adminReviewReason: {
      type: String,
      required: false,
      maxlength: 500,
    },
    lastRejectedAt: {
      type: Date,
      required: false,
    },
    revokedReason: {
      type: String,
      required: false,
      maxlength: 500,
    },
    revokedAt: {
      type: Date,
      required: false,
    },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    unclawedPoints: {
      type: Number,
      required: false,
      min: 0,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    reviewedAt: {
      type: Date,
      required: false,
    },
    ipAddress: {
      type: String,
      required: false,
    },
  },
  { timestamps: true },
);

// ── Indexes ────────────────────────────────────────────────────────────────

/** Primary dedup guard — only ONE active submission per URL allowed globally. */
backlinkSubmissionSchema.index(
  { normalizedUrl: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['pending_verification', 'verifying', 'verified'] },
    },
  },
);

/** User submission list — descending by creation date */
backlinkSubmissionSchema.index({ userId: 1, createdAt: -1 });

/** Admin queue — status-ordered by submission time */
backlinkSubmissionSchema.index({ status: 1, createdAt: 1 });

/** Domain-level queries (admin analytics) */
backlinkSubmissionSchema.index({ domain: 1, status: 1 });

const BacklinkSubmission = mongoose.model<IBacklinkSubmission>(
  'BacklinkSubmission',
  backlinkSubmissionSchema,
);

export default BacklinkSubmission;
