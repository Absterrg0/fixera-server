import {
  initializeApp,
  cert,
  getApp,
  getApps,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getMessaging, type BatchResponse } from 'firebase-admin/messaging';
import User, { IUser } from '../models/user';
import { getTokensForCurrentDeployment } from './fcmTokenUtils';

// ------------------------------------------------------------------
// Firebase Admin Initialisation (lazy singleton)
// ------------------------------------------------------------------

const FIREBASE_APP_NAME = 'fixtract-fcm';
const FCM_NOT_CONFIGURED = 'FCM not configured';

function isFcmNotConfiguredError(err: unknown): boolean {
  return err instanceof Error && err.message === FCM_NOT_CONFIGURED;
}

function getFirebaseApp(): App {
  const existing = getApps().find((a) => a.name === FIREBASE_APP_NAME);
  if (existing) return existing;

  // Service account credentials are stored as a base64-encoded JSON string
  // in the FCM_SERVICE_ACCOUNT_JSON env-var so they survive on any host.
  const serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJson) {
    console.warn('⚠️  FCM_SERVICE_ACCOUNT_JSON is not set – push notifications disabled');
    throw new Error(FCM_NOT_CONFIGURED);
  }

  try {
    const serviceAccount = JSON.parse(
      Buffer.from(serviceAccountJson, 'base64').toString('utf-8'),
    ) as ServiceAccount;

    const app = initializeApp({ credential: cert(serviceAccount) }, FIREBASE_APP_NAME);
    console.log('🔥 Firebase Admin initialised');
    return app;
  } catch (err) {
    console.error('FCM_SERVICE_ACCOUNT_JSON is set but invalid (bad base64 or JSON):', err);
    throw err;
  }
}

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type NotificationType =
  | 'booking_updates'
  | 'messages'
  | 'promotions'
  | 'system';

export interface PushPayload {
  title: string;
  body: string;
  type: NotificationType;
  /** Extra data fields sent as the FCM data payload (strings only) */
  data?: Record<string, string>;
  /** Optional deep-link URL opened when the user taps the notification */
  clickUrl?: string;
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Returns true when the user has explicitly disabled push for the given
 * notification type. Defaults to allowed (returns false) when prefs are
 * absent — this matches the schema defaults of push: true.
 */
function isPushDisabled(
  prefs: IUser['notificationPreferences'],
  type: NotificationType,
): boolean {
  return prefs?.[type]?.push === false;
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Send a push notification to a single user.
 * Respects user notification preferences and silently removes stale tokens.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  const user = await User.findById(userId).select('+fcmTokens notificationPreferences');
  const tokens = getTokensForCurrentDeployment(user?.fcmTokens);
  if (!tokens.length) return;

  if (isPushDisabled(user!.notificationPreferences, payload.type)) return;

  await _dispatchTokens(tokens, payload, userId);
}

/**
 * Send the same push notification to multiple users.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<void> {
  if (!userIds.length) return;

  const users = await User.find({ _id: { $in: userIds } }).select(
    '+fcmTokens notificationPreferences',
  );

  const allTokensWithOwner: { token: string; userId: string }[] = [];

  for (const user of users) {
    const tokens = getTokensForCurrentDeployment(user.fcmTokens);
    if (!tokens.length) continue;
    if (isPushDisabled(user.notificationPreferences, payload.type)) continue;

    for (const token of tokens) {
      allTokensWithOwner.push({ token, userId: user._id.toString() });
    }
  }

  if (!allTokensWithOwner.length) return;

  // FCM multicast limit is 500 tokens per batch
  const batches = chunkArray(allTokensWithOwner, 500);
  for (const batch of batches) {
    await _dispatchMulticast(batch, payload);
  }
}

// ------------------------------------------------------------------
// Private dispatch helpers
// ------------------------------------------------------------------

const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

function buildMulticastMessage(
  tokens: string[],
  payload: PushPayload,
) {
  const clickUrl = payload.clickUrl ?? '/';
  return {
    tokens,
    notification: { title: payload.title, body: payload.body },
    data: {
      ...payload.data,
      type: payload.type,
      clickUrl,
    },
    webpush: {
      notification: {
        title: payload.title,
        body: payload.body,
        icon: '/fixtract-logo.png',
        badge: '/fixtract-logo.png',
        tag: payload.type || 'fixtract-notification',
        data: { url: clickUrl },
      },
      fcmOptions: { link: clickUrl },
    },
  };
}

async function _dispatchTokens(
  tokens: string[],
  payload: PushPayload,
  userId: string,
): Promise<void> {
  let app: App;
  try {
    app = getFirebaseApp();
  } catch (err) {
    if (isFcmNotConfiguredError(err)) return;
    throw err;
  }

  const messaging = getMessaging(app);
  const staleTokens: string[] = [];

  for (const chunk of chunkArray(tokens, 500)) {
    try {
      const response: BatchResponse = await messaging.sendEachForMulticast(
        buildMulticastMessage(chunk, payload),
      );

      response.responses.forEach((resp, idx) => {
        if (!resp.success && STALE_TOKEN_CODES.has(resp.error?.code ?? '')) {
          staleTokens.push(chunk[idx]);
        }
      });
    } catch (err) {
      console.error('FCM dispatch error:', err);
    }
  }

  if (staleTokens.length) {
    await User.findByIdAndUpdate(userId, {
      $pull: { fcmTokens: { token: { $in: staleTokens } } },
    });
  }
}

async function _dispatchMulticast(
  tokensWithOwner: { token: string; userId: string }[],
  payload: PushPayload,
): Promise<void> {
  let app: App;
  try {
    app = getFirebaseApp();
  } catch (err) {
    if (isFcmNotConfiguredError(err)) return;
    throw err;
  }

  const messaging = getMessaging(app);
  const tokens = tokensWithOwner.map((t) => t.token);

  try {
    const response: BatchResponse = await messaging.sendEachForMulticast(
      buildMulticastMessage(tokens, payload),
    );

    const staleByUser = new Map<string, string[]>();
    response.responses.forEach((resp, idx) => {
      if (!resp.success && STALE_TOKEN_CODES.has(resp.error?.code ?? '')) {
        const { token, userId } = tokensWithOwner[idx];
        const existing = staleByUser.get(userId) ?? [];
        existing.push(token);
        staleByUser.set(userId, existing);
      }
    });

    for (const [userId, stale] of staleByUser) {
      await User.findByIdAndUpdate(userId, {
        $pull: { fcmTokens: { token: { $in: stale } } },
      });
    }
  } catch (err) {
    console.error('FCM multicast error:', err);
  }
}
