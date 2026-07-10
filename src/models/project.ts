import { Schema, model, Document, Types } from "mongoose";

// Interfaces for nested schemas
export interface ICertification {
  name: string;
  fileUrl: string;
  uploadedAt: Date;
  isRequired: boolean;
}

export interface IDistance {
  address: string;
  countryCode?: string; // ISO 3166-1 alpha-2 country code (e.g., "US", "NL", "DE")
  useCompanyAddress: boolean;
  maxKmRange: number;
  noBorders: boolean;
  location?: {
    type: "Point";
    coordinates: [number, number];
  };
}

export interface IIntakeMeeting {
  enabled: boolean;
  resources: string[]; // Team member IDs
}

export interface IRenovationPlanning {
  fixeraManaged: boolean;
  resources: string[];
}

export interface IMedia {
  images: string[];
  video?: string;
}

export interface IPricing {
  type: "fixed" | "unit" | "rfq";
  amount?: number;
  priceRange?: { min: number; max: number };
  minOrderQuantity?: number; // Unit pricing: minimum order quantity
}

export interface IIncludedItem {
  name: string;
  description?: string;
  isCustom: boolean;
}

export interface IMaterial {
  name: string;
  quantity?: string;
  unit?: string;
  description?: string;
}

export interface IExecutionDuration {
  value: number;
  unit: "hours" | "days";
  range?: { min: number; max: number };
}

export interface IPreparationDuration {
  value: number;
  unit: "hours" | "days";
}

export interface IBuffer {
  value: number;
  unit: "hours" | "days";
}

export interface IIntakeDuration {
  value: number;
  unit: "hours" | "days";
  buffer?: number;
}

export interface IProfessionalInputValue {
  fieldName: string; // e.g., "buildingType", "range_m2_living_area"
  value: any; // Can be string, number, or {min: number, max: number} for ranges
}

export interface ISubproject {
  name: string;
  description: string;
  projectType: string[];
  customProjectType?: string; // For "Other" option
  professionalInputs: IProfessionalInputValue[]; // Dynamic fields filled by professional
  pricing: IPricing;
  included: IIncludedItem[];
  materialsIncluded: boolean;
  materials?: IMaterial[]; // List of materials if materialsIncluded is true
  preparationDuration: IPreparationDuration;
  executionDuration: IExecutionDuration;
  buffer?: IBuffer;
  intakeDuration?: IIntakeDuration;
  warrantyPeriod: {
    value: number;
    unit: "months" | "years";
  };
}

export interface IRepeatBuyerDiscount {
  enabled: boolean;
  percentage: number; // 1-20% discount for returning customers
  minPreviousBookings: number; // minimum completed bookings to qualify
  maxDiscountAmount?: number; // optional cap per booking
}

export interface IExtraOption {
  name: string;
  description?: string;
  price: number;
  isCustom: boolean;
}

export interface ITermCondition {
  name: string;
  description: string;
  type?: "condition" | "warning";
  additionalCost?: number;
  isCustom: boolean;
}

export interface IFAQ {
  question: string;
  answer: string;
  isGenerated: boolean;
}

export interface IRFQQuestion {
  question: string;
  type: "text" | "multiple_choice" | "attachment";
  options?: string[];
  isRequired: boolean;
  professionalAttachments?: string[]; // URLs of files uploaded by professional
}

export interface IPostBookingQuestion {
  question: string;
  type: "text" | "multiple_choice" | "attachment";
  options?: string[];
  isRequired: boolean;
  professionalAttachments?: string[]; // URLs of files uploaded by professional
}

export interface IChangeEntry {
  field: string;
  category: "A" | "B" | "none";
  oldValue: any;
  newValue: any;
  moderationResult?: {
    passed: boolean;
    reasons?: string[];
  };
}

export interface IQualityCheck {
  category: string;
  status: "passed" | "failed" | "warning";
  message: string;
  checkedAt: Date;
}

