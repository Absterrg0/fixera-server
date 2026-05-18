import { Request, Response } from 'express';
import { anonymizeUser } from '../../utils/anonymizeUser';
import { auditLog } from '../../utils/auditLogger';

export const deleteMyAccount = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?._id) {
    return res.status(401).json({ success: false, msg: 'Authentication required' });
  }

  if (user.role === 'admin') {
    return res.status(403).json({ success: false, msg: 'Admin accounts cannot be self-deleted' });
  }

  try {
    const result = await anonymizeUser(user._id, user._id);

    await auditLog({
      req,
      action: 'user.anonymize',
      targetType: 'User',
      targetId: user._id,
      details: {
        initiatedBy: 'self',
        redactedMessageCount: result.redactedMessageCount,
      },
      status: 'success',
      statusCode: 200,
    });

    res.clearCookie('auth-token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    return res.status(200).json({
      success: true,
      msg: 'Your account has been deleted. Personal information has been removed; financial records are retained as required by law.',
    });
  } catch (error: any) {
    console.error('[USER][SELF_DELETE] Failed', error);
    await auditLog({
      req,
      action: 'user.anonymize',
      targetType: 'User',
      targetId: user._id,
      details: { initiatedBy: 'self' },
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: 'Failed to delete account' });
  }
};
