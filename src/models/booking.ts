import mongoose, { Schema, model, Document, Types } from "mongoose";
import { getNextSequence } from "../utils/counterSequence";
import { STRIPE_CONFIG } from "../services/stripe";

const SUPPORTED_CURRENCIES = STRIPE_CONFIG.supportedCurrencies.length
  ? STRIPE_CONFIG.supportedCurrencies
  : [STRIPE_CONFIG.defaultCurrency || "EUR"];

export type BookingStatus =
  | 'rfq'           // Request for Quote - Initial state when customer requests
  | 'rfq_accepted'  // Professional accepted the RFQ, working on quotation
  | 'draft_quote'   // Professional-initiated quotation (entry 1.2), no RFQ step
  | 'quoted'        // Professional has provided a quote
  | 'quote_accepted'// Customer accepted the quote
  | 'quote_rejected'// Customer rejected the quote
  | 'payment_pending' // Payment is being processed
  | 'booked'        // Payment successful, booking confirmed
  | 'rescheduling_requested' // Professional proposed a new schedule, awaiting customer response
  | 'in_progress'   // Work has started
  | 'professional_completed' // Professional confirmed completion, awaiting customer confirmation
  | 'completed'     // Work finished and confirmed by customer
  | 'cancelled'     // Booking cancelled by either party
  | 'dispute'       // Issue raised
  | 'refunded';     // Payment refunded

export type ExtraCostType = 'unit_adjustment' | 'condition' | 'option' | 'other';
export type ExtraCostStatus = 'pending' | 'confirmed' | 'disputed';

export type BookingType = 'professional' | 'project';

export interface IRFQAnswer {
  questionId?: string;
  question: string;
  answer: string;
  fieldType?: 'text' | 'number' | 'date' | 'dropdown' | 'checkbox' | 'file';
}

export interface IQuote {
  amount: number;
  currency: string;
  description?: string;
  breakdown?: {
    item: string;
    quantity?: number;
    unitPrice?: number;
    totalPrice: number;
  }[];
  validUntil?: Date;
  termsAndConditions?: string;
  estimatedDuration?: string; // e.g., "2 weeks", "3 days"
  submittedAt: Date;
  submittedBy: Types.ObjectId; // Professional who submitted the quote
}

export interface IQuotationMilestone {
  title: string;
  amount: number;
  description?: string;
  dueCondition: 'on_start' | 'on_milestone_start' | 'on_milestone_completion' | 'custom_date';
  customDueDate?: Date;
  order: number;
  status: 'pending' | 'invoiced' | 'paid' | 'overdue';
}

export interface IBookingMilestone extends IQuotationMilestone {
  workStatus?: 'pending' | 'in_progress' | 'completed';
  stripePaymentIntentId?: string;
  stripeClientSecret?: string;
  startedAt?: Date;
  completedAt?: Date;
  paidAt?: Date;
}

export interface IQuoteMaterial {
  name: string;
  quantity?: number;
  unit?: string;
  description?: string;
}

export interface IQuoteVersion {
  version: number;
  quotationNumber: string;
  scope: string;
  warrantyDuration: { value: number; unit: 'months' | 'years' };
  materialsIncluded: boolean;
  materials?: IQuoteMaterial[];
  description: string;
  pricingLines?: IQuotationPricingLine[];
  totalAmount: number;
  currency: string;
  milestones?: IQuotationMilestone[];
  preparationDuration: { value: number; unit: 'hours' | 'days' };
  executionDuration: { value: number; unit: 'hours' | 'days' };
  bufferDuration?: { value: number; unit: 'hours' | 'days' };
  validUntil: Date;
  createdAt: Date;
  changeNote?: string;
}

export interface IQuotationPricingLine {
  description: string;
  price: number;
  vatRate: number;
  vatCountry?: string;
  vatLabel?: string;
}

export interface IExtraCost {
  type: ExtraCostType;
  name: string;
  justification: string;
  amount: number;
  referenceIndex?: number;
  estimatedUnits?: number;
  actualUnits?: number;
  unitPrice?: number;
}

export interface ICompletionAttestation {
  confirmedAt: Date;
  confirmedBy: Types.ObjectId;
  attachments?: string[];
  notes?: string;
}

export interface IBookingScheduleSnapshot {
  scheduledStartDate?: Date;
  scheduledExecutionEndDate?: Date;
  scheduledBufferStartDate?: Date;
  scheduledBufferEndDate?: Date;
  scheduledBufferUnit?: "hours" | "days";
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  assignedTeamMembers?: Types.ObjectId[];
}

export interface IBooking extends Document {
  _id: Types.ObjectId;
  // Core references
  customer: Types.ObjectId; // Reference to User (customer)
  bookingType: BookingType; // 'professional' or 'project'
  professional?: Types.ObjectId; // Reference to User (professional) - for direct bookings
  project?: Types.ObjectId; // Reference to Project - for project bookings

