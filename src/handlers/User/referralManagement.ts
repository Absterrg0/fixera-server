import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import User from '../../models/user';
import Referral from '../../models/referral';
import ReferralConfig from '../../models/referralConfig';
import PointsConfig from '../../models/pointsConfig';
import { generateReferralCode, getUserReferralStats, validateReferralCode, createReferral } from '../../utils/referralSystem';
import { params } from '../../utils/requestParams';

/**
 * GET /api/user/referral/stats
 * Get current user's referral stats for dashboard
 */
export const getReferralStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const [config, pointsConfig, stats, user] = await Promise.all([
      ReferralConfig.getCurrentConfig(),
      PointsConfig.getCurrentConfig(),
      getUserReferralStats(userId),
      User.findById(userId).select('role'),
    ]);

    if (!stats) {
      return res.status(404).json({ success: false, msg: 'User not found' });
    }

    const referrerRewardAmount = user?.role === 'professional'
      ? config.referrerProfessionalRewardAmount
      : config.referrerCustomerRewardAmount;
    const referrerRewardType = user?.role === 'professional'
      ? 'professional_level_boost'
      : 'customer_credit';

    return res.status(200).json({
      success: true,
      data: {
        ...stats,
        programEnabled: config.isEnabled,
        referrerRewardAmount,
        referrerRewardType,
        referredCustomerDiscountType: config.referredCustomerDiscountType,
        referredCustomerDiscountValue: config.referredCustomerDiscountValue,
        referredCustomerDiscountMaxAmount: config.referredCustomerDiscountMaxAmount,
        conversionRate: pointsConfig.conversionRate,
      }
    });
  } catch (error) {
    console.error('Get referral stats error:', error);
    next(error);
  }
};

/**
 * POST /api/user/referral/generate-code
 * Generate referral code for user (if they don't have one yet)
 */
export const generateUserReferralCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: 'User not found' });
    }

    if (!['customer', 'professional'].includes(user.role)) {
      return res.status(403).json({ success: false, msg: 'Referral codes are only available for customers and professionals' });
    }

    if (user.referralCode) {
      return res.status(200).json({
        success: true,
        msg: 'Referral code already exists',
        data: { referralCode: user.referralCode }
      });
    }

    const code = await generateReferralCode(user.name);
    user.referralCode = code;
    await user.save();

    return res.status(200).json({
      success: true,
      msg: 'Referral code generated',
      data: { referralCode: code }
    });
  } catch (error) {
    console.error('Generate referral code error:', error);
    next(error);
  }
};

/**
 * POST /api/user/referral/add-late-code
 * Allow adding a referral code within 48 hours of signup (before first booking)
 */
export const addLateReferralCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    const { referralCode } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    if (!referralCode) {
      return res.status(400).json({ success: false, msg: 'Referral code is required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: 'User not found' });
    }

    // Check if already referred
    if (user.referredBy) {
      return res.status(400).json({ success: false, msg: 'You have already been referred' });
    }

    // Check 48-hour window
    const hoursSinceSignup = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceSignup > 48) {
      return res.status(400).json({ success: false, msg: 'Referral code can only be added within 48 hours of sign-up' });
    }

    // Validate the code
    const validation = await validateReferralCode(referralCode);
    if (!validation.valid) {
      return res.status(400).json({ success: false, msg: validation.error });
    }

    // Prevent self-referral
    if (validation.referrer._id.toString() === userId.toString()) {
      return res.status(400).json({ success: false, msg: 'You cannot use your own referral code' });
    }

    // Use a transaction to atomically link referral and create record
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        user.referredBy = validation.referrer._id;
        await user.save({ session });

        const forwardedFor = req.headers['x-forwarded-for']?.toString();
        const ipAddress = (forwardedFor ? forwardedFor.split(',')[0].trim() : '') || req.ip;
        await createReferral(validation.referrer._id, userId, referralCode, ipAddress, session);
      });
    } finally {
      await session.endSession();
    }

    return res.status(200).json({
      success: true,
      msg: 'Referral code applied successfully'
    });
  } catch (error) {
    console.error('Add late referral code error:', error);
    next(error);
  }
};

/**
 * GET /api/public/referral/validate/:code
 * Validate a referral code (public, used during signup)
 */
export const validateReferralCodePublic = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = params(req.params);

    const validation = await validateReferralCode(code);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        msg: validation.error
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        valid: true,
        referrerName: validation.referrer.name
      }
    });
  } catch (error) {
    console.error('Validate referral code error:', error);
    next(error);
  }
};
