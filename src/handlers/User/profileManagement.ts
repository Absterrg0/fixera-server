import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import { upload, uploadToS3, deleteFromS3, generateFileName, validateFile, validateImageFile, validateImageFileBuffer, parseS3KeyFromUrl } from "../../utils/s3Upload";
import mongoose from 'mongoose';
import { PhoneNumberUtil, PhoneNumberFormat } from 'google-libphonenumber';
import { getCountryCode } from '../../utils/geocoding';
import { formatVATNumber, isValidVATFormat, validateVATNumber } from "../../utils/viesApi";
import { NO_PREVIOUS_VALUE, normalizePendingIdChanges } from "../../utils/pendingIdChanges";
import { isValidUsernameFormat, isTooSimilarToCompanyName, generateUsernameSuggestions } from "../../utils/usernameUtils";
import { sendProfessionalWelcomeEmail } from "../../utils/emailService";
import ServiceConfiguration from "../../models/serviceConfiguration";
import { params } from "../../utils/requestParams";

const phoneUtil = PhoneNumberUtil.getInstance();

const normalizeOnboardingAgreements = (value: any) => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const rulesAccepted = Boolean(value.rulesAccepted);
  const termsAccepted = Boolean(value.termsAccepted);
  const selfBillingAccepted = Boolean(value.selfBillingAccepted);

  return {
    rulesAccepted,
    termsAccepted,
    selfBillingAccepted,
    acceptedAt: rulesAccepted && termsAccepted && selfBillingAccepted
      ? new Date()
      : undefined,
  };
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user?.id) {
      return next();
    }

    const token = req.cookies?.['auth-token'];

    if (!token) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    (req as any).user = { id: decoded.id };
    return next();
  } catch (error: any) {
    console.error('Require auth error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to authenticate user"
    });
  }
};

// Upload ID proof
export const uploadIdProof = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Check if user is a professional
    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "ID proof upload is only available for professionals"
      });
    }

    // Check if file exists
    if (!req.file) {
      return res.status(400).json({
        success: false,
        msg: "No file uploaded"
      });
    }

    // Validate file
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        msg: validation.error
      });
    }

    console.log(`📄 ID Proof: Processing upload for user ${user.email}`);

    // Track if this is a re-upload for an already-approved professional
    const wasApproved = user.professionalStatus === 'approved';
    const hadPreviousId = !!user.idProofUrl;
    const previousIdProofUrl = user.idProofUrl;
    const previousIdProofFileName = user.idProofFileName;

    // Only delete existing S3 file immediately if this is NOT an approved
    // professional re-uploading. For approved professionals the old file is
    // kept so that a rejection can restore it; cleanup happens on approve.
    if (user.idProofUrl && user.idProofFileName && !(wasApproved && hadPreviousId)) {
      try {
        const existingKey = user.idProofFileName.startsWith('id-proof/')
          ? user.idProofFileName
          : `id-proof/${user._id}/${user.idProofFileName}`;
        await deleteFromS3(existingKey);
        console.log(`🗑️ ID Proof: Deleted existing file for ${user.email}`);
      } catch (error) {
        console.warn(`⚠️ ID Proof: Could not delete existing file:`, error);
      }
    }

    // Generate unique filename
    const fileName = generateFileName(req.file.originalname, (user._id as mongoose.Types.ObjectId).toString(), 'id-proof');

    // Upload to S3
    const uploadResult = await uploadToS3(req.file, fileName);

    // Update user record
    user.idProofUrl = uploadResult.url;
    user.idProofFileName = uploadResult.key;
    user.idProofUploadedAt = new Date();
    user.isIdVerified = false; // Reset verification status when new file is uploaded
    user.idExpiryEmailSentAt = undefined; // Allow expiry reminders to run for the newly uploaded ID

    // If re-uploading ID while approved, trigger re-verification
    if (wasApproved && hadPreviousId) {
      user.professionalStatus = 'pending';
      if (!user.pendingIdChanges) user.pendingIdChanges = [];
      user.pendingIdChanges.push({
        field: 'idProofDocument',
        oldValue: previousIdProofUrl || previousIdProofFileName || NO_PREVIOUS_VALUE,
        newValue: uploadResult.key
      });
      user.rejectionReason = undefined;
    }

    await user.save();

    console.log(`✅ ID Proof: Successfully uploaded for ${user.email}`);

    // Return updated user data (without password)
    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      isEmailVerified: user.isEmailVerified || false,
      isPhoneVerified: user.isPhoneVerified || false,
      vatNumber: user.vatNumber,
      isVatVerified: user.isVatVerified || false,
      idProofUrl: user.idProofUrl,
      idProofFileName: user.idProofFileName,
      idProofUploadedAt: user.idProofUploadedAt,
      isIdVerified: user.isIdVerified || false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(200).json({
      success: true,
      msg: "ID proof uploaded successfully",
      user: userResponse
    });

  } catch (error: any) {
    console.error('ID proof upload error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to upload ID proof"
    });
  }
};