export interface IServiceSelection {
  category: string;
  service: string;
  areaOfWork?: string;
}

export interface IProject extends Document {
  // Time mode for scheduling
  timeMode?: "hours" | "days" | "mixed";

  // Project-level preparation, execution and buffer durations
  preparationDuration?: {
    value: number;
    unit: "hours" | "days";
  };
  executionDuration?: IExecutionDuration;
  bufferDuration?: IBuffer;

  // Resource requirements for scheduling
  minResources?: number;
  minOverlapPercentage?: number;

  // Step 1: Basic Info
  professionalId: Types.ObjectId | string;
  category: string; // Kept for backwards compatibility (primary category)
  service: string; // Kept for backwards compatibility (primary service)
  areaOfWork?: string;
  serviceConfigurationId?: string; // Reference to the ServiceConfiguration
  categories?: string[]; // Multiple categories
  services?: IServiceSelection[]; // 3-10 services with category and area
  certifications: ICertification[];
  distance: IDistance;
  intakeMeeting?: IIntakeMeeting;
  renovationPlanning?: IRenovationPlanning;
  resources: string[];
  description: string;
  priceModel: string;
  keywords: string[];
  title: string;
  media: IMedia;

  // Step 2: Subprojects (max 5)
  subprojects: ISubproject[];

  // Repeat-buyer discount (per-project setting for returning customers)
  repeatBuyerDiscount?: IRepeatBuyerDiscount;

  // Step 3: Extra Options
  extraOptions: IExtraOption[];
  termsConditions: ITermCondition[];

  // Step 4: FAQ
  faq: IFAQ[];

  // Step 5: RFQ Questions
  rfqQuestions: IRFQQuestion[];

  // Step 6: Post-Booking Questions
  postBookingQuestions: IPostBookingQuestion[];

  // Step 7: Custom Confirmation
  customConfirmationMessage?: string;

  // Step 8: Review & Status
  // Project lifecycle status
  status: "draft" | "pending" | "rejected" | "published" | "on_hold" | "suspended";
  // Booking lifecycle status (only applicable when project is published and has active bookings)
  bookingStatus?:
  | "rfq"
  | "quoted"
  | "booked"
  | "execution"
  | "completed"
  | "cancelled"
  | "dispute"
  | "warranty";
  qualityChecks: IQualityCheck[];
  adminFeedback?: string;
  submittedAt?: Date;
  approvedAt?: Date;
  approvedBy?: string;

  // Change tracking for smart reapproval
  previousSnapshot?: Record<string, any>;
  pendingChanges?: IChangeEntry[];
  reapprovalType?: "full" | "moderation_failed" | "none";
  isResubmission?: boolean;

  // Auto-save tracking
  autoSaveTimestamp: Date;
  currentStep: number;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

// Certification Schema
const CertificationSchema = new Schema<ICertification>({
  name: { type: String, required: true },
  fileUrl: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  isRequired: { type: Boolean, default: false },
});

// Distance Schema
const DistanceSchema = new Schema<IDistance>({
  address: { type: String, required: true },
  countryCode: {
    type: String,
    validate: {
      validator: (value: string) =>
        !value || /^[A-Z]{2}$/.test(value),
      message: "countryCode must be a valid ISO 3166-1 alpha-2 code (e.g., 'US', 'NL', 'DE')",
    },
  },
  useCompanyAddress: { type: Boolean, default: false },
  maxKmRange: { type: Number, required: true, min: 1, max: 200 },
  noBorders: { type: Boolean, default: false },
  location: {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: {
      type: [Number],
      validate: {
        validator: (value: number[]) => {
          if (!value || (Array.isArray(value) && value.length === 0)) {
            return true;
          }
          if (!Array.isArray(value) || value.length !== 2) {
            return false;
          }
          const [longitude, latitude] = value;
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
            return false;
          }
          if (longitude < -180 || longitude > 180) {
            return false;
          }
          if (latitude < -90 || latitude > 90) {
            return false;
          }
          return true;
        },
        message: "Invalid coordinates: expected [longitude, latitude] with longitude ∈ [-180,180] and latitude ∈ [-90,90]",
      },
    },
  },
});

