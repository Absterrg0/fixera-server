import mongoose, { Document, Schema, Model } from 'mongoose';

const SINGLETON_ID = 'platform-settings';

export interface IPlatformSettings extends Omit<Document, '_id'> {
  _id: string;
  commissionPercent: number;
  lastModifiedBy: mongoose.Types.ObjectId;
  lastModified: Date;
  version: number;
}

export interface IPlatformSettingsModel extends Model<IPlatformSettings> {
  getCurrentConfig(): Promise<IPlatformSettings>;
}

const platformSettingsSchema = new Schema<IPlatformSettings>({
  _id: {
    type: String,
    default: SINGLETON_ID,
  },
  commissionPercent: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
    default: 0,
  },
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  lastModified: {
    type: Date,
    default: Date.now,
  },
  version: {
    type: Number,
    default: 1,
  },
});

// Pre-save: clamp commission, increment version + timestamp only on updates
platformSettingsSchema.pre('save', function (this: IPlatformSettings, next) {
  this.commissionPercent = Math.min(Math.max(this.commissionPercent, 0), 100);
  if (!this.isNew) {
    this.version += 1;
    this.lastModified = new Date();
  }
  next();
});

// Atomic upsert to avoid race conditions on first access
platformSettingsSchema.statics.getCurrentConfig = async function (): Promise<IPlatformSettings> {
  const parsed = Number.parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0');
  const seedValue = Number.isFinite(parsed) ? parsed : 0;

  const config = await this.findOneAndUpdate(
    { _id: SINGLETON_ID },
    {
      $setOnInsert: {
        commissionPercent: seedValue,
        lastModified: new Date(),
        version: 1,
      },
    },
    { upsert: true, new: true }
  );

  return config;
};

const PlatformSettings = mongoose.model<IPlatformSettings, IPlatformSettingsModel>(
  'PlatformSettings',
  platformSettingsSchema
);

export default PlatformSettings;