  // Status and lifecycle
  status: BookingStatus;
  statusBeforeDispute?: BookingStatus;
  statusHistory: {
    status: BookingStatus;
    timestamp: Date;
    updatedBy?: Types.ObjectId;
    note?: string;
  }[];

  // RFQ (Request for Quote) data
  rfqData: {
    serviceType: string; // What service is needed
    description: string; // Detailed description of the work needed
    answers: IRFQAnswer[]; // Answers to project/professional-specific questions
    preferredStartDate?: Date;
    urgency?: 'low' | 'medium' | 'high' | 'urgent';
    budget?: {
      min?: number;
      max?: number;
      currency: string;
    };
    attachments?: string[]; // S3 URLs for uploaded files
    additionalNotes?: string;
  };

  // Quote from professional (legacy simple quote)
  quote?: IQuote;

  // New quotation system
  quotationNumber?: string;
  quoteVersions: IQuoteVersion[];
  currentQuoteVersion?: number;
  rfqResponse?: { action: 'accepted' | 'rejected'; respondedAt: Date; rejectionReason?: string };
  rfqDeadline?: Date;
  rfqRemindersSent: number;
  lastReminderSentAt?: Date;
  customerRejectionReason?: string;
  milestonePayments?: IBookingMilestone[];
  selectedSubprojectIndex?: number;
  selectedExtraOptions?: { extraOptionId: string; bookedPrice: number }[];
  vatDecision?: {
    action: 'standard_rate' | 'reduced_rate' | 'rfq';
    country: string;
    standardRate: number;
    appliedRate: number;
    reducedRate?: number;
    reverseCharge?: boolean;
    explanation?: string;
    matchedRuleText?: string;
    ruleGroup?: string;
    answers?: { fieldName: string; value: any }[];
  };