// Intake Meeting Schema
const IntakeMeetingSchema = new Schema<IIntakeMeeting>({
  enabled: { type: Boolean, default: false },
  resources: [{ type: String }],
});

// Renovation Planning Schema
const RenovationPlanningSchema = new Schema<IRenovationPlanning>({
  fixeraManaged: { type: Boolean, default: false },
  resources: [{ type: String }],
});

// Media Schema
const MediaSchema = new Schema<IMedia>({
  images: [{ type: String }],
  video: { type: String },
});

// Pricing Schema
const PricingSchema = new Schema<IPricing>({
  type: { type: String, enum: ["fixed", "unit", "rfq"], required: true },
  amount: { type: Number, min: 0 },
  priceRange: {
    min: { type: Number, min: 0 },
    max: { type: Number, min: 0 },
  },
  minOrderQuantity: { type: Number, min: 1 }, // Unit pricing: minimum order quantity
});

// Included Item Schema
const IncludedItemSchema = new Schema<IIncludedItem>({
  name: { type: String, required: true },
  description: { type: String },
  isCustom: { type: Boolean, default: false },
});

// Material Schema
const MaterialSchema = new Schema<IMaterial>({
  name: { type: String, required: true, maxlength: 200 },
  quantity: { type: String, maxlength: 50 },
  unit: { type: String, maxlength: 50 },
  description: { type: String, maxlength: 500 },
});

// Execution Duration Schema
// NOTE: value/unit not required at schema level to allow draft auto-save
// before the wizard is complete. Submit-time validation enforces completeness.
const ExecutionDurationSchema = new Schema<IExecutionDuration>({
  value: { type: Number, min: 0 },
  unit: { type: String, enum: ["hours", "days"] },
  range: {
    min: { type: Number, min: 0 },
    max: { type: Number, min: 0 },
  },
});

const PreparationDurationSchema = new Schema<IPreparationDuration>({
  value: { type: Number, min: 0 },
  unit: { type: String, enum: ["hours", "days"] },
});

// Buffer Schema
const BufferSchema = new Schema<IBuffer>({
  value: { type: Number, min: 0 },
  unit: { type: String, enum: ["hours", "days"] },
});

// Intake Duration Schema
const IntakeDurationSchema = new Schema<IIntakeDuration>({
  value: { type: Number, min: 0 },
  unit: { type: String, enum: ["hours", "days"] },
  buffer: { type: Number, min: 0 },
});

// Professional Input Value Schema
const ProfessionalInputValueSchema = new Schema({
  fieldName: { type: String, required: true },
  value: { type: Schema.Types.Mixed, required: true },
});

// Subproject Schema
const SubprojectSchema = new Schema<ISubproject>({
  name: { type: String, required: true, maxlength: 100 },
  description: {
    type: String,
    required: true,
    maxlength: 100,
    validate: {
      validator: function(this: any, value: string) {
        // Only enforce minlength 10 on new creations
        if (this && this.isNew) {
          return value != null && value.length >= 10;
        }
        return true;
      },
      message: "Description must be at least 10 characters.",
    },
  },
  projectType: [{ type: String }],
  customProjectType: { type: String, maxlength: 100 },
  professionalInputs: [ProfessionalInputValueSchema],
  pricing: { type: PricingSchema, required: true },
  included: [IncludedItemSchema],
  materialsIncluded: { type: Boolean, default: false },
  materials: [MaterialSchema],
  preparationDuration: { type: PreparationDurationSchema },
  executionDuration: { type: ExecutionDurationSchema },
  buffer: BufferSchema,
  intakeDuration: IntakeDurationSchema,
  warrantyPeriod: {
    value: { type: Number, min: 0, max: 10, default: 0 },
    unit: { type: String, enum: ["months", "years"], default: "years" },
  },
});

