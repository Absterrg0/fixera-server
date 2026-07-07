import { Schema, model, Document, Types } from "mongoose";
import { STRIPE_CONFIG } from "../services/stripe";

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "completed"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "disputed";

export interface IPaymentRefund {
  amount: number;
  reason?: string;
  refundId?: string;
  refundedAt: Date;
  source: "professional" | "platform" | "mixed";
  notes?: string;
}

export interface IPayment extends Document {
  booking: Types.ObjectId;
  bookingNumber?: string;
  milestoneIndex?: number;
  milestoneTitle?: string;
  customer: Types.ObjectId;
  professional?: Types.ObjectId;
  status: PaymentStatus;
  method?: "card" | "bank_transfer" | "cash";

  currency: string;
  amount: number;
  netAmount?: number;
  vatAmount?: number;
  vatRate?: number;
  totalWithVat?: number;
  reverseCharge?: boolean;
  vatBreakdown?: {
    description: string;
    netAmount: number;
    vatRate: number;
    vatAmount: number;
    totalAmount: number;
    vatCountry?: string;
    vatLabel?: string;
  }[];
  platformCommission?: number;
  professionalPayout?: number;

  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  stripeTransferId?: string;
  stripeDestinationPayment?: string;

  refunds: IPaymentRefund[];

  authorizedAt?: Date;
  capturedAt?: Date;
  transferredAt?: Date;
  refundedAt?: Date;
  canceledAt?: Date;

  invoiceNumber?: string;
  invoiceUrl?: string;
  invoiceUblUrl?: string;
  invoiceGeneratedAt?: Date;
  peppolDispatchStatus?: string;
  peppolDispatchReference?: string;
  peppolDispatchedAt?: Date;
  creditNoteNumber?: string;
  creditNoteUrl?: string;
  creditNoteUblUrl?: string;
  creditNoteGeneratedAt?: Date;
  creditNoteRelatedInvoiceNumber?: string;
  creditNotePeppolDispatchStatus?: string;
  creditNotePeppolDispatchReference?: string;

  metadata?: Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

const PaymentRefundSchema = new Schema<IPaymentRefund>(
  {
    amount: { type: Number, required: true },
    reason: { type: String, maxlength: 500 },
    refundId: { type: String },
    refundedAt: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ["professional", "platform", "mixed"],
      default: "platform",
      required: true,
    },
    notes: { type: String, maxlength: 1000 },
  },
  { _id: false }
);

const SUPPORTED_CURRENCIES = STRIPE_CONFIG.supportedCurrencies.length
  ? STRIPE_CONFIG.supportedCurrencies
  : [STRIPE_CONFIG.defaultCurrency || "EUR"];
const DEFAULT_CURRENCY = SUPPORTED_CURRENCIES.includes(STRIPE_CONFIG.defaultCurrency)
  ? STRIPE_CONFIG.defaultCurrency
  : SUPPORTED_CURRENCIES[0];

const PaymentSchema = new Schema<IPayment>(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    bookingNumber: { type: String },
    milestoneIndex: { type: Number },
    milestoneTitle: { type: String, maxlength: 200 },
    customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    professional: { type: Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: ["pending", "authorized", "completed", "failed", "refunded", "partially_refunded", "disputed"],
      default: "pending",
      required: true,
    },
    method: {
      type: String,
      enum: ["card", "bank_transfer", "cash"],
    },

    currency: { type: String, enum: SUPPORTED_CURRENCIES, default: DEFAULT_CURRENCY },
    amount: { type: Number, required: true },
    netAmount: { type: Number },
    vatAmount: { type: Number },
    vatRate: { type: Number },
    totalWithVat: { type: Number },
    reverseCharge: { type: Boolean },
    vatBreakdown: [{
      description: { type: String },
      netAmount: { type: Number },
      vatRate: { type: Number },
      vatAmount: { type: Number },
      totalAmount: { type: Number },
      vatCountry: { type: String },
      vatLabel: { type: String },
    }],
    platformCommission: { type: Number },
    professionalPayout: { type: Number },

    stripePaymentIntentId: { type: String },
    stripeChargeId: { type: String },
    stripeTransferId: { type: String },
    stripeDestinationPayment: { type: String },

    refunds: { type: [PaymentRefundSchema], default: [] },

    authorizedAt: { type: Date },
    capturedAt: { type: Date },
    transferredAt: { type: Date },
    refundedAt: { type: Date },
    canceledAt: { type: Date },

    invoiceNumber: { type: String },
    invoiceUrl: { type: String },
    invoiceUblUrl: { type: String },
    invoiceGeneratedAt: { type: Date },
    peppolDispatchStatus: { type: String },
    peppolDispatchReference: { type: String },
    peppolDispatchedAt: { type: Date },
    creditNoteNumber: { type: String },
    creditNoteUrl: { type: String },
    creditNoteUblUrl: { type: String },
    creditNoteGeneratedAt: { type: Date },
    creditNoteRelatedInvoiceNumber: { type: String },
    creditNotePeppolDispatchStatus: { type: String },
    creditNotePeppolDispatchReference: { type: String },

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

PaymentSchema.index({ booking: 1, milestoneIndex: 1 }, { unique: true, sparse: true });
// Ensure only one non-milestone payment per booking
PaymentSchema.index(
  { booking: 1 },
  { unique: true, partialFilterExpression: { milestoneIndex: null } }
);
PaymentSchema.index({ status: 1 });
PaymentSchema.index({ customer: 1, status: 1 });
PaymentSchema.index({ professional: 1, status: 1 });
PaymentSchema.index({ bookingNumber: 1 });

const Payment = model<IPayment>("Payment", PaymentSchema);

export default Payment;
