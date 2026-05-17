import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IServiceView extends Document {
  serviceId: string;
  viewer?: Types.ObjectId;
  visitorKey: string;
  dayKey: string;
  city?: string | null;
  createdAt: Date;
}

const serviceViewSchema = new Schema<IServiceView>(
  {
    serviceId: { type: String, required: true, index: true, trim: true },
    viewer: { type: Schema.Types.ObjectId, ref: 'User' },
    visitorKey: { type: String, required: true },
    dayKey: { type: String, required: true },
    city: { type: String, default: null, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

serviceViewSchema.index(
  { serviceId: 1, visitorKey: 1, dayKey: 1 },
  { unique: true }
);
serviceViewSchema.index({ serviceId: 1, createdAt: -1 });
serviceViewSchema.index({ city: 1, createdAt: -1 });

export default (mongoose.models.ServiceView as mongoose.Model<IServiceView>) ||
  mongoose.model<IServiceView>('ServiceView', serviceViewSchema);
