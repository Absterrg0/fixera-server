import mongoose from 'mongoose';
import User from '../../models/user';
import BacklinkConfig from '../../models/backlinkConfig';
import BacklinkSubmission, { IBacklinkSubmission } from '../../models/backlinkSubmission';
import { addPoints, deductPoints } from '../pointsSystem';
import {
  notifyAdminApproved,
  notifyAdminRejected,
  notifyRevoked,
} from './notifications';
import { rewardPointsForRole } from './rewards';
import { BacklinkError } from './errors';
import { scheduleVerification } from './verifySubmission';

const LOG_PREFIX = '[backlink]';

export async function adminApproveSubmission(
  submissionId: mongoose.Types.ObjectId,
  adminId: mongoose.Types.ObjectId,
): Promise<IBacklinkSubmission> {
  const config = await BacklinkConfig.getCurrentConfig();
  const preClaim = await BacklinkSubmission.findOne({
    _id: submissionId,
    status: { $in: ['pending_verification', 'rejected'] },
  }).select('userId domain submittedUrl rewardPoints pointTransactionId');

  if (!preClaim) {
    const existing = await BacklinkSubmission.findById(submissionId).select('status');
    if (!existing) throw new BacklinkError('Submission not found', 404);
    if (existing.status === 'verified') {
      throw new BacklinkError('Submission is already verified', 400);
    }
    if (existing.status === 'revoked') {
      throw new BacklinkError('Cannot approve a revoked submission', 400);
    }
    if (existing.status === 'verifying') {
      throw new BacklinkError('Submission is being verified — wait for crawl to finish', 409);
    }
    throw new BacklinkError('Submission not found or already processed', 400);
  }

  const user = await User.findById(preClaim.userId).select('role');
  if (!user) throw new BacklinkError('Submitting user not found', 404);

  const rewardPoints = rewardPointsForRole(config, user.role);

  const submission = await BacklinkSubmission.findOneAndUpdate(
    { _id: submissionId, status: { $in: ['pending_verification', 'rejected'] } },
    {
      $set: {
        status: 'verified',
        verificationMethod: 'manual',
        rewardPoints,
        rewardIssuedAt: new Date(),
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectionReason: undefined,
        adminReviewReason: undefined,
      },
    },
    { new: true },
  );

  if (!submission) throw new BacklinkError('Submission not found or already processed', 400);

  if (rewardPoints > 0 && !submission.pointTransactionId) {
    try {
      const { transaction } = await addPoints(
        submission.userId,
        rewardPoints,
        'backlink',
        `Backlink reward: manually approved link on ${submission.domain}`,
        {
          metadata: {
            backlinkSubmissionId: submission._id.toString(),
            submittedUrl: submission.submittedUrl,
            approvedBy: adminId.toString(),
          },
        },
      );

      const updated = await BacklinkSubmission.findByIdAndUpdate(
        submissionId,
        { $set: { pointTransactionId: transaction._id } },
        { new: true },
      );

      notifyAdminApproved(
        submission.userId,
        submission._id,
        submission.domain,
        rewardPoints,
      );

      return updated!;
    } catch (err) {
      console.error(`${LOG_PREFIX} addPoints failed during admin approve of ${submissionId}:`, err);
      const updated = await BacklinkSubmission.findByIdAndUpdate(
        submissionId,
        {
          $set: {
            adminReviewReason: 'Points award failed — pending admin review',
          },
        },
        { new: true },
      );
      return updated!;
    }
  }

  notifyAdminApproved(
    submission.userId,
    submission._id,
    submission.domain,
    rewardPoints,
  );

  return submission;
}

export async function adminRejectSubmission(
  submissionId: mongoose.Types.ObjectId,
  adminId: mongoose.Types.ObjectId,
  reason: string,
): Promise<IBacklinkSubmission> {
  const updated = await BacklinkSubmission.findOneAndUpdate(
    { _id: submissionId, status: { $nin: ['verified', 'verifying'] } },
    {
      $set: {
        status: 'rejected',
        rejectionReason: reason,
        lastRejectedAt: new Date(),
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    },
    { new: true },
  );

  if (updated) {
    notifyAdminRejected(updated.userId, updated._id, updated.domain, reason);
    return updated;
  }

  const existing = await BacklinkSubmission.findById(submissionId).select('status');
  if (!existing) throw new BacklinkError('Submission not found', 404);
  if (existing.status === 'verified') {
    throw new BacklinkError('Use revoke to retract a verified submission', 400);
  }
  if (existing.status === 'verifying') {
    throw new BacklinkError('Submission is being verified — wait for crawl to finish', 409);
  }
  throw new BacklinkError('Submission not found or already processed', 400);
}

export async function adminRevokeSubmission(
  submissionId: mongoose.Types.ObjectId,
  adminId: mongoose.Types.ObjectId,
  reason: string,
): Promise<IBacklinkSubmission> {
  const submission = await BacklinkSubmission.findById(submissionId);
  if (!submission) throw new BacklinkError('Submission not found', 404);

  if (submission.status !== 'verified') {
    throw new BacklinkError('Only verified submissions can be revoked', 400);
  }

  const pointsToClawBack = submission.rewardPoints ?? 0;
  let actuallyDeducted = 0;
  let unclawedPoints = 0;

  if (pointsToClawBack > 0) {
    const user = await User.findById(submission.userId).select('points');
    const currentBalance = user?.points ?? 0;
    actuallyDeducted = Math.min(pointsToClawBack, currentBalance);
    unclawedPoints = pointsToClawBack - actuallyDeducted;

    if (actuallyDeducted > 0) {
      try {
        await deductPoints(
          submission.userId,
          actuallyDeducted,
          'admin-adjustment',
          `Backlink reward revoked for ${submission.domain}: ${reason}`,
          {
            metadata: {
              backlinkSubmissionId: submission._id.toString(),
              revokedBy: adminId.toString(),
              originalReward: pointsToClawBack,
              unclawedPoints,
            },
          },
        );
      } catch (err) {
        console.error(
          `${LOG_PREFIX} deductPoints failed during revoke of ${submissionId}:`,
          err,
        );
        unclawedPoints = pointsToClawBack;
        actuallyDeducted = 0;
      }
    }
  }

  const updated = await BacklinkSubmission.findByIdAndUpdate(
    submissionId,
    {
      $set: {
        status: 'revoked',
        revokedReason: reason,
        revokedAt: new Date(),
        revokedBy: adminId,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        unclawedPoints: unclawedPoints > 0 ? unclawedPoints : undefined,
      },
    },
    { new: true },
  );

  notifyRevoked(
    submission.userId,
    submission._id,
    submission.domain,
    pointsToClawBack,
    actuallyDeducted,
    unclawedPoints,
  );

  return updated!;
}

export async function adminReprocessSubmission(
  submissionId: mongoose.Types.ObjectId,
): Promise<void> {
  const submission = await BacklinkSubmission.findById(submissionId);
  if (!submission) throw new BacklinkError('Submission not found', 404);

  if (submission.status === 'verified') {
    throw new BacklinkError('Submission is already verified', 400);
  }
  if (submission.status === 'revoked') {
    throw new BacklinkError('Cannot reprocess a revoked submission', 400);
  }
  if (submission.status === 'verifying') {
    throw new BacklinkError('Submission is being verified — wait for crawl to finish', 409);
  }

  await BacklinkSubmission.findByIdAndUpdate(submissionId, {
    $set: {
      status: 'pending_verification',
      rejectionReason: undefined,
      adminReviewReason: undefined,
      lastRejectedAt: undefined,
    },
  });

  scheduleVerification(submissionId);
}