// Update professional profile
export const updateProfessionalProfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      vatNumber,
      businessInfo,
      hourlyRate,
      currency,
      serviceCategories,
      availability,
      blockedDates,
      blockedRanges,
      companyAvailability,
      companyBlockedDates,
      companyBlockedRanges,
      username,
      onboardingAgreements
    } = req.body;

    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Check if user is a professional
    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "Professional profile updates are only available for professionals"
      });
    }

    console.log(`👤 Profile: Updating professional profile for ${user.email}`);

    if (vatNumber !== undefined) {
      const rawVatNumber = typeof vatNumber === 'string' ? vatNumber.trim() : '';
      let formattedVAT = '';
      let isVatVerified = false;

      if (rawVatNumber) {
        formattedVAT = formatVATNumber(rawVatNumber);
        if (!isValidVATFormat(formattedVAT)) {
          return res.status(400).json({
            success: false,
            msg: "Invalid VAT number format"
          });
        }

        const validationResult = await validateVATNumber(formattedVAT);
        isVatVerified = validationResult.valid;
      }

      user.vatNumber = formattedVAT || undefined;
      user.isVatVerified = isVatVerified;
    }

    // Update fields if provided
    if (businessInfo) {
      user.businessInfo = {
        ...user.businessInfo,
        ...businessInfo
      };

    }

    if (username !== undefined) {
      const normalized = username.toLowerCase().trim();
      const formatCheck = isValidUsernameFormat(normalized);
      if (!formatCheck.valid) {
        return res.status(400).json({ success: false, msg: formatCheck.reason });
      }
      const existing = await User.findOne({ username: normalized, _id: { $ne: user._id } });
      if (existing) {
        return res.status(400).json({ success: false, msg: "Username already taken" });
      }
      if (user.businessInfo?.companyName && isTooSimilarToCompanyName(normalized, user.businessInfo.companyName)) {
        return res.status(400).json({ success: false, msg: "Username cannot be too similar to your company name" });
      }
      user.username = normalized;
    }

    if (hourlyRate !== undefined) {
      if (hourlyRate < 0 || hourlyRate > 10000) {
        return res.status(400).json({
          success: false,
          msg: "Hourly rate must be between 0 and 10000"
        });
      }
      user.hourlyRate = hourlyRate;
    }

    if (currency) {
      const allowedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
      if (!allowedCurrencies.includes(currency)) {
        return res.status(400).json({
          success: false,
          msg: "Invalid currency. Allowed: USD, EUR, GBP, CAD, AUD"
        });
      }
      user.currency = currency;
    }

    if (serviceCategories) {
      if (!Array.isArray(serviceCategories)) {
        return res.status(400).json({
          success: false,
          msg: "Service categories must be an array"
        });
      }
      const rawCountry = user.businessInfo?.country || businessInfo?.country || 'BE';
      const normalizedCountry = /^[A-Za-z]{2}$/.test(rawCountry)
        ? rawCountry.toUpperCase()
        : (getCountryCode(rawCountry) || 'BE');
      const activeConfigs = await ServiceConfiguration.find({
        isActive: true,
        activeCountries: normalizedCountry,
      }).select('service').lean();
      const validServices = new Set(activeConfigs.map((c: any) => c.service));
      const unknownCategories = serviceCategories.filter((s: string) => !validServices.has(s));
      if (unknownCategories.length > 0) {
        return res.status(400).json({
          success: false,
          msg: "One or more service categories are not available for your country",
          unknownCategories,
        });
      }
      user.serviceCategories = serviceCategories;
    }

    if (availability) {
      user.availability = {
        ...user.availability,
        ...availability
      };
    }

    if (blockedDates !== undefined) {
      if (!Array.isArray(blockedDates)) {
        return res.status(400).json({
          success: false,
          msg: "Blocked dates must be an array"
        });
      }
      user.blockedDates = blockedDates.map(item => {
        if (typeof item === 'string') {
          return { date: new Date(item) };
        } else {
          return {
            date: new Date(item.date),
            reason: item.reason || undefined
          };
        }
      });
    }
    if (blockedRanges !== undefined) {
      if (!Array.isArray(blockedRanges)) {
        return res.status(400).json({
          success: false,
          msg: "Blocked ranges must be an array"
        });
      }

      const validatedRanges = blockedRanges.map((range, index) => {
        if (!range.startDate || !range.endDate) {
          throw new Error('Start date and end date are required for blocked ranges');
        }

        const startDate = new Date(range.startDate);
        const endDate = new Date(range.endDate);

        if (startDate > endDate) {
          throw new Error('Start date must be before or equal to end date');
        }

        const processedRange = {
          startDate,
          endDate,
          reason: range.reason || undefined,
          createdAt: new Date()
        };
        return processedRange;
      });

      user.blockedRanges = validatedRanges;
    }

    // Handle company availability (for team members to inherit)
    if (companyAvailability) {
      user.companyAvailability = {
        ...user.companyAvailability,
        ...companyAvailability
      };
    }

    if (companyBlockedDates !== undefined) {
      console.log('📅 Received companyBlockedDates:', companyBlockedDates);
      if (!Array.isArray(companyBlockedDates)) {
        return res.status(400).json({
          success: false,
          msg: "Company blocked dates must be an array"
        });
      }
      user.companyBlockedDates = companyBlockedDates.map(item => {
        if (typeof item === 'string') {
          return { date: new Date(item), isHoliday: false };
        } else {
          return {
            date: new Date(item.date),
            reason: item.reason || undefined,
            isHoliday: item.isHoliday || false
          };
        }
      });
      console.log('✅ Mapped companyBlockedDates:', user.companyBlockedDates);
    }

    if (companyBlockedRanges !== undefined) {
      if (!Array.isArray(companyBlockedRanges)) {
        return res.status(400).json({
          success: false,
          msg: "Company blocked ranges must be an array"
        });
      }

      const validatedCompanyRanges = companyBlockedRanges.map((range) => {
        if (!range.startDate || !range.endDate) {
          throw new Error('Start date and end date are required for company blocked ranges');
        }

        const startDate = new Date(range.startDate);
        const endDate = new Date(range.endDate);

        if (startDate > endDate) {
          throw new Error('Start date must be before or equal to end date');
        }

        return {
          startDate,
          endDate,
          reason: range.reason || undefined,
          isHoliday: range.isHoliday || false,
          createdAt: new Date()
        };
      });

      user.companyBlockedRanges = validatedCompanyRanges;
    }

    if (onboardingAgreements !== undefined) {
      user.onboardingAgreements = normalizeOnboardingAgreements(onboardingAgreements) || undefined;
    }

    // Mark profile as completed if key fields are filled
    if (user.businessInfo?.companyName && user.username && user.hourlyRate != null && user.serviceCategories?.length) {
      user.profileCompletedAt = new Date();
    } else {
      user.profileCompletedAt = undefined;
    }

    try {
      await user.save();
    } catch (err: any) {
      if (err.code === 11000 && err.keyPattern?.username) {
        return res.status(400).json({ success: false, msg: "Username already taken" });
      }
      throw err;
    }

    console.log(`✅ Profile: Successfully updated professional profile for ${user.email}`);
    console.log('💾 Saved companyBlockedDates:', user.companyBlockedDates);
    console.log('💾 Saved companyBlockedRanges:', user.companyBlockedRanges);

    // Return updated user data (without password)
    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      isEmailVerified: user.isEmailVerified || false,
      isPhoneVerified: user.isPhoneVerified || false,
      vatNumber: user.vatNumber,
      isVatVerified: user.isVatVerified || false,
      idProofUrl: user.idProofUrl,
      idProofFileName: user.idProofFileName,
      idProofUploadedAt: user.idProofUploadedAt,
      isIdVerified: user.isIdVerified || false,
      username: user.username,
      businessInfo: user.businessInfo,
      hourlyRate: user.hourlyRate,
      currency: user.currency,
      serviceCategories: user.serviceCategories,
      availability: user.availability,
      blockedDates: user.blockedDates,
      blockedRanges: user.blockedRanges,
      companyAvailability: user.companyAvailability,
      companyBlockedDates: user.companyBlockedDates,
      companyBlockedRanges: user.companyBlockedRanges,
      onboardingAgreements: user.onboardingAgreements,
      profileCompletedAt: user.profileCompletedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(200).json({
      success: true,
      msg: "Professional profile updated successfully",
      user: userResponse
    });

  } catch (error: any) {
    console.error('Professional profile update error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update professional profile"
    });
  }
};

