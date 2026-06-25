import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IBacklinkConfig extends Document {
  isEnabled: boolean;
  customerRewardPoints: number;
  professionalRewardPoints: number;
  /** Allowed target domains — seeded by the service layer from FRONTEND_URL; editable by admin at runtime */
  allowedTargetDomains: string[];
  /** Firecrawl request timeout in ms */
  crawlTimeoutMs: number;
  /** If true, links with rel="nofollow" are rejected */
  requireFollowLink: boolean;
  /** Cooldown in hours before a rejected URL can be resubmitted by the same user */
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
const PROD_ALLOWED_DOMAINS = ['fixera-rho.vercel.app', 'www.fixera-rho.vercel.app'];

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

/** Singleton upsert — mirrors the ReferralConfig pattern exactly. */
backlinkConfigSchema.statics.getCurrentConfig =
  async function (): Promise<IBacklinkConfig> {
    const config = await this.findOneAndUpdate(
      {},
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