// Extra Option Schema
const ExtraOptionSchema = new Schema<IExtraOption>({
  name: { type: String, required: true, maxlength: 100 },
  description: { type: String, maxlength: 300 },
  price: { type: Number, required: true, min: 0 },
  isCustom: { type: Boolean, default: false },
});

// Term Condition Schema
const TermConditionSchema = new Schema<ITermCondition>({
  name: { type: String, required: true, maxlength: 100 },
  description: { type: String, required: true, maxlength: 500 },
  type: { type: String, enum: ["condition", "warning"], default: "condition" },
  additionalCost: { type: Number, min: 0 },
  isCustom: { type: Boolean, default: false },
});

// FAQ Schema
const FAQSchema = new Schema<IFAQ>({
  question: { type: String, required: true, maxlength: 200 },
  answer: { type: String, required: true, maxlength: 1000 },
  isGenerated: { type: Boolean, default: false },
});

// RFQ Question Schema
const RFQQuestionSchema = new Schema<IRFQQuestion>({
  question: { type: String, required: true, maxlength: 200 },
  type: {
    type: String,
    enum: ["text", "multiple_choice", "attachment"],
    required: true,
  },
  options: [{ type: String }],
  isRequired: { type: Boolean, default: false },
  professionalAttachments: [{ type: String }],
});

// Post Booking Question Schema
const PostBookingQuestionSchema = new Schema<IPostBookingQuestion>({
  question: { type: String, required: true, maxlength: 200 },
  type: {
    type: String,
    enum: ["text", "multiple_choice", "attachment"],
    required: true,
  },
  options: [{ type: String }],
  isRequired: { type: Boolean, default: false },
  professionalAttachments: [{ type: String }],
});

// Quality Check Schema
const QualityCheckSchema = new Schema<IQualityCheck>({
  category: { type: String, required: true },
  status: {
    type: String,
    enum: ["passed", "failed", "warning"],
    required: true,
  },
  message: { type: String, required: true },
  checkedAt: { type: Date, default: Date.now },
});

// Service Selection Schema
const ServiceSelectionSchema = new Schema<IServiceSelection>({
  category: { type: String, required: true },
  service: { type: String, required: true },
  areaOfWork: { type: String },
});