// Send profile for verification - PHASE 3 implementation
export const submitForVerification = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const normalizedAgreements = normalizeOnboardingAgreements(req.body?.onboardingAgreements);

    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Check if user is a professional
    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "Verification submission is only available for professionals"
      });
    }

    // Check current status
    if (user.professionalStatus === 'approved') {
      return res.status(400).json({
        success: false,
        msg: "Your profile is already approved"
      });
    }

    // If already pending, return success (e.g., after ID info change already triggered re-verification)
    if (user.professionalStatus === 'pending') {
      return res.status(200).json({
        success: true,
        msg: "Your profile is already pending verification. You will be notified within 48 hours.",
        data: {
          professionalStatus: user.professionalStatus,
          expectedReviewTime: "48 hours"
        }
      });
    }

    console.log(`🔍 PHASE 3: Checking verification requirements for ${user.email}`);

    if (normalizedAgreements) {
      user.onboardingAgreements = normalizedAgreements;
    }

    // Check minimum requirements for submission
    const missingRequirements: string[] = [];
    const missingRequirementDetails: Array<{ code: string; type: string; message: string }> = [];
    
    if (!user.vatNumber) {
      missingRequirements.push('VAT number');
      missingRequirementDetails.push({
        code: 'VAT_NUMBER_MISSING',
        type: 'vat',
        message: 'VAT number'
      });
    }
    
    if (!user.idProofUrl) {
      missingRequirements.push('ID proof upload');
      missingRequirementDetails.push({
        code: 'ID_PROOF_MISSING',
        type: 'id',
        message: 'ID proof upload'
      });
    }

    if (!user.stripe?.accountId || !user.stripe?.onboardingCompleted) {
      missingRequirements.push('Stripe integration');
      missingRequirementDetails.push({
        code: 'STRIPE_ONBOARDING_MISSING',
        type: 'stripe',
        message: 'Stripe onboarding must be completed'
      });
    }

    if (!user.username) {
      missingRequirements.push('Display username');
      missingRequirementDetails.push({
        code: 'USERNAME_MISSING',
        type: 'business',
        message: 'Display username'
      });
    }

    if (!user.businessInfo?.companyName) {
      missingRequirements.push('Company name');
      missingRequirementDetails.push({
        code: 'COMPANY_NAME_MISSING',
        type: 'business',
        message: 'Company name'
      });
    }

    if (!user.businessInfo?.address || !user.businessInfo?.city || !user.businessInfo?.country || !user.businessInfo?.postalCode) {
      missingRequirements.push('Company address');
      missingRequirementDetails.push({
        code: 'COMPANY_ADDRESS_MISSING',
        type: 'business',
        message: 'Company address'
      });
    }

    if (!user.idCountryOfIssue) {
      missingRequirements.push('ID country of issue');
      missingRequirementDetails.push({
        code: 'ID_COUNTRY_OF_ISSUE_MISSING',
        type: 'id',
        message: 'ID country of issue'
      });
    }

    if (!user.idExpirationDate) {
      missingRequirements.push('ID expiration date');
      missingRequirementDetails.push({
        code: 'ID_EXPIRATION_DATE_MISSING',
        type: 'id',
        message: 'ID expiration date'
      });
    } else if (user.idExpirationDate <= new Date()) {
      missingRequirements.push('ID expiration date (must be in the future)');
      missingRequirementDetails.push({
        code: 'ID_EXPIRATION_DATE_INVALID',
        type: 'id',
        message: 'ID expiration date (must be in the future)'
      });
    }

    const companyAvailability = user.companyAvailability || {};
    const hasCompanyDayAvailable = Object.values(companyAvailability).some((day: any) => day?.available);
    if (!hasCompanyDayAvailable) {
      missingRequirements.push('Company availability (at least one available day)');
      missingRequirementDetails.push({
        code: 'COMPANY_AVAILABILITY_MISSING',
        type: 'availability',
        message: 'Company availability (at least one available day)'
      });
    }

    if (
      !user.onboardingAgreements?.rulesAccepted ||
      !user.onboardingAgreements?.termsAccepted ||
      !user.onboardingAgreements?.selfBillingAccepted
    ) {
      missingRequirements.push('Required platform agreements');
      missingRequirementDetails.push({
        code: 'AGREEMENTS_MISSING',
        type: 'agreements',
        message: 'Required platform agreements'
      });
    }

    if (missingRequirements.length > 0) {
      return res.status(400).json({
        success: false,
        msg: `Cannot submit for verification. Please complete: ${missingRequirements.join(', ')}`,
        data: {
          missingRequirements,
          missingRequirementDetails,
          hasVat: !!user.vatNumber,
          hasIdProof: !!user.idProofUrl,
          hasCompanyName: !!user.businessInfo?.companyName
        }
      });
    }

    // Update status to pending and mark onboarding complete
    user.professionalStatus = 'pending';
    user.rejectionReason = undefined; 
    if (!user.professionalOnboardingCompletedAt) {
      user.professionalOnboardingCompletedAt = new Date();
    }
    await user.save();

    try {
      await sendProfessionalWelcomeEmail(user.email, user.name);
    } catch (emailError) {
      console.error('Failed to send professional welcome email:', emailError);
    }

    return res.status(200).json({
      success: true,
      msg: "Thanks for submitting. Your profile will be checked within 48 hours.",
      data: {
        professionalStatus: user.professionalStatus,
        submittedAt: new Date(),
        expectedReviewTime: "48 hours"
      }
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      msg: "Failed to submit profile for verification"
    });
  }
};

