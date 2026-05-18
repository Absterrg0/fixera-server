import mongoose from 'mongoose';
import User from '../models/user';
import ChatMessage from '../models/chatMessage';
import { deleteFromS3, parseS3KeyFromUrl, isAllowedS3Url } from './s3Upload';

const tryDeleteS3 = async (url?: string | null) => {
  if (!url) return;
  if (!isAllowedS3Url(url)) return;
  const key = parseS3KeyFromUrl(url);
  if (!key) return;
  try {
    await deleteFromS3(key);
  } catch (err) {
    console.error(`anonymizeUser: failed to delete S3 object ${key}`, err);
  }
};

export interface AnonymizeResult {
  userId: string;
  anonymizedAt: Date;
  redactedMessageCount: number;
}

export const anonymizeUser = async (
  userId: mongoose.Types.ObjectId | string,
  actorId: mongoose.Types.ObjectId | string
): Promise<AnonymizeResult> => {
  const id = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
  const actor = typeof actorId === 'string' ? new mongoose.Types.ObjectId(actorId) : actorId;

  const user = await User.findById(id);
  if (!user) {
    throw new Error('User not found');
  }
  if (user.deletedAt) {
    throw new Error('User is already anonymized');
  }
  if (user.role === 'admin') {
    throw new Error('Admin users cannot be anonymized through this path');
  }

  await tryDeleteS3(user.profileImage);
  await tryDeleteS3(user.idProofUrl);

  const placeholderEmail = `deleted-${id.toString()}@anon.local`;
  const placeholderPhone = `DELETED-${id.toString()}`;

  user.name = '[deleted user]';
  user.email = placeholderEmail;
  user.phone = placeholderPhone;
  user.password = undefined;
  user.username = undefined;
  user.vatNumber = undefined;
  user.isVatVerified = false;
  user.businessName = undefined;
  user.companyAddress = undefined;
  user.location = undefined;
  user.businessInfo = undefined;
  user.profileImage = undefined;
  user.idProofUrl = undefined;
  user.idProofFileName = undefined;
  user.idCountryOfIssue = undefined;
  user.idExpirationDate = undefined;
  user.isIdVerified = false;
  user.pendingIdChanges = [];
  user.verificationCode = undefined;
  user.verificationCodeExpires = undefined;
  user.referralCode = undefined;
  user.deletedAt = new Date();
  user.deletedBy = actor;

  await user.save({ validateBeforeSave: false });

  const messageUpdate = await ChatMessage.updateMany(
    { senderId: id },
    { $set: { text: '[deleted message]' } }
  );

  return {
    userId: id.toString(),
    anonymizedAt: user.deletedAt!,
    redactedMessageCount: messageUpdate.modifiedCount ?? 0,
  };
};