  // Booking location (customer's location from their profile)
  location: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
    address?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };

  // Payment information
  payment?: {
    // Core payment info
    amount: number;
    milestoneIndex?: number;
    currency: string;
    method?: 'card' | 'bank_transfer' | 'cash';
    status: 'pending' | 'authorized' | 'completed' | 'failed' | 'refunded' | 'partially_refunded' | 'disputed';

    // Stripe Payment Intent fields
    stripePaymentIntentId?: string;
    stripeClientSecret?: string;
    stripeChargeId?: string;
    stripeTransferId?: string;
    stripeDestinationPayment?: string;
    transferCurrency?: string;
    transferAmount?: number;

    // Financial breakdown
    stripeFeeAmount?: number;
    platformCommission?: number;
    professionalPayout?: number;
    netAmount?: number;
    vatAmount?: number;
    vatRate?: number;
    totalWithVat?: number;
    reverseCharge?: boolean;

    // Multi-currency support
    originalCurrency?: string;
    fxRate?: number;
    fxProvider?: 'stripe' | 'fixera';

    // Payment timeline
    authorizedAt?: Date;
    capturedAt?: Date;
    transferredAt?: Date;
    paidAt?: Date;
    refundedAt?: Date;
    disputeOpenedAt?: Date;

    // Refund
    refundAmount?: number;
    refundReason?: string;
    refundSource?: 'professional' | 'platform' | 'mixed';
    refundNotes?: string;
    disputeId?: string;
    disputeReason?: string;
    disputeAmountPending?: number;
    disputeStatus?: string;

    // Extra cost payment (separate payment intent for positive extra costs)
    extraCostStripePaymentIntentId?: string;
    extraCostClientSecret?: string;
    extraCostAmount?: number;

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

    // Auto-discount breakdown
    discount?: {
      loyaltyTier: string;
      loyaltyPercentage: number;
      loyaltyAmount: number;
      repeatBuyerPercentage: number;
      repeatBuyerAmount: number;
      pointsRedeemed: number;
      pointsDiscountAmount: number;
      codeDiscountAmount?: number;
      codeId?: mongoose.Types.ObjectId;
      codeLabel?: string;
      totalDiscount: number;
      originalAmount: number;
    };
  };

  // Scheduling
  scheduledStartDate?: Date;
  scheduledExecutionEndDate?: Date;
  scheduledBufferStartDate?: Date;
  scheduledBufferEndDate?: Date;
  scheduledBufferUnit?: "hours" | "days";
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  actualStartDate?: Date;
  actualEndDate?: Date;
  rescheduleRequest?: {
    status: 'pending' | 'accepted' | 'declined';
    requestedBy: Types.ObjectId;
    requestedAt: Date;
    reason: string;
    description?: string;
    note?: string;
    previousSchedule?: IBookingScheduleSnapshot;
    proposedSchedule: IBookingScheduleSnapshot;
    respondedAt?: Date;
    respondedBy?: Types.ObjectId;
    responseNote?: string;
  };
  rescheduleHistory?: {
    requestedBy: Types.ObjectId;
    requestedAt: Date;
    reason: string;
    note?: string;
    previousSchedule?: IBookingScheduleSnapshot;
    proposedSchedule: IBookingScheduleSnapshot;
    status: 'accepted' | 'declined' | 'auto_cancelled';
    respondedAt?: Date;
    respondedBy?: Types.ObjectId;
    responseNote?: string;
  }[];
  warrantyCoverage?: {
    duration: { value: number; unit: 'months' | 'years' };
    startsAt?: Date;
    endsAt?: Date;
    source?: 'quote' | 'project_subproject';
  };

  // Team members (for project bookings)
  assignedTeamMembers?: Types.ObjectId[]; // References to User (employees)

  // Per-resource execution plan (professional-managed planning board)
  resourcePlan?: {
    resourceId: Types.ObjectId;
    days: Date[];
  }[];

  customerBlocks?: {
    dates?: { date: Date; reason?: string }[];
    windows?: {
      date: Date;
      startTime: string;
      endTime: string;
      reason?: string;
    }[];
  };

  // Communication
  messages?: {
    senderId: Types.ObjectId;
    message: string;
    timestamp: Date;
    attachments?: string[];
  }[];

  // Reviews and ratings (after completion)
  customerReview?: {
    communicationLevel: number; // 1-5
    valueOfDelivery: number; // 1-5
    qualityOfService: number; // 1-5
    comment?: string;
    images?: string[]; // Up to 2 S3 image URLs
    reviewedAt: Date;
    reply?: {
      comment: string;
      repliedAt: Date;
    };
    isHidden?: boolean;
    hiddenBy?: Types.ObjectId;
    hiddenAt?: Date;
    unhiddenBy?: Types.ObjectId;
    unhiddenAt?: Date;
  };
  professionalReview?: {
    rating: number; // 1-5
    comment?: string;
    reviewedAt: Date;
  };

  // Cancellation
  cancellation?: {
    cancelledBy: Types.ObjectId; // User who cancelled
    reason: string;
    cancelledAt: Date;
    refundAmount?: number;
  };

  // No-show (e.g. customer cancels citing professional no-show). Drives the No-show KPI.
  noShow?: {
    markedAt: Date;
    markedBy?: Types.ObjectId;
    reason?: string;
    source?: string;
  };

  // Professional completion attestation
  completionAttestation?: ICompletionAttestation;

  // Extra costs declared by professional at completion
  extraCosts?: IExtraCost[];
  extraCostStatus?: ExtraCostStatus;
  extraCostTotal?: number;

  // Dispute
  dispute?: {
    raisedBy: Types.ObjectId;
    reason: string;
    description: string;
    raisedAt: Date;
    resolvedAt?: Date;
    resolution?: string;
    resolvedBy?: Types.ObjectId; // Admin who resolved
    adminAdjustedAmount?: number;
    slaDeadline?: Date;
    slaBreachNotifiedAt?: Date;
    type?: 'extra_costs' | 'reschedule' | 'completion_request' | 'warranty_claim' | 'warranty_resolve' | 'refund_request' | 'in_progress';
    attachments?: string[];
    resolutionAttachments?: string[];
  };

  // Post-booking questions (filled after booking is confirmed)
  postBookingData?: {
    questionId: string;
    question: string;
    answer: string;
  }[];

  // Metadata
  bookingNumber: string; // Unique booking reference number (e.g., BK-2024-001234)
  notes?: string; // Internal notes
  professionalCompletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TIME_24H_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const BookingSchema = new Schema({
  // Core references
  customer: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Customer reference is required'],
    index: true
  },
  bookingType: {
    type: String,
    enum: ['professional', 'project'],
    required: [true, 'Booking type is required']
  },
  professional: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: function(this: IBooking) {
      return this.bookingType === 'professional';
    },
    index: true
  },
  project: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    required: function(this: IBooking) {
      return this.bookingType === 'project';
    },
    index: true
  },

  // Status and lifecycle
  status: {
    type: String,
    enum: ['rfq', 'rfq_accepted', 'draft_quote', 'quoted', 'quote_accepted', 'quote_rejected', 'payment_pending', 'booked', 'rescheduling_requested', 'in_progress', 'professional_completed', 'completed', 'cancelled', 'dispute', 'refunded'],
    default: 'rfq',
    required: true,
    index: true
  },
  statusBeforeDispute: {
    type: String,
    enum: ['rfq', 'rfq_accepted', 'draft_quote', 'quoted', 'quote_accepted', 'quote_rejected', 'payment_pending', 'booked', 'rescheduling_requested', 'in_progress', 'professional_completed', 'completed', 'cancelled', 'dispute', 'refunded'],
  },
  statusHistory: [{
    status: {
      type: String,
      enum: ['rfq', 'rfq_accepted', 'draft_quote', 'quoted', 'quote_accepted', 'quote_rejected', 'payment_pending', 'booked', 'rescheduling_requested', 'in_progress', 'professional_completed', 'completed', 'cancelled', 'dispute', 'refunded'],
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    note: {
      type: String,
      maxlength: 500
    }
  }],

  // RFQ data
  rfqData: {
    serviceType: {
      type: String,
      required: [true, 'Service type is required'],
      trim: true,
      maxlength: 200
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      maxlength: 2000
    },
    answers: [{
      questionId: { type: String },
      question: {
        type: String,
        required: true,
        maxlength: 500
      },
      answer: {
        type: String,
        required: true,
        maxlength: 1000
      },
      fieldType: {
        type: String,
        enum: ['text', 'number', 'date', 'dropdown', 'checkbox', 'file']
      }
    }],
    preferredStartDate: {
      type: Date
    },
    urgency: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium'
    },
    budget: {
      min: { type: Number, min: 0 },
      max: { type: Number, min: 0 },
      currency: {
        type: String,
        default: 'EUR',
        enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD']
      }
    },
    attachments: [{
      type: String // S3 URLs
    }],
    additionalNotes: { type: String, trim: true, maxlength: 2000 },
  },

  // Quote
  quote: {
    amount: {
      type: Number,
      required: function(this: IBooking) {
        // Legacy quote.amount is not required when using the new quoteVersions system
        if (this.quoteVersions && this.quoteVersions.length > 0) return false;
        const noQuoteStatuses = ['rfq', 'rfq_accepted', 'draft_quote', 'cancelled'];
        return !noQuoteStatuses.includes(this.status);
      },
      min: 0
    },
    currency: {
      type: String,
      enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'],
      default: 'EUR'
    },
    description: {
      type: String,
      maxlength: 1000
    },
    breakdown: [{
      item: { type: String, required: true, maxlength: 200 },
      quantity: { type: Number, min: 0 },
      unitPrice: { type: Number, min: 0 },
      totalPrice: { type: Number, required: true, min: 0 }
    }],
    validUntil: {
      type: Date
    },
    termsAndConditions: {
      type: String,
      maxlength: 2000
    },
    estimatedDuration: {
      type: String,
      maxlength: 100
    },
    submittedAt: {
      type: Date
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  },

  // New quotation system
  quotationNumber: {
    type: String
  },
  quoteVersions: [{
    version: { type: Number, required: true },
    quotationNumber: { type: String, required: true },
    scope: { type: String, required: true, minlength: 10, maxlength: 100 },
    warrantyDuration: {
      value: { type: Number, required: true, min: 0 },
      unit: { type: String, enum: ['months', 'years'], required: true }
    },
    materialsIncluded: { type: Boolean, default: false },
    materials: [{
      name: { type: String, required: true, maxlength: 200 },
      quantity: { type: Number, min: 0 },
      unit: { type: String, maxlength: 50 },
      description: { type: String, maxlength: 500 }
    }],
    description: { type: String, required: true, maxlength: 5000 },
    pricingLines: [{
      description: { type: String, required: true, maxlength: 500 },
      price: { type: Number, required: true, min: 0 },
      vatRate: { type: Number, required: true, min: 0, max: 100 },
      vatCountry: { type: String, maxlength: 50 },
      vatLabel: { type: String, maxlength: 200 },
    }],
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'], default: 'EUR' },
    milestones: [{
      title: { type: String, required: true, maxlength: 200 },
      amount: { type: Number, required: true, min: 0 },
      description: { type: String, maxlength: 500 },
      dueCondition: {
        type: String,
        enum: ['on_start', 'on_milestone_start', 'on_milestone_completion', 'custom_date'],
        required: true
      },
      customDueDate: { type: Date },
      order: { type: Number, required: true },
      status: { type: String, enum: ['pending', 'invoiced', 'paid', 'overdue'], default: 'pending' },
    }],
    preparationDuration: {
      value: { type: Number, required: true, min: 0 },
      unit: { type: String, enum: ['hours', 'days'], required: true }
    },
    executionDuration: {
      value: { type: Number, required: true, min: 0 },
      unit: { type: String, enum: ['hours', 'days'], required: true }
    },
    bufferDuration: {
      value: { type: Number, min: 0 },
      unit: { type: String, enum: ['hours', 'days'] }
    },
    validUntil: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
    changeNote: { type: String, maxlength: 500 }
  }],
  currentQuoteVersion: { type: Number },
  rfqResponse: {
    action: { type: String, enum: ['accepted', 'rejected'] },
    respondedAt: { type: Date },
    rejectionReason: { type: String, maxlength: 500 }
  },
  rfqDeadline: { type: Date },
  rfqRemindersSent: { type: Number, default: 0 },
  lastReminderSentAt: { type: Date },
  customerRejectionReason: { type: String, maxlength: 1000 },
  milestonePayments: [{
    title: { type: String, required: true, maxlength: 200 },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, maxlength: 500 },
    dueCondition: {
      type: String,
      enum: ['on_start', 'on_milestone_start', 'on_milestone_completion', 'custom_date'],
      required: true
    },
    customDueDate: { type: Date },
    order: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'invoiced', 'paid', 'overdue'], default: 'pending' },
    workStatus: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
    stripePaymentIntentId: { type: String },
    stripeClientSecret: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
    paidAt: { type: Date }
  }],
  selectedSubprojectIndex: {
    type: Number,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'selectedSubprojectIndex must be an integer',
    },
  },
  selectedExtraOptions: [{
    extraOptionId: { type: String, required: true },
    bookedPrice: { type: Number, required: true, min: 0 },
  }],
  vatDecision: {
    action: { type: String, enum: ['standard_rate', 'reduced_rate', 'rfq'] },
    country: { type: String },
    standardRate: { type: Number, min: 0, max: 100 },
    appliedRate: { type: Number, min: 0, max: 100 },
    reducedRate: { type: Number, min: 0, max: 100 },
    reverseCharge: { type: Boolean },
    explanation: { type: String, maxlength: 1000 },
    matchedRuleText: { type: String, maxlength: 1000 },
    ruleGroup: { type: String },
    answers: [{
      fieldName: { type: String, required: true },
      value: { type: Schema.Types.Mixed },
    }],
  },

  // Location
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: [true, 'Location coordinates are required'],
      validate: {
        validator: function(v: number[]) {
          return v.length === 2 &&
                 v[0] >= -180 && v[0] <= 180 && // longitude
                 v[1] >= -90 && v[1] <= 90;     // latitude
        },
        message: 'Invalid coordinates format. Expected [longitude, latitude]'
      }
    },
    address: { type: String, maxlength: 200 },
    city: { type: String, maxlength: 100 },
    country: { type: String, maxlength: 100 },
    postalCode: { type: String, maxlength: 20 }
  },

  // Payment
  payment: {
    // Core payment info
    amount: { type: Number, min: 0 },
    milestoneIndex: { type: Number },
    currency: {
      type: String,
      enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'],
      default: 'EUR'
    },
    method: {
      type: String,
      enum: ['card', 'bank_transfer', 'cash']
    },
    status: {
      type: String,
      enum: ['pending', 'authorized', 'completed', 'failed', 'refunded', 'partially_refunded', 'disputed'],
      default: 'pending'
    },

    // Stripe Payment Intent fields
    stripePaymentIntentId: { type: String },
    stripeClientSecret: { type: String },
    stripeChargeId: { type: String },

    // Stripe Connect transfer fields
    stripeTransferId: { type: String },
    stripeDestinationPayment: { type: String },
    transferCurrency: { type: String, enum: SUPPORTED_CURRENCIES },
    transferAmount: { type: Number, min: [0, 'transferAmount cannot be negative'] },

    // Financial breakdown
    stripeFeeAmount: { type: Number },
    platformCommission: { type: Number, default: 0 },
    professionalPayout: { type: Number },
    netAmount: { type: Number },
    vatAmount: { type: Number },
    vatRate: { type: Number },
    totalWithVat: { type: Number },
    reverseCharge: { type: Boolean },

    // Multi-currency support
    originalCurrency: { type: String },
    fxRate: { type: Number },
    fxProvider: {
      type: String,
      enum: ['stripe', 'fixera']
    },

    // Payment timeline
    authorizedAt: { type: Date },
    capturedAt: { type: Date },
    transferredAt: { type: Date },
    paidAt: { type: Date },
    refundedAt: { type: Date },
    disputeOpenedAt: { type: Date },

    // Refund metadata
    refundAmount: { type: Number, min: 0 },
    refundReason: { type: String, maxlength: 500 },
    refundSource: {
      type: String,
      enum: ['professional', 'platform', 'mixed']
    },
    refundNotes: { type: String, maxlength: 1000 },
    disputeId: { type: String },
    disputeReason: { type: String, maxlength: 500 },
    disputeAmountPending: { type: Number },
    disputeStatus: { type: String },

    // Extra cost payment (separate payment intent for positive extra costs)
    extraCostStripePaymentIntentId: { type: String },
    extraCostClientSecret: { type: String },
    extraCostAmount: { type: Number },

    // Invoice
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

    // Auto-discount breakdown
    discount: {
      loyaltyTier: { type: String },
      loyaltyPercentage: { type: Number, default: 0 },
      loyaltyAmount: { type: Number, default: 0 },
      repeatBuyerPercentage: { type: Number, default: 0 },
      repeatBuyerAmount: { type: Number, default: 0 },
      pointsRedeemed: { type: Number, default: 0 },
      pointsDiscountAmount: { type: Number, default: 0 },
      codeDiscountAmount: { type: Number, default: 0 },
      codeId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCode' },
      codeLabel: { type: String },
      totalDiscount: { type: Number, default: 0 },
      originalAmount: { type: Number, default: 0 },
    }
  },

  // Scheduling
  scheduledStartDate: { type: Date },
  scheduledExecutionEndDate: { type: Date },
  scheduledBufferStartDate: { type: Date },
  scheduledBufferEndDate: { type: Date },
  scheduledBufferUnit: { type: String, enum: ["hours", "days"] },
  scheduledStartTime: {
    type: String,
    trim: true,
    match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
  },
  scheduledEndTime: {
    type: String,
    trim: true,
    match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
  },
  actualStartDate: { type: Date },
  actualEndDate: { type: Date },
  rescheduleRequest: {
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined'],
    },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    requestedAt: { type: Date },
    reason: { type: String, trim: true, maxlength: 500 },
    description: { type: String, trim: true, maxlength: 2000 },
    note: { type: String, trim: true, maxlength: 2000 },
    previousSchedule: {
      scheduledStartDate: { type: Date },
      scheduledExecutionEndDate: { type: Date },
      scheduledBufferStartDate: { type: Date },
      scheduledBufferEndDate: { type: Date },
      scheduledBufferUnit: { type: String, enum: ['hours', 'days'] },
      scheduledStartTime: { type: String, match: TIME_24H_REGEX },
      scheduledEndTime: { type: String, match: TIME_24H_REGEX },
      assignedTeamMembers: [{
        type: Schema.Types.ObjectId,
        ref: 'User',
      }],
    },
    proposedSchedule: {
      scheduledStartDate: { type: Date },
      scheduledExecutionEndDate: { type: Date },
      scheduledBufferStartDate: { type: Date },
      scheduledBufferEndDate: { type: Date },
      scheduledBufferUnit: { type: String, enum: ['hours', 'days'] },
      scheduledStartTime: { type: String, match: TIME_24H_REGEX },
      scheduledEndTime: { type: String, match: TIME_24H_REGEX },
      assignedTeamMembers: [{
        type: Schema.Types.ObjectId,
        ref: 'User',
      }],
    },
    respondedAt: { type: Date },
    respondedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    responseNote: { type: String, trim: true, maxlength: 2000 },
  },
  rescheduleHistory: [{
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    note: { type: String, trim: true, maxlength: 2000 },
    previousSchedule: {
      scheduledStartDate: { type: Date },
      scheduledExecutionEndDate: { type: Date },
      scheduledBufferStartDate: { type: Date },
      scheduledBufferEndDate: { type: Date },
      scheduledBufferUnit: { type: String, enum: ['hours', 'days'] },
      scheduledStartTime: { type: String, match: TIME_24H_REGEX },
      scheduledEndTime: { type: String, match: TIME_24H_REGEX },
      assignedTeamMembers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    },
    proposedSchedule: {
      scheduledStartDate: { type: Date },
      scheduledExecutionEndDate: { type: Date },
      scheduledBufferStartDate: { type: Date },
      scheduledBufferEndDate: { type: Date },
      scheduledBufferUnit: { type: String, enum: ['hours', 'days'] },
      scheduledStartTime: { type: String, match: TIME_24H_REGEX },
      scheduledEndTime: { type: String, match: TIME_24H_REGEX },
      assignedTeamMembers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    },
    status: { type: String, enum: ['accepted', 'declined', 'auto_cancelled'], required: true },
    respondedAt: {
      type: Date,
      required: function (this: any) {
        return this.status === 'accepted' || this.status === 'declined';
      },
    },
    respondedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: function (this: any) {
        return this.status === 'accepted' || this.status === 'declined';
      },
    },
    responseNote: { type: String, trim: true, maxlength: 2000 },
  }],
  warrantyCoverage: {
    duration: {
      value: { type: Number, min: 0 },
      unit: { type: String, enum: ['months', 'years'] },
    },
    startsAt: { type: Date },
    endsAt: { type: Date },
    source: { type: String, enum: ['quote', 'project_subproject'] }
  },

  // Team members
  assignedTeamMembers: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],

  // Per-resource execution plan (professional-managed planning board)
  resourcePlan: {
    type: [{
      resourceId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },
      days: { type: [Date], default: [] }
    }],
    validate: {
      validator: function (plan: Array<{ days?: Date[] }>) {
        if (!Array.isArray(plan)) return true;
        return plan.every((item) =>
          !item?.days ||
          (Array.isArray(item.days) && item.days.every((d) => d instanceof Date && !Number.isNaN(d.getTime())))
        );
      },
      message: 'resourcePlan days must be valid dates',
    },
  },

  // Messages
  messages: [{
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    message: {
      type: String,
      required: true,
      maxlength: 2000
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true
    },
    attachments: [{ type: String }]
  }],

  // Reviews
  customerReview: {
    communicationLevel: {
      type: Number,
      min: 1,
      max: 5
    },
    valueOfDelivery: {
      type: Number,
      min: 1,
      max: 5
    },
    qualityOfService: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      maxlength: 1000
    },
    images: [{
      type: String
    }],
    reviewedAt: {
      type: Date,
      default: Date.now
    },
    reply: {
      comment: {
        type: String,
        maxlength: 1000
      },
      repliedAt: {
        type: Date
      }
    },
    isHidden: {
      type: Boolean,
      default: false
    },
    hiddenBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    hiddenAt: {
      type: Date
    },
    unhiddenBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    unhiddenAt: {
      type: Date
    }
  },
  professionalReview: {
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      maxlength: 1000
    },
    reviewedAt: {
      type: Date,
      default: Date.now
    }
  },

  // Cancellation
  cancellation: {
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: {
      type: String,
      maxlength: 500
    },
    cancelledAt: {
      type: Date,
      default: Date.now
    },
    refundAmount: {
      type: Number,
      min: 0
    }
  },

  // No-show (drives the No-show KPI)
  noShow: {
    markedAt: { type: Date },
    markedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, maxlength: 1000 },
    source: { type: String, maxlength: 100 }
  },

  // Professional completion attestation
  completionAttestation: {
    confirmedAt: { type: Date },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    attachments: [{ type: String }],
    notes: { type: String, maxlength: 2000 }
  },

  // Extra costs declared by professional at completion
  extraCosts: [{
    type: {
      type: String,
      enum: ['unit_adjustment', 'condition', 'option', 'other'],
      required: true
    },
    name: { type: String, required: true, maxlength: 200 },
    justification: { type: String, required: true, maxlength: 1000 },
    amount: { type: Number, required: true },
    referenceIndex: { type: Number },
    estimatedUnits: { type: Number },
    actualUnits: { type: Number },
    unitPrice: { type: Number }
  }],
  extraCostStatus: {
    type: String,
    enum: ['pending', 'confirmed', 'disputed']
  },
  extraCostTotal: { type: Number },

  // Dispute
  dispute: {
    raisedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: {
      type: String,
      maxlength: 200
    },
    description: {
      type: String,
      maxlength: 2000
    },
    raisedAt: {
      type: Date,
      default: Date.now
    },
    resolvedAt: { type: Date },
    resolution: { type: String, maxlength: 2000 },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    adminAdjustedAmount: { type: Number },
    slaDeadline: { type: Date },
    slaBreachNotifiedAt: { type: Date },
    type: {
      type: String,
      enum: ['extra_costs', 'reschedule', 'completion_request', 'warranty_claim', 'warranty_resolve', 'refund_request', 'in_progress'],
      default: 'extra_costs',
    },
    attachments: [{ type: String }],
    resolutionAttachments: [{ type: String }],
  },

  // Post-booking data
  postBookingData: [{
    questionId: { type: String, required: true },
    question: { type: String, required: true, maxlength: 500 },
    answer: { type: String, required: true, maxlength: 1000 }
  }],

  customerBlocks: {
    dates: [{
      date: { type: Date, required: true },
      reason: { type: String, maxlength: 200 }
    }],
    windows: [{
      date: { type: Date, required: true },
      startTime: {
        type: String,
        required: true,
        trim: true,
        match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
      },
      endTime: {
        type: String,
        required: true,
        trim: true,
        match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
      },
      reason: { type: String, maxlength: 200 }
    }]
  },

  // Metadata
  bookingNumber: {
    type: String
  },
  notes: {
    type: String,
    maxlength: 2000
  },
  professionalCompletedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
