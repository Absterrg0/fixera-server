import { Schema, model, Document, Types } from "mongoose";
import { normalizePendingIdChanges } from "../utils/pendingIdChanges";

export type UserRole = "admin" | "visitor" | "customer" | "professional" | "employee";
export type CustomerType = "individual" | "business";

export interface IUser extends Document {
    _id: Types.ObjectId;
    name: string;
    password?: string;
    email: string;
    phone: string;
    isPhoneVerified: boolean;
    isEmailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
    role: UserRole;
    verificationCode?: string;
    verificationCodeExpires?: Date;
    vatNumber?: string;
    isVatVerified?: boolean;
    idProofUrl?: string;
    idProofFileName?: string;
    idProofUploadedAt?: Date;
    isIdVerified?: boolean;
    idCountryOfIssue?: string;
    idExpirationDate?: Date;
    idExpiryEmailSentAt?: Date;
    pendingIdChanges?: {
        field?: string;
        oldValue?: string;
        newValue?: string;
    }[];
    professionalId?: string;
    // Professional approval fields
    professionalStatus?: 'draft' | 'pending' | 'approved' | 'rejected' | 'suspended';
    approvedBy?: string; // Admin user ID who approved
    approvedAt?: Date;
    rejectionReason?: string;
    suspensionReason?: string;
    previousProfessionalStatus?: 'draft' | 'pending' | 'approved' | 'rejected';
    lastIdChangeRejectionReason?: string;
    // Customer-specific fields
    customerType?: CustomerType;
    businessName?: string; // For business customers
    companyAddress?: {
        address?: string;
        city?: string;
        country?: string;
        postalCode?: string;
    };
    location?: {
        type: 'Point';
        coordinates: [number, number]; // [longitude, latitude]
        address?: string;
        city?: string;
        country?: string;
        postalCode?: string;
    };
    // Professional-specific fields
    businessInfo?: {
        companyName?: string;
        description?: string;
        website?: string;
        address?: string;
        city?: string;
        country?: string;
        postalCode?: string;
        timezone?: string;
    };
    hourlyRate?: number;
    currency?: string;
    serviceCategories?: string[];
    // Personal availability (professional's own working schedule)
    availability?: {
        monday?: { available: boolean; startTime?: string; endTime?: string; };
        tuesday?: { available: boolean; startTime?: string; endTime?: string; };
        wednesday?: { available: boolean; startTime?: string; endTime?: string; };
        thursday?: { available: boolean; startTime?: string; endTime?: string; };
        friday?: { available: boolean; startTime?: string; endTime?: string; };
        saturday?: { available: boolean; startTime?: string; endTime?: string; };
        sunday?: { available: boolean; startTime?: string; endTime?: string; };
    };
    blockedDates?: {
        date: Date;
        reason?: string;
    }[];
    blockedRanges?: {
        startDate: Date;
        endDate: Date;
        reason?: string;
        createdAt?: Date;
    }[];
    // Company-wide availability (for team members to inherit)
    companyAvailability?: {
        monday?: { available: boolean; startTime?: string; endTime?: string; };
        tuesday?: { available: boolean; startTime?: string; endTime?: string; };
        wednesday?: { available: boolean; startTime?: string; endTime?: string; };
        thursday?: { available: boolean; startTime?: string; endTime?: string; };
        friday?: { available: boolean; startTime?: string; endTime?: string; };
        saturday?: { available: boolean; startTime?: string; endTime?: string; };
        sunday?: { available: boolean; startTime?: string; endTime?: string; };
    };
    companyBlockedDates?: {
        date: Date;
        reason?: string;
        isHoliday?: boolean;
    }[];
    companyBlockedRanges?: {
        startDate: Date;
        endDate: Date;
        reason?: string;
        isHoliday?: boolean;
        createdAt?: Date;
    }[];
    profileImage?: string;
    profileCompletedAt?: Date;
    professionalOnboardingCompletedAt?: Date;
    onboardingAgreements?: {
        rulesAccepted?: boolean;
        termsAccepted?: boolean;
        selfBillingAccepted?: boolean;
        acceptedAt?: Date;
    };
    // Loyalty system fields
    loyaltyLevel?: 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
    manualCustomerLevelOverride?: 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
    totalSpent?: number;
    totalBookings?: number;
    lastLoyaltyUpdate?: Date;
    // Unified points system
    points?: number;
    pointsExpiry?: Date;
    // Professional level
    professionalLevel?: 'New' | 'Level 1' | 'Level 2' | 'Level 3' | 'Expert';
    manualProfessionalLevelOverride?: 'New' | 'Level 1' | 'Level 2' | 'Level 3' | 'Expert';
    adminTags?: string[];
    accountStatus?: 'active' | 'suspended' | 'rejected';
    deletedAt?: Date;
    deletedBy?: Types.ObjectId;
    // Referral system fields
    referralCode?: string;
    referredBy?: Types.ObjectId;
    totalReferrals?: number;
    completedReferrals?: number;
    // Favorite notification tracking (professional only)
    lastFavoritesViewedAt?: Date;
    employee?: {
        companyId?: string;
        invitedBy?: string;
        invitedAt?: Date;
        acceptedAt?: Date;
        isActive?: boolean;
        hasEmail?: boolean;
        availabilityPreference?: 'personal' | 'same_as_company';
        managedByCompany?: boolean;
    };
    username?: string;
    // Stripe Connect fields (for professionals)
    stripe?: {
        accountId?: string;
        onboardingCompleted?: boolean;
        payoutsEnabled?: boolean;
        detailsSubmitted?: boolean;
        chargesEnabled?: boolean;
        accountStatus?: 'pending' | 'active' | 'restricted' | 'rejected';
        lastOnboardingRefresh?: Date;
        createdAt?: Date;
    };
}