// Update phone number
export const updatePhone = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPhone = req.body.phone;
    const phone = typeof rawPhone === 'string' ? rawPhone.trim() : String(rawPhone || '').trim();

    if (!phone) {
      return res.status(400).json({
        success: false,
        msg: "Phone number is required"
      });
    }

    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Only allow customer, professional, and employee roles
    if (!['customer', 'professional', 'employee'].includes(user.role)) {
      return res.status(403).json({
        success: false,
        msg: "Phone update is not available for this role"
      });
    }

    // Determine default region for phone parsing (needs 2-letter ISO code)
    const rawCountry = user.businessInfo?.country || user.location?.country;
    const defaultRegion = rawCountry
      ? (rawCountry.length === 2 ? rawCountry.toUpperCase() : getCountryCode(rawCountry))
      : undefined;

    // Normalize and validate phone using google-libphonenumber
    let normalizedPhone: string;
    try {
      let number;
      if (phone.startsWith('+')) {
        // International format — parse directly, no region needed
        number = phoneUtil.parseAndKeepRawInput(phone, '');
      } else if (defaultRegion) {
        // Local format with known region
        number = phoneUtil.parseAndKeepRawInput(phone, defaultRegion);
      } else {
        // Fallback: `defaultRegion` is undefined and `phone` doesn't start with '+'.
        // Auto-prefix '+' so phoneUtil.parseAndKeepRawInput can attempt E.164 parsing.
        // This means digit-only input like "12125551234" becomes "+12125551234" and may
        // resolve to a valid PhoneNumberFormat.E164 number — convenient for users who
        // omit the '+', but could also silently accept unintended country-code combos.
        number = phoneUtil.parseAndKeepRawInput('+' + phone, '');
      }

      if (!phoneUtil.isValidNumber(number)) {
        return res.status(400).json({
          success: false,
          msg: "Invalid phone number. Please include your country code (e.g. +1 for US, +31 for NL)."
        });
      }

      normalizedPhone = phoneUtil.format(number, PhoneNumberFormat.E164);
    } catch (error) {
      return res.status(400).json({
        success: false,
        msg: "Invalid phone number. Please include your country code (e.g. +1 for US, +31 for NL)."
      });
    }

    // Check if same as current
    if (user.phone === normalizedPhone) {
      return res.status(400).json({
        success: false,
        msg: "New phone number is the same as the current one"
      });
    }

    // Check uniqueness
    const existingUser = await User.findOne({ phone: normalizedPhone, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        msg: "This phone number is already in use by another account"
      });
    }

    user.phone = normalizedPhone;
    user.isPhoneVerified = false;

    try {
      await user.save();
    } catch (error: any) {
      // Handle concurrent duplicate key error
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          msg: "This phone number is already in use"
        });
      }
      throw error;
    }

    console.log(`📱 Phone: Updated phone for userId=${String(user._id)}`);

    return res.status(200).json({
      success: true,
      msg: "Phone number updated successfully. Please verify your new phone number.",
      data: {
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified
      }
    });

  } catch (error: any) {
    console.error('Update phone error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update phone number"
    });
  }
};

