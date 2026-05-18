import { Request, Response } from 'express';
import mongoose from 'mongoose';
import User from '../../models/user';
import { anonymizeUser } from '../../utils/anonymizeUser';
import { auditLog } from '../../utils/auditLogger';

export const adminAnonymizeUser = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?._id || (req as any).user?._id;
    if (!adminId) {
      return res.status(401).json({ success: false, msg: 'Admin authentication required' });
    }

    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, msg: 'Invalid userId' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: 'User not found' });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, msg: 'Cannot anonymize admin users' });
    }
    if (user.deletedAt) {
      return res.status(409).json({ success: false, msg: 'User is already anonymized' });
    }

    const beforeSnapshot = {
      name: user.name,
      email: user.email,
      role: user.role,
      accountStatus: user.accountStatus,
    };

    const result = await anonymizeUser(user._id, adminId);

    await auditLog({
      req,
      action: 'admin.users.anonymize',
      targetType: 'User',
      targetId: user._id,
      details: {
        initiatedBy: 'admin',
        before: beforeSnapshot,
        redactedMessageCount: result.redactedMessageCount,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).json({
      success: true,
      msg: 'User anonymized. Personal information removed; financial records retained.',
      data: result,
    });
  } catch (error: any) {
    console.error('[ADMIN][ANONYMIZE_USER] Failed', error);
    await auditLog({
      req,
      action: 'admin.users.anonymize',
      targetType: 'User',
      targetId: req.params.userId,
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: 'Failed to anonymize user' });
  }
};
