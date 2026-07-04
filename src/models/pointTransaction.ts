import mongoose, { Document, Schema } from 'mongoose';

export type PointTransactionType = 'earn' | 'spend';
export type PointSource = 'referral' | 'booking_completion' | 'redemption' | 'boost' | 'admin-adjustment' | 'expiry' | 'backlink';

export interface IPointTransaction extends Document {
  userId: mongoose.Types.ObjectId;
  type: PointTransactionType;
  source: PointSource;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string;
  relatedBooking?: mongoose.Types.ObjectId;
  relatedReferral?: mongoose.Types.ObjectId;
  expiresAt?: Date;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const pointTransactionSchema = new Schema<IPointTransaction>({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['earn', 'spend'],
    required: true
  },
  source: {
    type: String,
    enum: ['referral', 'booking_completion', 'redemption', 'boost', 'admin-adjustment', 'expiry', 'backlink'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  balanceBefore: {
    type: Number,
    required: true,
    min: 0
  },
  balanceAfter: {
    type: Number,
    required: true,
    min: 0
  },
  description: {
    type: String,
    required: true,
    maxlength: 500
  },
  relatedBooking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: false
  },
  relatedReferral: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Referral',
    required: false
  },
  expiresAt: {
    type: Date,
    required: false
  },
  metadata: {
    type: Schema.Types.Mixed,
    required: false
  }
}, {
  timestamps: true
});

pointTransactionSchema.index({ userId: 1, createdAt: -1 });
pointTransactionSchema.index({ userId: 1, type: 1 });
pointTransactionSchema.index({ expiresAt: 1 }, { sparse: true });
pointTransactionSchema.index({ source: 1 });
pointTransactionSchema.index({ userId: 1, relatedBooking: 1, source: 1 }, { unique: true, sparse: true });

const PointTransaction = mongoose.model<IPointTransaction>('PointTransaction', pointTransactionSchema);

export default PointTransaction;