// Update customer profile (address, business name for business customers)
export const updateCustomerProfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address, city, country, postalCode, businessName, customerType, companyAddress } = req.body;
    const trimmedAddress = typeof address === 'string' ? address.trim() : undefined;
    const trimmedCity = typeof city === 'string' ? city.trim() : undefined;
    const trimmedCountry = typeof country === 'string' ? country.trim() : undefined;
    const trimmedPostalCode = typeof postalCode === 'string' ? postalCode.trim() : undefined;
    const trimmedBusinessName = typeof businessName === 'string' ? businessName.trim() : undefined;

    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    if (user.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "Customer profile updates are only available for customers"
      });
    }

    // Update customer type if provided
    // Update customer type if provided
    if (customerType) {
      if (!['individual', 'business'].includes(customerType)) {
        return res.status(400).json({
          success: false,
          msg: "Invalid customer type. Must be 'individual' or 'business'"
        });
      }
      user.customerType = customerType;
    }

    const hasLocationField = [trimmedAddress, trimmedCity, trimmedCountry, trimmedPostalCode]
      .some((value) => value !== undefined);

    if (hasLocationField) {
      // Update location fields
      if (!user.location) {
        user.location = {
          type: 'Point',
          coordinates: [0, 0]
        };
      } else if (!user.location.coordinates || user.location.coordinates.length !== 2) {
        user.location.coordinates = [0, 0];
      }

      if (trimmedAddress !== undefined) user.location.address = trimmedAddress;
      if (trimmedCity !== undefined) user.location.city = trimmedCity;
      if (trimmedCountry !== undefined) user.location.country = trimmedCountry;
      if (trimmedPostalCode !== undefined) user.location.postalCode = trimmedPostalCode;
    }

    // Business name only for business customers or if switching to business
    if (user.customerType === 'business') {
      if (trimmedBusinessName !== undefined) {
        user.businessName = trimmedBusinessName.length > 0 ? trimmedBusinessName : undefined;
      }

      // Update company address for business customers
      if (companyAddress && typeof companyAddress === 'object') {
        if (!user.companyAddress) {
          user.companyAddress = {};
        }
        if (typeof companyAddress.address === 'string') {
          user.companyAddress.address = companyAddress.address.trim() || undefined;
        }
        if (typeof companyAddress.city === 'string') {
          user.companyAddress.city = companyAddress.city.trim() || undefined;
        }
        if (typeof companyAddress.country === 'string') {
          user.companyAddress.country = companyAddress.country.trim() || undefined;
        }
        if (typeof companyAddress.postalCode === 'string') {
          user.companyAddress.postalCode = companyAddress.postalCode.trim() || undefined;
        }
      }
    } else if (customerType && customerType !== 'business') {
      // If switching to individual, clear business fields
      user.businessName = undefined;
      user.companyAddress = undefined;
      // We might also want to clear VAT if it was set, but that's handled separately or via another call?
      // For now, let's keep VAT separate as it has its own verification logic, but frontend should hide it.
      // Actually, per requirements "in case of business customer also VAT and business name",
      // implying non-business customers shouldn't have them.
      // User model pre-save hook handles clearing businessName if not business customer.
    }

    // Company address only for business customers
    if (companyAddress && typeof companyAddress === 'object' && user.customerType === 'business') {
      if (!user.companyAddress) {
        user.companyAddress = {};
      }
      if (typeof companyAddress.address === 'string') user.companyAddress.address = companyAddress.address.trim();
      if (typeof companyAddress.city === 'string') user.companyAddress.city = companyAddress.city.trim();
      if (typeof companyAddress.country === 'string') user.companyAddress.country = companyAddress.country.trim();
      if (typeof companyAddress.postalCode === 'string') user.companyAddress.postalCode = companyAddress.postalCode.trim();
    }

    await user.save();

    console.log(`🏠 Customer Profile: Updated for ${String(user._id)}`);
    return res.status(200).json({
      success: true,
      msg: "Customer profile updated successfully",
      data: {
        location: user.location,
        businessName: user.businessName,
        companyAddress: user.companyAddress,
        customerType: user.customerType
      }
    });

  } catch (error: any) {
    console.error('Update customer profile error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update customer profile"
    });
  }
};