BookingSchema.index({ customer: 1, status: 1 });
BookingSchema.index({ project: 1, status: 1 });
BookingSchema.index({ project: 1, status: 1, scheduledStartDate: 1 });
BookingSchema.index({ bookingType: 1, status: 1 });
BookingSchema.index({ 'location.coordinates': '2dsphere' }); // Geospatial queries
BookingSchema.index({ createdAt: -1 }); // Sort by creation date
BookingSchema.index({ scheduledStartDate: 1 }); // Upcoming bookings
BookingSchema.index({ scheduledBufferEndDate: 1 });
BookingSchema.index({ assignedTeamMembers: 1 });
// Compound index for schedule engine blocked data queries
BookingSchema.index({ assignedTeamMembers: 1, status: 1, scheduledStartDate: 1 });
BookingSchema.index({ professional: 1, status: 1, scheduledStartDate: 1 });
BookingSchema.index({ professional: 1, status: 1, 'customerReview.communicationLevel': 1 }); // Reviews query
BookingSchema.index({ 'customerReview.isHidden': 1, 'customerReview.hiddenAt': -1 }); // Hidden reviews admin query
BookingSchema.index({ 'payment.status': 1 }); // Payment tracking
BookingSchema.index({ status: 1, rfqDeadline: 1 }); // RFQ deadline check
BookingSchema.index({ status: 1, 'dispute.slaDeadline': 1, 'dispute.slaBreachNotifiedAt': 1 });
BookingSchema.index(
  { quotationNumber: 1 },
  { unique: true, partialFilterExpression: { quotationNumber: { $exists: true, $type: 'string' } } }
); // Quotation lookup
BookingSchema.index({ bookingNumber: 1 }, { unique: true }); // Quick lookup by booking number
BookingSchema.index({ 'warrantyCoverage.endsAt': 1 });
BookingSchema.index({ professional: 1, createdAt: 1 });
BookingSchema.index({ professional: 1, status: 1, createdAt: 1 });
BookingSchema.index({ professional: 1, 'payment.status': 1, createdAt: 1 });
BookingSchema.index({ professional: 1, project: 1, createdAt: 1 });
// KPI dashboard indexes
BookingSchema.index({ createdAt: 1, 'location.city': 1, status: 1 });
BookingSchema.index({ 'dispute.raisedAt': 1 }, { sparse: true });
BookingSchema.index({ 'noShow.markedAt': 1 }, { sparse: true });

