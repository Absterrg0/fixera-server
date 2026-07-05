import mongoose from 'mongoose';
import User from '../../models/user';
import BacklinkConfig from '../../models/backlinkConfig';
import BacklinkSubmission from '../../models/backlinkSubmission';
import { rewardPointsForRole } from './rewards';
import { BACKLINK_SUBMISSION_PUBLIC_FIELDS } from './constants';

/** Aggregate backlink stats for the benefits dashboard. */
export async function getUserBacklinkStats(userId: mongoose.Types.ObjectId) {
  const [config, user, submissions, verifiedCount, pointsAgg] = await Promise.all([
    BacklinkConfig.getCurrentConfig(),
    User.findById(userId).select('role'),
    BacklinkSubmission.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select(BACKLINK_SUBMISSION_PUBLIC_FIELDS),
    BacklinkSubmission.countDocuments({ userId, status: 'verified' }),
    BacklinkSubmission.aggregate([
      { $match: { userId, status: 'verified' } },
      { $group: { _id: null, total: { $sum: '$rewardPoints' } } },
    ]),
  ]);

  const totalPointsEarned = pointsAgg[0]?.total ?? 0;

  const rewardPoints = user
    ? rewardPointsForRole(config, user.role)
    : config.customerRewardPoints;

  return {
    programEnabled: config.isEnabled,
    rewardPoints,
    resubmitCooldownHours: config.resubmitCooldownHours,
    verifiedCount,
    totalPointsEarned,
    submissions,
  };
}
