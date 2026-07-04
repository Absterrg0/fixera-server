import mongoose from 'mongoose';
import User from '../../models/user';
import BacklinkSubmission, {
  ICrawlResult,
  IBacklinkSubmission,
} from '../../models/backlinkSubmission';
import type { IBacklinkConfig } from '../../models/backlinkConfig';
import { addPoints } from '../pointsSystem';
import type { ScrapeResult } from '../firecrawlClient';
import type { FoundLink } from './verification';
import {
  notifyVerificationRejected,
  notifyVerified,
} from './notifications';

const LOG_PREFIX = '[backlink]';

export function rewardPointsForRole(
  config: IBacklinkConfig,
  role: string,
): number {
  return role === 'professional'
    ? config.professionalRewardPoints
    : config.customerRewardPoints;
}

function buildCrawlResult(
  scrapeResult: ScrapeResult,
  foundLinks: FoundLink[],
): ICrawlResult {
  return {
    crawledAt: new Date(),
    pageTitle: scrapeResult.metadata?.title,
    foundLinks,
    rawMarkdownLength: scrapeResult.markdown?.length,
  };
}

export async function rejectSubmission(
  submission: IBacklinkSubmission,
  reason: string,
  config: IBacklinkConfig,
): Promise<void> {
  const now = new Date();
  const updated = await BacklinkSubmission.findOneAndUpdate(
    { _id: submission._id, status: 'verifying' },
    {
      $set: {
        status: 'rejected',
        rejectionReason: reason,
        lastRejectedAt: now,
      },
    },
  );

  if (!updated) return;

  console.log(`${LOG_PREFIX} Submission ${submission._id} rejected: ${reason}`);

  notifyVerificationRejected(
    submission.userId,
    submission._id,
    submission.domain,
    reason,
    config.resubmitCooldownHours,
  );
}

export async function verifyAndReward(
  submission: IBacklinkSubmission,
  foundLinks: FoundLink[],
  scrapeResult: ScrapeResult,
  config: IBacklinkConfig,
): Promise<void> {
  const user = await User.findById(submission.userId).select('role');
  if (!user) {
    await rejectSubmission(submission, 'User account not found', config);
    return;
  }

  const rewardPoints = rewardPointsForRole(config, user.role);
  const crawlResult = buildCrawlResult(scrapeResult, foundLinks);

  if (rewardPoints <= 0) {
    const updated = await BacklinkSubmission.findOneAndUpdate(
      { _id: submission._id, status: 'verifying' },
      {
        $set: {
          status: 'verified',
          verificationMethod: 'firecrawl',
          rewardPoints: 0,
          rewardIssuedAt: new Date(),
          crawlResult,
        },
      },
    );
    if (!updated) return;
    return;
  }

  const verified = await BacklinkSubmission.findOneAndUpdate(
    { _id: submission._id, status: 'verifying', pointTransactionId: { $exists: false } },
    {
      $set: {
        status: 'verified',
        verificationMethod: 'firecrawl',
        rewardPoints,
        rewardIssuedAt: new Date(),
        crawlResult,
      },
    },
    { new: true },
  );

  if (!verified) {
    const existing = await BacklinkSubmission.findById(submission._id).select(
      'status pointTransactionId rewardPoints',
    );
    if (existing?.status === 'verified' && existing.pointTransactionId) {
      notifyVerified(
        submission.userId,
        submission._id,
        submission.domain,
        existing.rewardPoints ?? rewardPoints,
      );
    }
    return;
  }

  if (verified.pointTransactionId) {
    notifyVerified(submission.userId, submission._id, submission.domain, rewardPoints);
    return;
  }

  try {
    const { transaction } = await addPoints(
      submission.userId,
      rewardPoints,
      'backlink',
      `Backlink reward: verified link to Fixera on ${submission.domain}`,
      {
        metadata: {
          backlinkSubmissionId: submission._id.toString(),
          submittedUrl: submission.submittedUrl,
          matchedHref: foundLinks[0]?.href,
        },
      },
    );

    await BacklinkSubmission.findByIdAndUpdate(submission._id, {
      $set: { pointTransactionId: transaction._id },
    });

    console.log(
      `${LOG_PREFIX} Submission ${submission._id} verified — awarded ${rewardPoints} pts to user ${submission.userId}`,
    );

    notifyVerified(submission.userId, submission._id, submission.domain, rewardPoints);
  } catch (err) {
    console.error(`${LOG_PREFIX} addPoints failed for submission ${submission._id}:`, err);
    await BacklinkSubmission.findOneAndUpdate(
      {
        _id: submission._id,
        status: 'verified',
        pointTransactionId: { $exists: false },
      },
      {
        $set: {
          adminReviewReason: 'Points award failed — pending admin review',
        },
      },
    );
  }
}