// Update ID information (triggers re-verification for professionals)
export const updateIdInfo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { idCountryOfIssue, idExpirationDate } = req.body;
    const normalizedIdCountryOfIssue = typeof idCountryOfIssue === 'string' ? idCountryOfIssue.trim() : undefined;

    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "ID info updates are only available for professionals"
      });
    }

    // Track changes for admin review
    const changes: { field: string; oldValue: string; newValue: string }[] = [];

    if (normalizedIdCountryOfIssue !== undefined && normalizedIdCountryOfIssue !== (user.idCountryOfIssue || '')) {
      changes.push({
        field: 'idCountryOfIssue',
        oldValue: user.idCountryOfIssue || NO_PREVIOUS_VALUE,
        newValue: normalizedIdCountryOfIssue
      });
    }

    let parsedExpirationDate: Date | undefined;
    let newDate = '';
    if (idExpirationDate !== undefined) {
      parsedExpirationDate = new Date(idExpirationDate);
      if (Number.isNaN(parsedExpirationDate.getTime())) {
        return res.status(400).json({
          success: false,
          msg: "Invalid ID expiration date"
        });
      }
      newDate = parsedExpirationDate.toISOString().split('T')[0];
      const oldDate = user.idExpirationDate ? new Date(user.idExpirationDate).toISOString().split('T')[0] : '';
      if (oldDate !== newDate) {
        changes.push({
          field: 'idExpirationDate',
          oldValue: oldDate || NO_PREVIOUS_VALUE,
          newValue: newDate
        });
      }
    }

    if (changes.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "No changes detected"
      });
    }

    // Apply changes
    if (normalizedIdCountryOfIssue !== undefined) user.idCountryOfIssue = normalizedIdCountryOfIssue;
    if (idExpirationDate !== undefined && parsedExpirationDate) {
      user.idExpirationDate = parsedExpirationDate;
    }

    // Store pending changes for admin review
    // Clean any existing entries with empty oldValue to avoid Mongoose validation errors
    const existingChanges = normalizePendingIdChanges(user.pendingIdChanges) || [];
    user.pendingIdChanges = normalizePendingIdChanges([...existingChanges, ...changes]);
    user.markModified('pendingIdChanges');

    // Trigger re-verification only if already approved
    const wasApproved = user.professionalStatus === 'approved';
    const shouldSetPending = user.professionalStatus === 'approved' || user.professionalStatus === 'pending';
    if (shouldSetPending) {
      user.professionalStatus = 'pending';
      user.isIdVerified = false;
      user.rejectionReason = undefined;
    }

    // Any ID info update should allow future expiry reminders for the new data
    user.idExpiryEmailSentAt = undefined;

    await user.save({ validateModifiedOnly: true });

    const changedFields = changes.map((change) => change.field);
    console.log(`🔄 ID Info: Updated for userId=${String(user._id)}. Fields: ${changedFields.join(', ')}`);

    return res.status(200).json({
      success: true,
      msg: shouldSetPending
        ? (wasApproved
          ? "ID information updated. Your professional status has been set to pending for re-verification."
          : "ID information updated. Your profile is pending verification.")
        : "ID information updated.",
      data: {
        changes,
        professionalStatus: user.professionalStatus,
        isIdVerified: user.isIdVerified
      }
    });

  } catch (error: any) {
    console.error('Update ID info error:', error);
    if (error?.name === 'ValidationError') {
      console.error('Validation details:', JSON.stringify(error.errors, null, 2));
    }
    return res.status(500).json({
      success: false,
      msg: "Internal server error"
    });
  }
};