const UserSchema = new Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
    },
    phone: {
        type: String,
        required: [true, 'Phone number is required'],
        unique: true,
    },
    isPhoneVerified: {
        type: Boolean,
        default: false
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters long'],
        select: false
    },
    role: {
        type: String,
        enum: ['admin', 'visitor', 'customer', 'professional', 'employee'],
        default: 'customer'
    },

    verificationCode: {
        type: String,
        select: false 
    },
    verificationCodeExpires: {
        type: Date,
        select: false 
    },
    vatNumber: {
        type: String,
        required: false,
        trim: true,
        validate: {
            validator: function(v: string) {
                if (!v) return true; // VAT number is optional
                // Basic VAT number format validation (2-letter country code + 4-15 digits/letters)
                return /^[A-Z]{2}[A-Z0-9]{4,15}$/.test(v);
            },
            message: 'Invalid VAT number format'
        }
    },
    isVatVerified: {
        type: Boolean,
        default: false
    },
    idProofUrl: {
        type: String,
        required: false
    },
    idProofFileName: {
        type: String,
        required: false
    },
    idProofUploadedAt: {
        type: Date,
        required: false
    },
    isIdVerified: {
        type: Boolean,
        default: false
    },
    idCountryOfIssue: {
        type: String,
        required: false,
        trim: true
    },
    idExpirationDate: {
        type: Date,
        required: false
    },
    idExpiryEmailSentAt: {
        type: Date,
        required: false
    },
    pendingIdChanges: {
        type: [{
            field: { type: String, required: true },
            // Empty strings are valid here to represent "(not set)" in audit history.
            oldValue: { type: String, required: false, default: '' },
            newValue: { type: String, required: false, default: '' }
        }],
        default: []
    },
    username: {
        type: String,
        trim: true,
        lowercase: true,
        minlength: [3, 'Username must be at least 3 characters'],
        maxlength: [30, 'Username cannot exceed 30 characters'],
        validate: {
            validator: function(v: string) {
                if (!v) return true;
                return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(v);
            },
            message: 'Username can only contain lowercase letters, numbers, and hyphens. Must start and end with a letter or number.'
        }
    },
    // Professional approval fields
    professionalStatus: {
        type: String,
        enum: ['draft', 'pending', 'approved', 'rejected', 'suspended'],
        default: function(this: IUser) {
            return this.role === 'professional' ? 'draft' : undefined;
        },
        required: function(this: IUser) {
            return this.role === 'professional';
        }
    },
    approvedBy: {
        type: String,
        required: false
    },
    approvedAt: {
        type: Date,
        required: false
    },
    rejectionReason: {
        type: String,
        required: false,
        maxlength: 500
    },
    suspensionReason: {
        type: String,
        required: false,
        maxlength: 500
    },
    previousProfessionalStatus: {
        type: String,
        enum: ['draft', 'pending', 'approved', 'rejected'],
        required: false
    },
    lastIdChangeRejectionReason: {
        type: String,
        required: false,
        maxlength: 500
    },
    // Professional-specific fields
    businessInfo: {
        companyName: { type: String, required: false },
        description: { type: String, required: false, maxlength: 1000 },
        website: { type: String, required: false },
        address: { type: String, required: false },
        city: { type: String, required: false },
        country: { type: String, required: false },
        postalCode: { type: String, required: false },
        timezone: { type: String, required: false, default: 'UTC' }
    },
    hourlyRate: {
        type: Number,
        required: false,
        min: 0,
        max: 10000
    },
    currency: {
        type: String,
        required: false,
        default: 'USD',
        enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD']
    },
    serviceCategories: [{
        type: String,
        required: false
    }],
    availability: {
        monday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        tuesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        wednesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        thursday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        friday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        saturday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        sunday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        }
    },
    blockedDates: [{
        date: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 }
    }],
    blockedRanges: [{
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 },
        createdAt: { type: Date, default: Date.now }
    }],
    companyAvailability: {
        monday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        tuesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        wednesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        thursday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        friday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        saturday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        sunday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        }
    },
    companyBlockedDates: [{
        date: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 },
        isHoliday: { type: Boolean, default: false }
    }],
    companyBlockedRanges: [{
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 },
        isHoliday: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    }],
    profileImage: {
        type: String,
        required: false
    },
    profileCompletedAt: {
        type: Date,
        required: false
    },
    professionalOnboardingCompletedAt: {
        type: Date,
        required: false
    },
    onboardingAgreements: {
        rulesAccepted: { type: Boolean, default: false },
        termsAccepted: { type: Boolean, default: false },
        selfBillingAccepted: { type: Boolean, default: false },
        acceptedAt: { type: Date, required: false }
    },
    // Loyalty system fields
    loyaltyLevel: {
        type: String,
        enum: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'],
        default: 'Bronze'
    },
    manualCustomerLevelOverride: {
        type: String,
        enum: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'],
        required: false
    },
    totalSpent: {
        type: Number,
        default: 0,
        min: 0
    },
    totalBookings: {
        type: Number,
        default: 0,
        min: 0
    },
    lastLoyaltyUpdate: {
        type: Date,
        default: Date.now
    },
    // Unified points system
    points: {
        type: Number,
        default: 0,
        min: 0
    },
    pointsExpiry: {
        type: Date,
        required: false
    },
    // Professional level
    professionalLevel: {
        type: String,
        enum: ['New', 'Level 1', 'Level 2', 'Level 3', 'Expert'],
        default: 'New'
    },
    manualProfessionalLevelOverride: {
        type: String,
        enum: ['New', 'Level 1', 'Level 2', 'Level 3', 'Expert'],
        required: false
    },
    adminTags: {
        type: [{
            type: String,
            trim: true,
            maxlength: 40
        }],
        validate: {
            validator: (val: string[]) => !val || val.length <= 20,
            message: 'adminTags cannot exceed 20 items'
        }
    },
    accountStatus: {
        type: String,
        enum: ['active', 'suspended', 'rejected'],
        default: 'active'
    },
    deletedAt: {
        type: Date,
        required: false
    },
    deletedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: false
    },
    // Referral system fields
    referralCode: {
        type: String,
        unique: true,
        sparse: true,
        index: true
    },
    referredBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: false
    },
    totalReferrals: {
        type: Number,
        default: 0,
        min: 0
    },
    completedReferrals: {
        type: Number,
        default: 0,
        min: 0
    },
    lastFavoritesViewedAt: {
        type: Date,
        required: false
    },
    employee: {
        companyId: { type: String, required: false },
        invitedBy: { type: String, required: false },
        invitedAt: { type: Date, required: false },
        acceptedAt: { type: Date, required: false },
        isActive: { type: Boolean, default: true },
        hasEmail: { type: Boolean, default: true },
        availabilityPreference: {
            type: String,
            enum: ['personal', 'same_as_company'],
            default: 'personal',
            required: function(this: IUser) {
                return this.role === 'employee';
            }
        },
        managedByCompany: { type: Boolean, default: false }
    },
    // Stripe Connect fields (for professionals)
    stripe: {
        type: new Schema({
            accountId: { type: String, required: false },
            onboardingCompleted: { type: Boolean, default: false },
            payoutsEnabled: { type: Boolean, default: false },
            detailsSubmitted: { type: Boolean, default: false },
            chargesEnabled: { type: Boolean, default: false },
            accountStatus: {
                type: String,
                enum: ['pending', 'active', 'restricted', 'rejected'],
                default: 'pending',
                required: false
            },
            lastOnboardingRefresh: { type: Date, required: false },
            createdAt: { type: Date, required: false }
        }, { _id: false }),
        default: undefined
    },
    // Customer-specific fields
    businessName: {
        type: String,
        required: false,
        trim: true,
        maxlength: 200
    },
    companyAddress: {
        address: { type: String, required: false, trim: true },
        city: { type: String, required: false, trim: true },
        country: { type: String, required: false, trim: true },
        postalCode: { type: String, required: false, trim: true }
    },
    customerType: {
        type: String,
        enum: ['individual', 'business'],
        required: function(this: IUser) {
            return this.role === 'customer';
        },
        default: function(this: IUser) {
            return this.role === 'customer' ? 'individual' : undefined;
        }
    },
    location: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            required: false,
            validate: {
                validator: function(v: number[]) {
                    if (!v || v.length === 0) return true; // Allow empty
                    // Validate longitude and latitude ranges
                    return v.length === 2 &&
                           v[0] >= -180 && v[0] <= 180 && // longitude
                           v[1] >= -90 && v[1] <= 90;     // latitude
                },
                message: 'Invalid coordinates format. Expected [longitude, latitude]'
            }
        },
        address: { type: String, required: false },
        city: { type: String, required: false },
        country: { type: String, required: false },
        postalCode: { type: String, required: false }
    }
}, {
    timestamps: true
});

