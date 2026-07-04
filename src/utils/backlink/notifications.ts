import mongoose from 'mongoose';

const LOG_PREFIX = '[backlink]';

type PushPayload = {
  title: string;
  body: string;
  type: string;
  clickUrl: string;
  data?: Record<string, string>;
};

function benefitsClickUrl(): string {
  return `${process.env.FRONTEND_URL ?? ''}/dashboard/benefits`;
}

/** Push delivery is wired when the FCM notification service is present (separate PR). */
function fireAndForget(
  userId: mongoose.Types.ObjectId | string,
  payload: PushPayload,
): void {
  const fcmModulePath = '../fcmService';
  void (async () => {
    try {
      // Variable path keeps this module independent of the FCM feature branch at compile time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sendPushToUser = require(fcmModulePath)?.sendPushToUser as
        | ((id: string, p: PushPayload) => Promise<void>)
        | undefined;
      if (!sendPushToUser) return;
      await sendPushToUser(userId.toString(), payload);
    } catch (err: unknown) {
      console.warn(`${LOG_PREFIX} FCM notify skipped (non-critical):`, err);
    }
  })();
}

export function notifyVerificationRejected(
  userId: mongoose.Types.ObjectId,
  submissionId: mongoose.Types.ObjectId,
  domain: string,
  reason: string,
  cooldownHours: number,
): void {
  fireAndForget(userId, {
    title: '🔗 Backlink Not Verified',
    body: `Your submission for ${domain} could not be verified. Tap to review and resubmit.`,
    type: 'system',
    clickUrl: benefitsClickUrl(),
    data: {
      submissionId: submissionId.toString(),
      reason,
      cooldownHours: String(cooldownHours),
    },
  });
}

export function notifyVerified(
  userId: mongoose.Types.ObjectId,
  submissionId: mongoose.Types.ObjectId,
  domain: string,
  rewardPoints: number,
): void {
  fireAndForget(userId, {
    title: '🎉 Backlink Verified!',
    body: `Your link on ${domain} was verified — you earned ${rewardPoints} points!`,
    type: 'system',
    clickUrl: benefitsClickUrl(),
    data: {
      submissionId: submissionId.toString(),
      pointsAwarded: String(rewardPoints),
    },
  });
}

export function notifyAdminApproved(
  userId: mongoose.Types.ObjectId,
  submissionId: mongoose.Types.ObjectId,
  domain: string,
  rewardPoints: number,
): void {
  fireAndForget(userId, {
    title: '🎉 Backlink Approved!',
    body: `Your link on ${domain} was manually approved — you earned ${rewardPoints} points!`,
    type: 'system',
    clickUrl: benefitsClickUrl(),
    data: {
      submissionId: submissionId.toString(),
      pointsAwarded: String(rewardPoints),
    },
  });
}

export function notifyAdminRejected(
  userId: mongoose.Types.ObjectId,
  submissionId: mongoose.Types.ObjectId,
  domain: string,
  reason: string,
): void {
  fireAndForget(userId, {
    title: '🔗 Backlink Rejected',
    body: `Your backlink submission for ${domain} was rejected. Reason: ${reason}`,
    type: 'system',
    clickUrl: benefitsClickUrl(),
    data: { submissionId: submissionId.toString() },
  });
}

export function notifyRevoked(
  userId: mongoose.Types.ObjectId,
  submissionId: mongoose.Types.ObjectId,
  domain: string,
  pointsToClawBack: number,
  actuallyDeducted: number,
  unclawedPoints: number,
): void {
  const body =
    unclawedPoints > 0
      ? `Your verified backlink on ${domain} was revoked. ${actuallyDeducted} points were deducted; ${unclawedPoints} points could not be recovered as they were already spent.`
      : `Your verified backlink on ${domain} was revoked and ${pointsToClawBack} points were deducted.`;

  fireAndForget(userId, {
    title: '⚠️ Backlink Revoked',
    body,
    type: 'system',
    clickUrl: benefitsClickUrl(),
    data: { submissionId: submissionId.toString() },
  });
}