export const uploadProfileImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();

    const userId = req.user?.id || (req.user as any)?._id?.toString();
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, msg: "No image file provided" });
    }

    const validation = await validateImageFileBuffer(file);
    if (!validation.valid) {
      return res.status(400).json({ success: false, msg: validation.error });
    }

    if (validation.detectedMime) {
      file.mimetype = validation.detectedMime;
    }

    const oldProfileImage = user.profileImage;

    const fileName = generateFileName(file.originalname, user._id.toString(), 'profile-images');
    const result = await uploadToS3(file, fileName);

    user.profileImage = result.url;
    await user.save();

    if (oldProfileImage) {
      const oldKey = parseS3KeyFromUrl(oldProfileImage);
      if (oldKey) {
        try { await deleteFromS3(oldKey); } catch (err) {
          console.error("Failed to delete old profile image from S3:", { key: oldKey, userId, error: err });
        }
      }
    }

    return res.status(200).json({
      success: true,
      msg: "Profile image updated",
      data: { profileImage: result.url }
    });
  } catch (error) {
    console.error("Upload profile image error:", error);
    return res.status(500).json({ success: false, msg: "Failed to upload profile image" });
  }
};

export const deleteProfileImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();

    const userId = req.user?.id || (req.user as any)?._id?.toString();
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.profileImage) {
      const oldKey = parseS3KeyFromUrl(user.profileImage);
      if (oldKey) {
        try { await deleteFromS3(oldKey); } catch (err) {
          console.error("Failed to delete old profile image from S3:", { key: oldKey, userId, error: err });
        }
      }
      user.profileImage = undefined;
      await user.save();
    }

    return res.status(200).json({ success: true, msg: "Profile image removed" });
  } catch (error) {
    console.error("Delete profile image error:", error);
    return res.status(500).json({ success: false, msg: "Failed to remove profile image" });
  }
};