UserSchema.pre("save", function (next) {
    this.set(
        "pendingIdChanges",
        normalizePendingIdChanges(
            this.pendingIdChanges as Array<{
                field?: string;
                oldValue?: string | null;
                newValue?: string;
            }>
        )
    );

    const isBusinessCustomer = this.role === "customer" && this.customerType === "business";
    if (!isBusinessCustomer) {
        this.set("businessName", undefined);
        this.set("companyAddress", undefined);
    }


    if (this.role !== "professional") {
        this.set("stripe", undefined);
        this.set("onboardingAgreements", undefined);
        this.set("lastFavoritesViewedAt", undefined);
    }

    // Clear fields that employees don't need - they only need:
    // basic auth fields, employee.*, blockedDates, blockedRanges
    if (this.role === "employee") {
        // Professional-only fields
        this.set("businessInfo", undefined);
        this.set("hourlyRate", undefined);
        this.set("currency", undefined);
        this.set("serviceCategories", undefined);
        this.set("availability", undefined);
        this.set("companyAvailability", undefined);
        this.set("companyBlockedDates", undefined);
        this.set("companyBlockedRanges", undefined);

        // Professional verification/approval fields
        this.set("vatNumber", undefined);
        this.set("isVatVerified", undefined);
        this.set("idProofUrl", undefined);
        this.set("idProofFileName", undefined);
        this.set("idProofUploadedAt", undefined);
        this.set("isIdVerified", undefined);
        this.set("idCountryOfIssue", undefined);
        this.set("idExpirationDate", undefined);
        this.set("idExpiryEmailSentAt", undefined);
        this.set("pendingIdChanges", undefined);
        this.set("professionalStatus", undefined);
        this.set("approvedBy", undefined);
        this.set("approvedAt", undefined);
        this.set("rejectionReason", undefined);
        this.set("suspensionReason", undefined);
        this.set("lastIdChangeRejectionReason", undefined);

        // Customer-only fields
        this.set("customerType", undefined);
        this.set("companyAddress", undefined);
        this.set("location", undefined);
        this.set("loyaltyLevel", undefined);
        this.set("totalSpent", undefined);
        this.set("totalBookings", undefined);
        this.set("lastLoyaltyUpdate", undefined);
        this.set("manualCustomerLevelOverride", undefined);
        this.set("points", undefined);
        this.set("pointsExpiry", undefined);

        // Referral fields
        this.set("referralCode", undefined);
        this.set("referredBy", undefined);
        this.set("totalReferrals", undefined);
        this.set("completedReferrals", undefined);

        this.set("username", undefined);
        this.set("profileCompletedAt", undefined);
        this.set("professionalOnboardingCompletedAt", undefined);
        this.set("manualProfessionalLevelOverride", undefined);
        this.set("adminTags", undefined);
    }
    next();
});

