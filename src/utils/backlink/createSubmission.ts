import mongoose from 'mongoose';
import BacklinkConfig from '../../models/backlinkConfig';
import BacklinkSubmission, { IBacklinkSubmission } from '../../models/backlinkSubmission';
import { isFixtractDomain } from './domains';
import { canSubmitUrl, canUserSubmit } from './eligibility';
import { BacklinkError } from './errors';
import { normaliseSubmissionUrl } from './urls';
import { scheduleVerification } from './verifySubmission';

/**
 * Create a BacklinkSubmission document and fire async verification.
 * Returns immediately with the pending submission — caller should 202.
 */
export async function createBacklinkSubmission(
  userId: mongoose.Types.ObjectId,
  rawUrl: string,
  ipAddress?: string,
): Promise<IBacklinkSubmission> {
  const config = await BacklinkConfig.getCurrentConfig();

  let normalizedUrl: string;
  let domain: string;
  try {
    ({ normalizedUrl, domain } = normaliseSubmissionUrl(rawUrl));
  } catch (err) {
    throw new BacklinkError(
      err instanceof Error ? err.message : 'Invalid URL',
      400,
    );
  }

  if (isFixtractDomain(domain, config)) {
    throw new BacklinkError(
      'You cannot submit a Fixtract URL — please link to Fixtract from your own website',
      400,
    );
  }

  const userCheck = await canUserSubmit(userId, config);
  if (!userCheck.allowed) {
    throw new BacklinkError(userCheck.reason!, userCheck.httpStatus!);
  }

  const urlCheck = await canSubmitUrl(normalizedUrl, userId, config);
  if (!urlCheck.allowed) {
    throw new BacklinkError(
      urlCheck.reason!,
      urlCheck.httpStatus!,
      urlCheck.cooldownExpiresAt,
    );
  }

  try {
    const [submission] = await BacklinkSubmission.create([
      {
        userId,
        submittedUrl: rawUrl.trim(),
        normalizedUrl,
        domain,
        status: 'pending_verification',
        verificationMethod: 'firecrawl',
        ipAddress,
      },
    ]);

    scheduleVerification(submission._id);
    return submission;
  } catch (err) {
    if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
      const raceCheck = await canSubmitUrl(normalizedUrl, userId, config);
      if (!raceCheck.allowed) {
        throw new BacklinkError(
          raceCheck.reason!,
          raceCheck.httpStatus!,
          raceCheck.cooldownExpiresAt,
        );
      }
      throw new BacklinkError('This URL is already pending verification', 409);
    }
    throw err;
  }
}
