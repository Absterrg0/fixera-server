import mongoose from 'mongoose';
import User from '../../models/user';
import BacklinkSubmission from '../../models/backlinkSubmission';
import type { IBacklinkConfig } from '../../models/backlinkConfig';

export type EligibilityResult = {
  allowed: boolean;
  reason?: string;
  httpStatus?: number;
  cooldownExpiresAt?: Date;
};

export async function canUserSubmit(
  userId: mongoose.Types.ObjectId,
  config: IBacklinkConfig,
): Promise<EligibilityResult> {
  if (!config.isEnabled) {
    return {
      allowed: false,
      reason: 'The backlink rewards program is currently disabled',
      httpStatus: 403,
    };
  }

  const user = await User.findById(userId).select('role');
  if (!user) {
    return { allowed: false, reason: 'User not found', httpStatus: 404 };
  }

  if (!['customer', 'professional'].includes(user.role)) {
    return {
      allowed: false,
      reason: 'Only customers and professionals can submit backlinks',
      httpStatus: 403,
    };
  }

  return { allowed: true };
}

/** Global dedup for active URLs + per-user resubmit cooldown after rejection. */
export async function canSubmitUrl(
  normalizedUrl: string,
  userId: mongoose.Types.ObjectId,
  config: IBacklinkConfig,
): Promise<EligibilityResult> {
  const activeExisting = await BacklinkSubmission.findOne({
    normalizedUrl,
    status: { $in: ['pending_verification', 'verifying', 'verified'] },
  }).select('_id status');

  if (activeExisting) {
    if (activeExisting.status === 'verified') {
      return {
        allowed: false,
        reason: 'This URL has already been verified and rewarded',
        httpStatus: 409,
      };
    }
    return {
      allowed: false,
      reason: 'This URL is already pending verification',
      httpStatus: 409,
    };
  }

  if (config.resubmitCooldownHours > 0) {
    // Cooldown is scoped to the submitting user — other users may submit the same URL immediately.
    const lastRejection = await BacklinkSubmission.findOne({
      normalizedUrl,
      userId,
      status: 'rejected',
      lastRejectedAt: { $exists: true },
    })
      .sort({ lastRejectedAt: -1 })
      .select('lastRejectedAt');

    if (lastRejection?.lastRejectedAt) {
      const cooldownMs = config.resubmitCooldownHours * 60 * 60 * 1000;
      const cooldownExpiresAt = new Date(
        lastRejection.lastRejectedAt.getTime() + cooldownMs,
      );

      if (cooldownExpiresAt > new Date()) {
        return {
          allowed: false,
          reason: `This URL was recently rejected. You can resubmit after ${cooldownExpiresAt.toISOString()}`,
          httpStatus: 429,
          cooldownExpiresAt,
        };
      }
    }
  }

  return { allowed: true };
}