UserSchema.index({ role: 1, professionalStatus: 1 });
UserSchema.index({ role: 1 });
UserSchema.index({ role: 1, points: 1 });
UserSchema.index({ role: 1, totalSpent: -1 });
UserSchema.index({ role: 1, loyaltyLevel: 1 });
UserSchema.index({ role: 1, professionalLevel: 1 });
UserSchema.index({ role: 1, accountStatus: 1 });
UserSchema.index({ role: 1, adminTags: 1 });
UserSchema.index({ 'employee.companyId': 1 });
// Text indexes for search functionality
UserSchema.index({ name: 'text', username: 'text', 'businessInfo.companyName': 'text' });
UserSchema.index({ serviceCategories: 1 });
UserSchema.index({ 'businessInfo.city': 1, 'businessInfo.country': 1 });
UserSchema.index({ hourlyRate: 1 });
// Customer-specific indexes
UserSchema.index({ customerType: 1 });
UserSchema.index({ 'location.coordinates': '2dsphere' }); // Geospatial index for location-based queries
UserSchema.index({ 'location.city': 1, 'location.country': 1 });
UserSchema.index({ role: 1, 'location.city': 1, createdAt: 1 });
// Stripe Connect indexes
UserSchema.index({ username: 1 }, { unique: true, sparse: true });
UserSchema.index({ 'stripe.accountId': 1 }, { unique: true, sparse: true });
UserSchema.index({ role: 1, 'stripe.chargesEnabled': 1 });

const User = model<IUser>('User', UserSchema);

export default User;