// Helper to parse HH:mm to minutes for comparison
const parseTimeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

const getBookingNumberCandidate = async (): Promise<string> => {
  const year = new Date().getFullYear();
  return getNextSequence(`bookingNumber-${year}`, `BK-${year}`);
};

const getQuotationNumberCandidate = async (): Promise<string> => {
  const year = new Date().getFullYear();
  return getNextSequence(`quotationNumber-${year}`, `QT-${year}`);
};

// Pre-save middleware to generate booking number and validate scheduling fields
BookingSchema.pre('validate', function(next) {
  const dur = this.warrantyCoverage?.duration;
  if (dur) {
    const hasValue = dur.value != null;
    const hasUnit = dur.unit != null;
    if (hasValue !== hasUnit) {
      return next(new Error(
        'warrantyCoverage.duration requires both value and unit when either is set'
      ));
    }
  }
  next();
});

BookingSchema.pre('save', async function(next) {
  // Cross-field validation for scheduling times
  if (this.scheduledStartTime && this.scheduledEndTime) {
    const startMinutes = parseTimeToMinutes(this.scheduledStartTime);
    const endMinutes = parseTimeToMinutes(this.scheduledEndTime);
    if (startMinutes >= endMinutes) {
      return next(new Error('scheduledStartTime must be before scheduledEndTime'));
    }
  }

  // Cross-field validation for buffer dates
  // Allow equal dates (represents 0 buffer duration when no buffer is configured)
  if (this.scheduledBufferStartDate && this.scheduledBufferEndDate) {
    if (this.scheduledBufferStartDate > this.scheduledBufferEndDate) {
      return next(new Error('scheduledBufferStartDate must be at or before scheduledBufferEndDate'));
    }
  }

  // Buffer alignment validation with execution dates
  // Buffer should start at or after execution end
  if (this.scheduledBufferStartDate && this.scheduledExecutionEndDate) {
    if (this.scheduledBufferStartDate < this.scheduledExecutionEndDate) {
      return next(new Error('scheduledBufferStartDate must be at or after scheduledExecutionEndDate'));
    }
  }

  // Execution end should be at or before buffer end (if both exist)
  if (this.scheduledExecutionEndDate && this.scheduledBufferEndDate) {
    if (this.scheduledExecutionEndDate > this.scheduledBufferEndDate) {
      return next(new Error('scheduledExecutionEndDate must be at or before scheduledBufferEndDate'));
    }
  }

  // Scheduled start date should be before execution end date
  if (this.scheduledStartDate && this.scheduledExecutionEndDate) {
    if (this.scheduledStartDate >= this.scheduledExecutionEndDate) {
      return next(new Error('scheduledStartDate must be before scheduledExecutionEndDate'));
    }
  }

  // Validate customerBlocks time windows
  if (this.customerBlocks?.windows) {
    for (const window of this.customerBlocks.windows) {
      if (window.startTime && window.endTime) {
        const startMinutes = parseTimeToMinutes(window.startTime);
        const endMinutes = parseTimeToMinutes(window.endTime);
        if (startMinutes >= endMinutes) {
          return next(new Error('customerBlocks window startTime must be before endTime'));
        }
      }
    }
  }

  if (this.isNew && !this.bookingNumber) {
    this.bookingNumber = await getBookingNumberCandidate();
  }

  if (!this.quotationNumber && this.quoteVersions && this.quoteVersions.length > 0) {
    this.quotationNumber = await getQuotationNumberCandidate();
  }

  // Initialize status history if empty
  if (this.isNew && this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status,
      timestamp: new Date(),
      note: 'Booking created'
    });
  }

  next();
});

// Method to update status with history tracking
BookingSchema.methods.updateStatus = function(
  newStatus: BookingStatus,
  updatedBy?: Types.ObjectId,
  note?: string
) {
  this.status = newStatus;
  this.statusHistory.push({
    status: newStatus,
    timestamp: new Date(),
    updatedBy,
    note
  });
  return this.save();
};

const Booking = model<IBooking>('Booking', BookingSchema);

export default Booking;
