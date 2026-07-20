import mongoose from 'mongoose';
import User from '../models/user';
import Booking from '../models/booking';
import PointTransaction from '../models/pointTransaction';
import ProfessionalLevelConfig, { ProfessionalLevelName } from '../models/professionalLevelConfig';
import { deductPoints } from './pointsSystem';

const PROFESSIONAL_LEVEL_RANK: Record<ProfessionalLevelName, number> = {
  New: 0,
  'Level 1': 1,
  'Level 2': 2,
  'Level 3': 3,
  Expert: 4,
};

async function isProfessionalLevelUpgrade(
  oldLevel: string,
  newLevel: string,
  _opts?: { session?: mongoose.ClientSession },
): Promise<boolean> {
  const oldRank = PROFESSIONAL_LEVEL_RANK[oldLevel as ProfessionalLevelName];
  const newRank = PROFESSIONAL_LEVEL_RANK[newLevel as ProfessionalLevelName];
  if (oldRank === undefined || newRank === undefined) {
    // Unknown custom names: treat change as upgrade only when different and new isn't "New"
    return oldLevel !== newLevel && newLevel !== 'New';
  }
  return newRank > oldRank;
}

export interface ProfessionalMetrics {
  completedBookings: number;
  daysActive: number;
  avgRating: number;
  onTimePercentage: number;
  responseRate: number;
  boostedBookings: number; // extra booking credits from points-to-booking conversion
}

export interface ProfessionalLevelInfo {
  currentLevel: ProfessionalLevelName;
  metrics: ProfessionalMetrics;
  effectiveBookings: number; // completedBookings + boostedBookings
  nextLevel?: {
    name: ProfessionalLevelName;
    missingCriteria: string[];
    progress: number; // percentage toward next level
  };
  perks: {
    badge: string;
    commissionReduction: number;
    searchRankingBoost: number;
  };
  color: string;
  icon: string;
}

/**
 * Gather performance metrics for a professional from their bookings.
 */
