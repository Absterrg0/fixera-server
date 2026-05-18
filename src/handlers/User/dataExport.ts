import { Request, Response } from 'express';
import mongoose from 'mongoose';
import User from '../../models/user';
import Booking from '../../models/booking';
import Conversation from '../../models/conversation';
import ChatMessage from '../../models/chatMessage';
import Project from '../../models/project';
import Referral from '../../models/referral';
import PointTransaction from '../../models/pointTransaction';
import Meeting from '../../models/meeting';
import MeetingRequest from '../../models/meetingRequest';
import WarrantyClaim from '../../models/warrantyClaim';
import ChatReport from '../../models/chatReport';
import Favorite from '../../models/favorite';
import CancellationRequest from '../../models/cancellationRequest';
import SupportTicket from '../../models/supportTicket';
import ProfileView from '../../models/profileView';
import DiscountCodeUsage from '../../models/discountCodeUsage';
import Payment from '../../models/payment';
import { auditLog } from '../../utils/auditLogger';

export const exportMyData = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id as mongoose.Types.ObjectId | undefined;
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const userDoc = await User.findById(userId)
      .select('-password -verificationCode -verificationCodeExpires')
      .lean();

    if (!userDoc) {
      return res.status(404).json({ success: false, msg: 'User not found' });
    }

    const userIdStr = userId.toString();

    const [
      bookings,
      conversations,
      projects,
      referralsAsReferrer,
      referralsAsReferred,
      pointTransactions,
      meetings,
      meetingRequests,
      warrantyClaims,
      chatReports,
      favorites,
      cancellationRequests,
      supportTickets,
      profileViews,
      discountCodeUsages,
      payments,
    ] = await Promise.all([
      Booking.find({ $or: [{ customer: userId }, { professional: userId }] }).lean(),
      Conversation.find({
        $or: [
          { customerId: userId },
          { professionalId: userId },
          { supportAdminId: userId },
          { supportTargetUserId: userId },
        ],
      }).lean(),
      Project.find({ professionalId: userId }).lean(),
      Referral.find({ referrer: userId }).lean(),
      Referral.find({ referredUser: userId }).lean(),
      PointTransaction.find({ userId }).lean(),
      Meeting.find({
        $or: [
          { professionalId: userId },
          { 'attendees.userId': userIdStr },
          { createdBy: userIdStr },
        ],
      }).lean(),
      MeetingRequest.find({ userId }).lean(),
      WarrantyClaim.find({ $or: [{ customer: userId }, { professional: userId }] }).lean(),
      ChatReport.find({ reportedBy: userId }).lean(),
      Favorite.find({ user: userId }).lean(),
      CancellationRequest.find({ requestedBy: userId }).lean(),
      SupportTicket.find({
        $or: [{ userId }, { 'replies.authorId': userId }],
      }).lean(),
      ProfileView.find({ $or: [{ professional: userId }, { viewer: userId }] }).lean(),
      DiscountCodeUsage.find({ user: userId }).lean(),
      Payment.find({ $or: [{ customer: userId }, { professional: userId }] }).lean(),
    ]);

    const conversationIds = conversations.map((c: any) => c._id);
    const chatMessages = await ChatMessage.find({
      $or: [
        { senderId: userId },
        { conversationId: { $in: conversationIds } },
      ],
    }).lean();

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      exportSchemaVersion: 1,
      user: userDoc,
      bookings,
      payments,
      conversations,
      chatMessages,
      projects,
      referrals: {
        asReferrer: referralsAsReferrer,
        asReferred: referralsAsReferred,
      },
      pointTransactions,
      meetings,
      meetingRequests,
      warrantyClaims,
      chatReports,
      favorites,
      cancellationRequests,
      supportTickets,
      profileViews,
      discountCodeUsages,
    };

    const datePart = new Date().toISOString().split('T')[0];
    const filename = `fixera-data-export-${userIdStr}-${datePart}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await auditLog({
      req,
      action: 'user.data_export',
      targetType: 'User',
      targetId: userId,
      details: {
        counts: {
          bookings: bookings.length,
          payments: payments.length,
          conversations: conversations.length,
          chatMessages: chatMessages.length,
          projects: projects.length,
          warrantyClaims: warrantyClaims.length,
          favorites: favorites.length,
        },
      },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).send(JSON.stringify(exportPayload, null, 2));
  } catch (error: any) {
    console.error('[USER][DATA_EXPORT] Failed', error);
    await auditLog({
      req,
      action: 'user.data_export',
      targetType: 'User',
      targetId: (req as any).user?._id,
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: 'Failed to export user data' });
  }
};