export const checkUsernameAvailability = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const { username } = params(req.params);
    if (!username) {
      return res.status(400).json({ success: false, available: false, reason: "Username is required" });
    }

    const formatCheck = isValidUsernameFormat(username.toLowerCase());
    if (!formatCheck.valid) {
      return res.status(200).json({ success: true, available: false, reason: formatCheck.reason });
    }

    const existing = await User.findOne({ username: username.toLowerCase(), _id: { $ne: userId } });
    if (existing) {
      return res.status(200).json({ success: true, available: false, reason: "Username already taken" });
    }

    const user = await User.findById(userId);
    if (user?.role === 'professional' && user.businessInfo?.companyName) {
      if (isTooSimilarToCompanyName(username.toLowerCase(), user.businessInfo.companyName)) {
        return res.status(200).json({
          success: true,
          available: false,
          reason: "Username cannot be too similar to your company name"
        });
      }
    }

    return res.status(200).json({ success: true, available: true });
  } catch (error) {
    console.error("Check username error:", error);
    return res.status(500).json({ success: false, msg: "Failed to check username availability" });
  }
};

export const generateUsernameSuggestionsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const user = await User.findById(userId);
    if (!user || user.role !== 'professional') {
      return res.status(403).json({ success: false, msg: "Only professionals can generate username suggestions" });
    }

    const rawCompanyName = Array.isArray(req.query.companyName) ? req.query.companyName[0] : req.query.companyName;
    const rawCity = Array.isArray(req.query.city) ? req.query.city[0] : req.query.city;
    const companyName = (typeof rawCompanyName === "string" && rawCompanyName.trim()) || user.businessInfo?.companyName;
    const city = (typeof rawCity === "string" && rawCity.trim()) || user.businessInfo?.city;

    if (!companyName) {
      return res.status(400).json({ success: false, msg: "Company name is required to generate a username" });
    }

    const rawSuggestions = generateUsernameSuggestions(companyName, city);

    const available: string[] = [];
    for (const suggestion of rawSuggestions) {
      if (isTooSimilarToCompanyName(suggestion, companyName)) {
        continue;
      }

      let candidate = suggestion;
      let suffix = 1;
      while (await User.findOne({ username: candidate, _id: { $ne: user._id } })) {
        candidate = `${suggestion}-${suffix}`;
        if (isTooSimilarToCompanyName(candidate, companyName)) {
          break;
        }
        suffix++;
        if (suffix > 10) break;
      }
      if (suffix <= 10) available.push(candidate);
    }

    if (available.length === 0) {
      const fallback = `pro-${user._id.toString().slice(-6)}`;
      available.push(fallback);
    }

    return res.status(200).json({ success: true, suggestions: available });
  } catch (error) {
    console.error("Generate username suggestions error:", error);
    return res.status(500).json({ success: false, msg: "Failed to generate username suggestions" });
  }
};

export const updateUsername = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const user = await User.findById(userId);
    if (!user || user.role !== 'professional') {
      return res.status(403).json({ success: false, msg: "Only professionals can set a username" });
    }

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, msg: "Username is required" });
    }

    const normalized = username.toLowerCase().trim();
    const formatCheck = isValidUsernameFormat(normalized);
    if (!formatCheck.valid) {
      return res.status(400).json({ success: false, msg: formatCheck.reason });
    }

    const existing = await User.findOne({ username: normalized, _id: { $ne: user._id } });
    if (existing) {
      return res.status(400).json({ success: false, msg: "Username already taken" });
    }

    if (user.businessInfo?.companyName && isTooSimilarToCompanyName(normalized, user.businessInfo.companyName)) {
      return res.status(400).json({ success: false, msg: "Username cannot be too similar to your company name" });
    }

    user.username = normalized;
    try {
      await user.save();
    } catch (err: any) {
      if (err.code === 11000) {
        return res.status(400).json({ success: false, msg: "Username was just taken by someone else, please try another" });
      }
      throw err;
    }

    return res.status(200).json({
      success: true,
      msg: "Username updated successfully",
      username: user.username
    });
  } catch (error) {
    console.error("Update username error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update username" });
  }
};
