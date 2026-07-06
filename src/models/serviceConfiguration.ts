import { Schema, model, Document } from "mongoose";

// Dynamic field types that professionals need to fill in
export interface IDynamicField {
    fieldName: string; // e.g., "range m2 living area", "Building Type", "kW system power"
    fieldType: 'range' | 'dropdown' | 'number' | 'text'; // Type of input field
    unit?: string; // e.g., "m2", "m3", "kW", "kWh", "Wp", "m3/h"
    label: string; // Display label for the field
    placeholder?: string;
    isRequired: boolean;
    options?: string[]; // For dropdown fields
    min?: number; // For number and range fields
    max?: number; // For number and range fields
    isSingleNumber?: boolean;
}

// Items that can be included in the service
export interface IIncludedItem {
    name: string;
    description?: string;
    isDynamic: boolean; // If true, this is a field professionals fill in (from red text)
    dynamicField?: IDynamicField; // Configuration for dynamic field
}

// Structured pricing option
export interface IPricingOption {
    name: string; // e.g., "Total price", "Per m²"
    pricingType: 'fixed_price' | 'price_per_unit'; // Type of pricing
    unit?: string; // e.g., "m²", "hour", "room" (only for price_per_unit)
}

// Extra options/add-ons
export interface IExtraOption {
    name: string;
    description?: string;
    isCustomizable: boolean; // Can professional modify this?
}

// Terms, conditions, and warnings
export interface IConditionWarning {
    text: string;
    type: 'condition' | 'warning';
}

export interface IVatQuestion {
    question: string;
    fieldName: string;
    answerType: 'number' | 'yes_no' | 'checkboxes';
    unit?: string;
    options?: string[];
    isRequired: boolean;
}

export interface IVatLogicCondition {
    fieldName: string;
    operator: 'equals' | 'not_equals' | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal' | 'includes';
    value: string | number | boolean;
    connector?: 'AND' | 'OR';
}

export interface IVatLogicRule {
    country: string;
    standardRate: number;
    reducedRate: number;
    conditions: IVatLogicCondition[];
    action: 'reduced_rate' | 'rfq';
    customText?: string;
    priority: number;
    isActive: boolean;
}

export interface IVatManagement {
    enabled: boolean;
    rateRuleGroup?: string;
    reducedVatQuestions: IVatQuestion[];
    logicRules: IVatLogicRule[];
}

// Main service configuration interface
export interface IServiceConfiguration extends Document {
    // Core identifiers (NOT configurable by admin)
    category: string; // e.g., "Exterior", "Interior", "Outdoor work"
    service: string; // e.g., "Architect", "Demolition Plan", "Plumbing"

    // Admin-configurable fields
    areaOfWork?: string; // e.g., "Strip Foundations", "Raft Foundation"
    pricingModel?: string; // Legacy: e.g., "Total price", "Total price or m² of material"
    pricingOptions: IPricingOption[]; // Structured pricing options
    icon?: string; // Icon identifier (e.g., "Hammer", "Wrench")
    certificationRequired: boolean;
    requiredCertifications?: string[]; // Specific certification types required

    // Project types (multi-select options)
    projectTypes: string[]; // e.g., ["New Built", "Extension", "Refurbishment"]

    // Included items/services (with dynamic fields marked)
    includedItems: IIncludedItem[];

    // Dynamic fields that professionals must fill
    professionalInputFields: IDynamicField[];

    // Extra options/add-ons
    extraOptions: IExtraOption[];

    // Conditions and warnings
    conditionsAndWarnings: IConditionWarning[];

    // VAT management
    vatManagement?: IVatManagement;

    // Metadata
    isActive: boolean;
    activeCountries: string[]; // Countries where this config is active
    createdAt: Date;
    updatedAt: Date;
}

// Dynamic Field Schema
const DynamicFieldSchema = new Schema<IDynamicField>({
    fieldName: { type: String, required: true },
    fieldType: {
        type: String,
        enum: ['range', 'dropdown', 'number', 'text'],
        required: true
    },
    unit: { type: String },
    label: { type: String, required: true },
    placeholder: { type: String },
    isRequired: { type: Boolean, default: true },
    options: [{ type: String }],
    min: { type: Number },
    max: { type: Number },
    isSingleNumber: { type: Boolean, default: false }
}, { _id: false });

// Included Item Schema
const IncludedItemSchema = new Schema<IIncludedItem>({
    name: { type: String, required: true },
    description: { type: String },
    isDynamic: { type: Boolean, default: false },
    dynamicField: { type: DynamicFieldSchema }
}, { _id: false });

// Pricing Option Schema
const PricingOptionSchema = new Schema<IPricingOption>({
    name: { type: String, required: true },
    pricingType: {
        type: String,
        enum: ['fixed_price', 'price_per_unit'],
        required: true
    },
    unit: { type: String }
}, { _id: false });

PricingOptionSchema.pre('validate', function(next) {
    const pricingType = this.pricingType;
    const unit = typeof this.unit === 'string' ? this.unit.trim() : this.unit;
    if (pricingType === 'price_per_unit' && !unit) {
        return next(new Error('Unit is required for price_per_unit pricing type'));
    }
    if (pricingType === 'fixed_price' && unit) {
        return next(new Error('Unit must be empty for fixed_price pricing type'));
    }
    next();
});