// Main Project Schema
const ProjectSchema = new Schema<IProject>(
  {
    // Scheduling configuration
    timeMode: {
      type: String,
      enum: ["hours", "days", "mixed"],
    },
    preparationDuration: {
      value: { type: Number, min: 0 },
      unit: { type: String, enum: ["hours", "days"] },
    },
    executionDuration: {
      type: ExecutionDurationSchema,
    },
    bufferDuration: {
      type: BufferSchema,
    },
    minResources: {
      type: Number,
      min: 1,
    },
    minOverlapPercentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 70,
    },
    // Step 1: Basic Info
    professionalId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      set: (value: unknown) => {
        if (typeof value === "string" && Types.ObjectId.isValid(value)) {
          return new Types.ObjectId(value);
        }
        return value;
      },
    },
    category: { type: String, required: true },
    service: { type: String, required: true },
    areaOfWork: { type: String },
    serviceConfigurationId: { type: String },
    categories: [{ type: String }],
    services: {
      type: [ServiceSelectionSchema],
      validate: {
        validator: function (v: IServiceSelection[]) {
          // Services array is optional - single service stored in category/service fields
          if (!v || v.length === 0) return true;
          return v.length >= 1 && v.length <= 1; // Now only allows 1 service
        },
        message: "Services must contain exactly 1 item",
      },
    },
    certifications: [CertificationSchema],
    distance: { type: DistanceSchema, required: true },
    intakeMeeting: IntakeMeetingSchema,
    renovationPlanning: RenovationPlanningSchema,
    resources: [{ type: String }],
    description: { type: String, required: true, maxlength: 1300 },
    priceModel: {
      type: String,
      required: true,
    },
    keywords: [{ type: String }],
    title: { type: String, required: true, minlength: 30, maxlength: 90 },
    media: { type: MediaSchema, required: true },

    // Step 2: Subprojects
    subprojects: [SubprojectSchema],

    // Repeat-buyer discount
    repeatBuyerDiscount: {
      enabled: { type: Boolean, default: false },
      percentage: { type: Number, min: 1, max: 20, default: 5 },
      minPreviousBookings: { type: Number, min: 1, default: 1 },
      maxDiscountAmount: { type: Number, min: 0, default: null },
    },

    // Step 3: Extra Options
    extraOptions: [ExtraOptionSchema],
    termsConditions: [TermConditionSchema],

    // Step 4: FAQ
    faq: [FAQSchema],

    // Step 5: RFQ Questions
    rfqQuestions: [RFQQuestionSchema],

    // Step 6: Post-Booking Questions
    postBookingQuestions: [PostBookingQuestionSchema],

    // Step 7: Custom Confirmation
    customConfirmationMessage: { type: String, maxlength: 1000 },

    // Step 8: Review & Status
    // Project lifecycle status
    status: {
      type: String,
      enum: ["draft", "pending", "rejected", "published", "on_hold", "suspended"],
      default: "draft",
    },
    // Booking lifecycle status
    bookingStatus: {
      type: String,
      enum: [
        "rfq",
        "quoted",
        "booked",
        "execution",
        "completed",
        "cancelled",
        "dispute",
        "warranty",
      ],
      required: false,
    },
    qualityChecks: [QualityCheckSchema],
    adminFeedback: { type: String },
    submittedAt: { type: Date },
    approvedAt: { type: Date },
    approvedBy: { type: String },

    // Change tracking for smart reapproval
    previousSnapshot: { type: Schema.Types.Mixed },
    pendingChanges: [
      {
        field: { type: String, required: true },
        category: { type: String, enum: ["A", "B", "none"], required: true },
        oldValue: { type: Schema.Types.Mixed },
        newValue: { type: Schema.Types.Mixed },
        moderationResult: {
          passed: { type: Boolean },
          reasons: [{ type: String }],
        },
      },
    ],
    reapprovalType: {
      type: String,
      enum: ["full", "moderation_failed", "none"],
    },
    isResubmission: { type: Boolean, default: false },

    // Auto-save tracking
    autoSaveTimestamp: { type: Date, default: Date.now },
    currentStep: { type: Number, default: 1, min: 1, max: 8 },
  },
  {
    timestamps: true,
  }
);

ProjectSchema.index({ status: 1, submittedAt: 1 });
ProjectSchema.index({ professionalId: 1, status: 1 });
ProjectSchema.index({ professionalId: 1, updatedAt: -1 });
ProjectSchema.index({ professionalId: 1, autoSaveTimestamp: -1 });
// Text indexes for search functionality
ProjectSchema.index({ title: 'text', description: 'text' });
ProjectSchema.index({ category: 1, service: 1 });
ProjectSchema.index({ status: 1 });
ProjectSchema.index({ "distance.location": "2dsphere" });

// Strip empty/invalid location before save so the 2dsphere index doesn't choke
function sanitizeLocation(doc: any) {
  const coords = doc?.distance?.location?.coordinates;
  if (!coords || (Array.isArray(coords) && coords.length !== 2)) {
    if (doc.distance?.location) {
      doc.distance.location = undefined;
    }
  }
}

// Pre-save middleware
ProjectSchema.pre("save", function (next) {
  this.autoSaveTimestamp = new Date();
  sanitizeLocation(this);
  next();
});

// Pre-findOneAndUpdate middleware
ProjectSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate() as any;
  if (update) {
    sanitizeLocation(update);
    // Also handle $set wrapper
    if (update.$set) {
      sanitizeLocation(update.$set);
    }
  }
  next();
});

const Project = model<IProject>("Project", ProjectSchema);

export default Project;
