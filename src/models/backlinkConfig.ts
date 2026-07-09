import mongoose, { Document, Schema, Model } from 'mongoose';

const SINGLETON_ID = 'backlink-config';

export interface IBacklinkConfig extends Omit<Document, '_id'> {
  _id: string;
  isEnabled: boolean;
  customerRewardPoints: number;
  professionalRewardPoints: number;
  /** Allowed target domains — seeded by the service layer from FRONTEND_URL; editable by admin at runtime */
  allowedTargetDomains: string[];
  /** Firecrawl request timeout in ms */
  crawlTimeoutMs: number;
  /** If true, links with rel="nofollow" are rejected */
  requireFollowLink: boolean;
  /** Cooldown in hours before the same user can resubmit a rejected URL (per-user, not global) */
  resubmitCooldownHours: number;
  lastModifiedBy?: mongoose.Types.ObjectId;
  lastModified: Date;
}

export interface IBacklinkConfigModel extends Model<IBacklinkConfig> {
  getCurrentConfig(): Promise<IBacklinkConfig>;
}

/**
 * Known production hostname seeded into the DB on first upsert.
 * The service layer always unions this list with the FRONTEND_URL env var
 * at runtime, so dev/staging environments are covered automatically.
 */
const PROD_ALLOWED_DOMAINS = ['fixtract-rho.vercel.app', 'www.fixtract-rho.vercel.app'];

export const DEFAULT_BACKLINK_CONFIG = {
  isEnabled: false,
  customerRewardPoints: 50,
  professionalRewardPoints: 50,
  allowedTargetDomains: PROD_ALLOWED_DOMAINS,
  crawlTimeoutMs: 30_000,
  requireFollowLink: false,
  resubmitCooldownHours: 24,
};

const backlinkConfigSchema = new Schema<IBacklinkConfig>(
  {
    _id: {
      type: String,
      default: SINGLETON_ID,
    },
    isEnabled: {
      type: Boolean,
      default: DEFAULT_BACKLINK_CONFIG.isEnabled,
    },
    customerRewardPoints: {
      type: Number,
      default: DEFAULT_BACKLINK_CONFIG.customerRewardPoints,
      min: 0,
    },
    professionalRewardPoints: {
      type: Number,
      default: DEFAULT_BACKLINK_CONFIG.professionalRewardPoints,
      min: 0,
    },
    allowedTargetDomains: {
      type: [String],
      default: DEFAULT_BACKLINK_CONFIG.allowedTargetDomains,
    },
    crawlTimeoutMs: {
      type: Number,
      default: DEFAULT_BACKLINK_CONFIG.crawlTimeoutMs,
      min: 5_000,
      max: 120_000,
    },
    requireFollowLink: {
      type: Boolean,
      default: DEFAULT_BACKLINK_CONFIG.requireFollowLink,
    },
    resubmitCooldownHours: {
      type: Number,
      default: DEFAULT_BACKLINK_CONFIG.resubmitCooldownHours,
      min: 0,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    lastModified: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

/** Singleton upsert — pinned to a fixed _id to avoid duplicate config docs. */
backlinkConfigSchema.statics.getCurrentConfig =
  async function (): Promise<IBacklinkConfig> {
    const config = await this.findOneAndUpdate(
      { _id: SINGLETON_ID },
      { $setOnInsert: { ...DEFAULT_BACKLINK_CONFIG, lastModified: new Date() } },
      { upsert: true, new: true },
    );
    return config;
  };

const BacklinkConfig = mongoose.model<IBacklinkConfig, IBacklinkConfigModel>(
  'BacklinkConfig',
  backlinkConfigSchema,
);

export default BacklinkConfig;
