import mongoose, { Document, Schema, Model } from 'mongoose';

const SINGLETON_ID = 'site-settings';

export interface ISocialLinks {
  facebook?: string;
  twitter?: string;
  instagram?: string;
  linkedin?: string;
  tiktok?: string;
  youtube?: string;
}

export interface ISiteSettings extends Omit<Document, '_id'> {
  _id: string;
  socialLinks: ISocialLinks;
  lastModifiedBy?: mongoose.Types.ObjectId;
  lastModified: Date;
}

export interface ISiteSettingsModel extends Model<ISiteSettings> {
  getCurrent(): Promise<ISiteSettings>;
}

const socialLinksSchema = new Schema<ISocialLinks>(
  {
    facebook: { type: String, trim: true, maxlength: 500 },
    twitter: { type: String, trim: true, maxlength: 500 },
    instagram: { type: String, trim: true, maxlength: 500 },
    linkedin: { type: String, trim: true, maxlength: 500 },
    tiktok: { type: String, trim: true, maxlength: 500 },
    youtube: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const siteSettingsSchema = new Schema<ISiteSettings>({
  _id: {
    type: String,
    default: SINGLETON_ID,
  },
  socialLinks: { type: socialLinksSchema, default: () => ({}) },
  lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastModified: { type: Date, default: Date.now },
});

siteSettingsSchema.statics.getCurrent = async function (): Promise<ISiteSettings> {
  const doc = await this.findOneAndUpdate(
    { _id: SINGLETON_ID },
    { $setOnInsert: { socialLinks: {}, lastModified: new Date() } },
    { upsert: true, new: true }
  );
  return doc;
};

const SiteSettings = mongoose.model<ISiteSettings, ISiteSettingsModel>(
  'SiteSettings',
  siteSettingsSchema
);

export default SiteSettings;