// Extra Option Schema
const ExtraOptionSchema = new Schema<IExtraOption>({
    name: { type: String, required: true },
    description: { type: String },
    isCustomizable: { type: Boolean, default: false }
}, { _id: false });

// Condition/Warning Schema
const ConditionWarningSchema = new Schema<IConditionWarning>({
    text: { type: String, required: true },
    type: { type: String, enum: ['condition', 'warning'], required: true }
}, { _id: false });

const VatQuestionSchema = new Schema<IVatQuestion>({
    question: { type: String, required: true, trim: true },
    fieldName: { type: String, required: true, trim: true },
    answerType: {
        type: String,
        enum: ['number', 'yes_no', 'checkboxes'],
        required: true
    },
    unit: { type: String, trim: true },
    options: [{ type: String }],
    isRequired: { type: Boolean, default: true }
}, { _id: false });

const VatLogicConditionSchema = new Schema<IVatLogicCondition>({
    fieldName: { type: String, required: true, trim: true },
    operator: {
        type: String,
        enum: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'includes'],
        required: true
    },
    value: { type: Schema.Types.Mixed, required: true },
    connector: { type: String, enum: ['AND', 'OR'], default: 'AND' }
}, { _id: false });

const VatLogicRuleSchema = new Schema<IVatLogicRule>({
    country: { type: String, required: true, trim: true },
    standardRate: { type: Number, required: true, min: 0, max: 100 },
    reducedRate: { type: Number, required: true, min: 0, max: 100 },
    conditions: { type: [VatLogicConditionSchema], default: [] },
    action: { type: String, enum: ['reduced_rate', 'rfq'], required: true },
    customText: { type: String, trim: true },
    priority: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
}, { _id: false });

const VatManagementSchema = new Schema<IVatManagement>({
    enabled: { type: Boolean, default: false },
    rateRuleGroup: { type: String, trim: true },
    reducedVatQuestions: { type: [VatQuestionSchema], default: [] },
    logicRules: { type: [VatLogicRuleSchema], default: [] }
}, { _id: false });

// Main Service Configuration Schema
const ServiceConfigurationSchema = new Schema<IServiceConfiguration>({
    // Core identifiers
    category: { type: String, required: true, index: true },
    service: { type: String, required: true, index: true },

    // Admin-configurable fields
    areaOfWork: { type: String },
    pricingModel: { type: String }, // Legacy field, no longer required
    pricingOptions: { type: [PricingOptionSchema], default: [] },
    icon: { type: String },
    certificationRequired: { type: Boolean, default: false },
    requiredCertifications: [{ type: String, default: [] }],

    projectTypes: [{ type: String }],

    includedItems: [IncludedItemSchema],
    professionalInputFields: [DynamicFieldSchema],
    extraOptions: [ExtraOptionSchema],
    conditionsAndWarnings: [ConditionWarningSchema],
    vatManagement: { type: VatManagementSchema, default: () => ({ enabled: false, reducedVatQuestions: [], logicRules: [] }) },

    // Metadata
    isActive: { type: Boolean, default: true },
    activeCountries: { type: [String], default: ['BE'] }
}, {
    timestamps: true
});

function validatePricingOptionsArray(pricingOptions: any): Error | null {
    if (!Array.isArray(pricingOptions)) return null;
    for (let i = 0; i < pricingOptions.length; i++) {
        const opt = pricingOptions[i];
        if (!opt || typeof opt !== 'object') continue;
        const pricingType = opt.pricingType;
        const unit = typeof opt.unit === 'string' ? opt.unit.trim() : opt.unit;
        if (pricingType === 'price_per_unit' && !unit) {
            return new Error(`pricingOptions[${i}].unit: Unit is required for price_per_unit pricing type`);
        }
        if (pricingType === 'fixed_price' && unit) {
            return new Error(`pricingOptions[${i}].unit: Unit must be empty for fixed_price pricing type`);
        }
    }
    return null;
}

ServiceConfigurationSchema.pre('findOneAndUpdate', function(next) {
    const update: any = this.getUpdate() || {};
    const candidates = [update.pricingOptions, update.$set?.pricingOptions];
    for (const candidate of candidates) {
        if (candidate === undefined) continue;
        const err = validatePricingOptionsArray(candidate);
        if (err) return next(err);
    }
    next();
});

ServiceConfigurationSchema.pre('updateOne', function(next) {
    const update: any = this.getUpdate() || {};
    const candidates = [update.pricingOptions, update.$set?.pricingOptions];
    for (const candidate of candidates) {
        if (candidate === undefined) continue;
        const err = validatePricingOptionsArray(candidate);
        if (err) return next(err);
    }
    next();
});

// Indexes for efficient querying
ServiceConfigurationSchema.index({ category: 1, service: 1, areaOfWork: 1 });
ServiceConfigurationSchema.index({ isActive: 1, activeCountries: 1 });
ServiceConfigurationSchema.index({ category: 1, isActive: 1 });

const ServiceConfiguration = model<IServiceConfiguration>('ServiceConfiguration', ServiceConfigurationSchema);

export default ServiceConfiguration;