export const getProfessionalMetrics = async (
  professionalId: mongoose.Types.ObjectId | string,
  opts?: { session?: mongoose.ClientSession }
): Promise<ProfessionalMetrics> => {
  const findOpts = opts?.session ? { session: opts.session } : {};
  const user = await User.findById(professionalId, null, findOpts).select('createdAt');
  if (!user) {
    throw new Error('Professional not found');
  }

  // Days since account creation
  const daysActive = Math.floor(
    (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  // Completed bookings count
  const completedBookings = await Booking.countDocuments({
    professional: professionalId,
    status: 'completed'
  });

  // Average rating from customer reviews
  const ratingAgg = await Booking.aggregate([
    {
      $match: {
        professional: new mongoose.Types.ObjectId(professionalId.toString()),
        status: 'completed',
        'customerReview.rating': { $exists: true }
      }
    },
    {
      $group: {
        _id: null,
        avgCommunication: { $avg: '$customerReview.communicationLevel' },
        avgValue: { $avg: '$customerReview.valueOfDelivery' },
        avgQuality: { $avg: '$customerReview.qualityOfService' },
        count: { $sum: 1 }
      }
    }
  ]);

  let avgRating = 0;
  if (ratingAgg.length > 0) {
    const agg = ratingAgg[0];
    avgRating = ((agg.avgCommunication || 0) + (agg.avgValue || 0) + (agg.avgQuality || 0)) / 3;
    avgRating = Math.round(avgRating * 10) / 10;
  }

  // On-time percentage: bookings completed without late status changes
  // For now, use completion rate as proxy (completed / (completed + cancelled by professional))
  const totalAssigned = await Booking.countDocuments({
    professional: professionalId,
    status: { $in: ['completed', 'cancelled', 'in_progress', 'booked'] }
  });
  const onTimePercentage = totalAssigned > 0 ? Math.round((completedBookings / totalAssigned) * 100) : 100;

  // Quote response rate: RFQs that received a quote / total RFQs received
  const totalRfqs = await Booking.countDocuments({
    professional: professionalId,
    status: { $in: ['rfq', 'quoted', 'quote_accepted', 'quote_rejected', 'payment_pending', 'booked', 'in_progress', 'completed', 'cancelled'] }
  });
  const respondedRfqs = await Booking.countDocuments({
    professional: professionalId,
    status: { $in: ['quoted', 'quote_accepted', 'quote_rejected', 'payment_pending', 'booked', 'in_progress', 'completed'] }
  });
  const responseRate = totalRfqs > 0 ? Math.round((respondedRfqs / totalRfqs) * 100) : 100;

  // Points-to-booking conversion: count booking credits purchased using the stored ratio per transaction
  const boostQuery = PointTransaction.find({
    userId: new mongoose.Types.ObjectId(professionalId.toString()),
    source: 'boost',
    type: 'spend'
  }).select('amount metadata');
  if (opts?.session) boostQuery.session(opts.session);
  const boostTxns = await boostQuery;

  let totalBoostedBookings = 0;
  for (const tx of boostTxns) {
    const ratio = tx.metadata?.boostRatio || 100; // fallback for old transactions without stored ratio
    totalBoostedBookings += Math.floor(tx.amount / ratio);
  }

  return {
    completedBookings,
    daysActive,
    avgRating,
    onTimePercentage,
    responseRate,
    boostedBookings: totalBoostedBookings // already converted to booking credits
  };
};

/**
 * Calculate the professional's current level based on their metrics.
 */
export const calculateProfessionalLevel = async (
  professionalId: mongoose.Types.ObjectId | string,
  opts?: { session?: mongoose.ClientSession }
): Promise<ProfessionalLevelInfo> => {
  const [config, professional] = await Promise.all([
    ProfessionalLevelConfig.getCurrentConfig(),
    User.findById(professionalId).select('manualProfessionalLevelOverride').lean()
  ]);
  const metrics = await getProfessionalMetrics(professionalId, opts);
  const activeLevels = config.levels.filter((l) => l.isActive).sort((a, b) => a.order - b.order);

  if (activeLevels.length === 0) {
    throw new Error('No active professional levels configured');
  }

  // Find the highest level where ALL criteria are met
  // metrics.boostedBookings is already in booking credits (converted per-transaction)
  const effectiveBookings = metrics.completedBookings + metrics.boostedBookings;

  let currentLevelIndex = 0;
  for (let i = activeLevels.length - 1; i >= 0; i--) {
    const level = activeLevels[i];
    const c = level.criteria;

    const meetsAll =
      effectiveBookings >= c.minCompletedBookings &&
      metrics.daysActive >= c.minDaysActive &&
      metrics.avgRating >= c.minAvgRating &&
      metrics.onTimePercentage >= c.minOnTimePercentage &&
      metrics.responseRate >= c.minResponseRate;

    if (meetsAll) {
      currentLevelIndex = i;
      break;
    }
  }

  const derivedLevel = activeLevels[currentLevelIndex];
  const currentLevel =
    professional?.manualProfessionalLevelOverride
      ? activeLevels.find((level) => level.name === professional.manualProfessionalLevelOverride) || derivedLevel
      : derivedLevel;

  // Next level info
  let nextLevel: ProfessionalLevelInfo['nextLevel'] = undefined;
  const currentLevelOverrideIndex = activeLevels.findIndex((level) => level.name === currentLevel.name);
  if (currentLevelOverrideIndex < activeLevels.length - 1) {
    const next = activeLevels[currentLevelOverrideIndex + 1];
    const nc = next.criteria;

    const missingCriteria: string[] = [];
    if (effectiveBookings < nc.minCompletedBookings) {
      missingCriteria.push(`${nc.minCompletedBookings - effectiveBookings} more completed bookings`);
    }
    if (metrics.daysActive < nc.minDaysActive) {
      missingCriteria.push(`${nc.minDaysActive - metrics.daysActive} more days active`);
    }
    if (metrics.avgRating < nc.minAvgRating) {
      missingCriteria.push(`Rating ${metrics.avgRating} -> ${nc.minAvgRating} needed`);
    }
    if (metrics.onTimePercentage < nc.minOnTimePercentage) {
      missingCriteria.push(`On-time ${metrics.onTimePercentage}% -> ${nc.minOnTimePercentage}% needed`);
    }
    if (metrics.responseRate < nc.minResponseRate) {
      missingCriteria.push(`Quote response rate ${metrics.responseRate}% -> ${nc.minResponseRate}% needed`);
    }

    // Progress: percentage of criteria met (simple average)
    const criteriaCount = 5;
    const metCount = criteriaCount - missingCriteria.length;
    const progress = Math.round((metCount / criteriaCount) * 100);

    nextLevel = {
      name: next.name as ProfessionalLevelName,
      missingCriteria,
      progress
    };
  }

  return {
    currentLevel: currentLevel.name as ProfessionalLevelName,
    metrics,
    effectiveBookings,
    nextLevel,
    perks: {
      badge: currentLevel.perks.badge,
      commissionReduction: currentLevel.perks.commissionReduction,
      searchRankingBoost: currentLevel.perks.searchRankingBoost
    },
    color: currentLevel.color,
    icon: currentLevel.icon
  };
};

/**
 * Recalculate and persist a professional's level.
 * Called after booking completion or points boost.
 */
export const updateProfessionalLevel = async (
  professionalId: mongoose.Types.ObjectId | string,
  opts?: { session?: mongoose.ClientSession }
): Promise<{ levelChanged: boolean; oldLevel: string; newLevel: string; leveledUp: boolean }> => {
  const findOpts = opts?.session ? { session: opts.session } : {};
  const user = await User.findById(professionalId, null, findOpts);
  if (!user) {
    console.warn(`Professional Level: User not found for professionalId=${professionalId}, skipping level update`);
    return { levelChanged: false, oldLevel: 'New', newLevel: 'New', leveledUp: false };
  }
  if (user.role !== 'professional') {
    console.warn(`Professional Level: User ${professionalId} has role="${user.role}", expected "professional", skipping level update`);
    return { levelChanged: false, oldLevel: 'New', newLevel: 'New', leveledUp: false };
  }

  const oldLevel = user.professionalLevel || 'New';
  if (user.manualProfessionalLevelOverride) {
    if (oldLevel !== user.manualProfessionalLevelOverride) {
      user.professionalLevel = user.manualProfessionalLevelOverride;
      await user.save(opts?.session ? { session: opts.session } : {});
    }
    return {
      levelChanged: oldLevel !== user.manualProfessionalLevelOverride,
      oldLevel,
      newLevel: user.manualProfessionalLevelOverride,
      leveledUp: false,
    };
  }
  const levelInfo = await calculateProfessionalLevel(professionalId, opts);
  const leveledUp = await isProfessionalLevelUpgrade(oldLevel, levelInfo.currentLevel, opts);

  if (oldLevel !== levelInfo.currentLevel) {
    user.professionalLevel = levelInfo.currentLevel;
    await user.save(opts?.session ? { session: opts.session } : {});
    console.log(`Professional Level: ${professionalId} ${oldLevel} -> ${levelInfo.currentLevel}`);
    // Defer notify when inside a transaction — caller must flush after commit.
    if (leveledUp && !opts?.session) {
      try {
        const { notifyAsync } = await import('./notifications/notify');
        notifyAsync({
          userId: professionalId.toString(),
          eventKey: 'professional.leveling_up',
          entityType: 'user',
          entityId: professionalId.toString(),
          context: { levelName: levelInfo.currentLevel },
        });
      } catch (notifyErr) {
        console.error('Failed to notify professional level-up:', notifyErr);
      }
    }
  }

  return {
    levelChanged: oldLevel !== levelInfo.currentLevel,
    oldLevel,
    newLevel: levelInfo.currentLevel,
    leveledUp,
  };
};

/**
 * Professional uses points-to-booking conversion to boost their booking count toward level requirements.
 */
export const applyPointsBoost = async (
  professionalId: mongoose.Types.ObjectId | string,
  pointsToSpend: number
): Promise<{ boostedBookings: number; newLevel: string; levelChanged: boolean }> => {
  const [config, professional] = await Promise.all([
    ProfessionalLevelConfig.getCurrentConfig(),
    User.findById(professionalId).select('professionalLevel')
  ]);
  if (!professional) {
    throw new Error('Professional not found');
  }

  // Use the professional's current level to determine the points required per booking credit
  const currentLevelName = professional.professionalLevel || 'New';
  const currentLevel = config.levels.find((l) => l.isActive && l.name === currentLevelName);
  const boostRatio = currentLevel?.pointsBoostRatio || 100;

  const boostedBookings = Math.floor(pointsToSpend / boostRatio);
  if (boostedBookings < 1) {
    throw new Error(`Need at least ${boostRatio} points for 1 booking credit`);
  }

  // Only spend exact multiple
  const actualPointsSpent = boostedBookings * boostRatio;

  // Use a transaction so deduction + level update are atomic
  const session = await mongoose.startSession();
  try {
    let levelChanged = false;
    let leveledUp = false;
    let newLevel = 'New';

    await session.withTransaction(async () => {
      await deductPoints(
        professionalId as mongoose.Types.ObjectId,
        actualPointsSpent,
        'boost',
        `Applied ${boostedBookings} booking credits toward professional level`,
        { session, metadata: { boostRatio, boostedBookings } }
      );

      // Recalculate level within same transaction
      const result = await updateProfessionalLevel(professionalId, { session });
      levelChanged = result.levelChanged;
      leveledUp = result.leveledUp;
      newLevel = result.newLevel;
    });

    // Notify only after commit, and only for upward transitions
    if (leveledUp) {
      try {
        const { notifyAsync } = await import('./notifications/notify');
        notifyAsync({
          userId: professionalId.toString(),
          eventKey: 'professional.leveling_up',
          entityType: 'user',
          entityId: professionalId.toString(),
          context: { levelName: newLevel },
        });
      } catch (notifyErr) {
        console.error('Failed to notify professional level-up after boost:', notifyErr);
      }
    }

    return { boostedBookings, newLevel, levelChanged };
  } finally {
    await session.endSession();
  }
};
