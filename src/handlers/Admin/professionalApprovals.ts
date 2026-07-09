import { Request, Response, NextFunction } from "express";
import User, { IUser } from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import { sendProfessionalApprovalEmail, sendProfessionalIdChangeApprovalEmail, sendProfessionalIdChangeRejectionEmail, sendProfessionalRejectionEmail, sendProfessionalSuspensionEmail, sendProfessionalReactivationEmail } from "../../utils/emailService";
import { getProfessionalDisplayName } from "../../utils/displayName";
import { deleteFromS3, getPresignedUrl, parseS3KeyFromUrl, presignS3Url } from "../../utils/s3Upload";
import mongoose from 'mongoose';
import { normalizePendingOldValue } from "../../utils/pendingIdChanges";
import { auditLog } from "../../utils/auditLogger";

const getS3KeyFromValue = (value?: string): string | null => {
  if (!value) return null;
  if (value.startsWith('id-proof/')) return value;
  if (value.startsWith('http')) return parseS3KeyFromUrl(value);
  return null;
};

const buildS3UrlFromKey = (key: string): string => {
  const bucket = process.env.S3_BUCKET_NAME || 'abby-fixera';
  const region = process.env.AWS_REGION || 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};

const presignIdReference = async (value?: string): Promise<string | undefined> => {
  if (!value) return undefined;
  if (value.startsWith('id-proof/')) {
    try {
      return await getPresignedUrl(value, 7 * 24 * 60 * 60);
    } catch {
      return value;
    }
  }
  if (value.startsWith('http')) {
    return (await presignS3Url(value, 7 * 24 * 60 * 60)) || value;
  }
  return value;
};

const serializeProfessionalForAdmin = async (professional: any) => {
  const serialized = typeof professional?.toObject === 'function'
    ? professional.toObject()
    : { ...professional };

  serialized.idProofUrl = await presignIdReference(
    serialized.idProofFileName || serialized.idProofUrl
  );

  if (Array.isArray(serialized.pendingIdChanges)) {
    serialized.pendingIdChanges = await Promise.all(
      serialized.pendingIdChanges.map(async (change: any) => {
        if (change?.field !== 'idProofDocument') {
          return change;
        }

        return {
          ...change,
          oldValue: await presignIdReference(change.oldValue) || change.oldValue,
          newValue: await presignIdReference(change.newValue) || change.newValue,
        };
      })
    );
  }

  return serialized;
};

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user && req.user.role === 'admin') {
      req.admin = req.user as IUser;
      return next();
    }

    let token = req.cookies?.['auth-token'];

    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    await connecToDatabase();
    const adminUser = await User.findById(decoded.id);

    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        msg: "Admin access required"
      });
    }

    req.admin = adminUser;
    return next();
  } catch (error: any) {
    console.error('Require admin error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to authenticate admin"
    });
  }
};

// Get all professionals pending approval
export const getPendingProfessionals = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();
    const adminUser = req.admin as IUser;

    // Get professionals with specified status
    const status = req.query.status as string || 'pending';
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const professionals = await User.find({
      role: 'professional',
      professionalStatus: status
    })
    .select('-password -verificationCode -verificationCodeExpires')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

    const total = await User.countDocuments({
      role: 'professional',
      professionalStatus: status
    });

    console.log(`👑 Admin: Retrieved ${professionals.length} professionals with status ${status} for ${adminUser.email}`);

    const serializedProfessionals = await Promise.all(
      professionals.map((professional) => serializeProfessionalForAdmin(professional))
    );

    return res.status(200).json({
      success: true,
      data: {
        professionals: serializedProfessionals,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error: any) {
    console.error('Get pending professionals error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve professionals"
    });
  }
};

// Get professional details for approval
export const getProfessionalDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;

    await connecToDatabase();
    const adminUser = req.admin as IUser;

    const professional = await User.findOne({
      _id: professionalId,
      role: 'professional'
    }).select('-password -verificationCode -verificationCodeExpires');

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Professional not found"
      });
    }

    console.log(`👑 Admin: Retrieved professional details for ${professional.email}`);

    const serializedProfessional = await serializeProfessionalForAdmin(professional);

    return res.status(200).json({
      success: true,
      data: {
        professional: serializedProfessional
      }
    });

  } catch (error: any) {
    console.error('Get professional details error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve professional details"
    });
  }
};

// Approve professional
export const approveProfessional = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;

    await connecToDatabase();
    const adminUser = req.admin as IUser;

    const professional = await User.findOne({
      _id: professionalId,
      role: 'professional'
    });

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Professional not found"
      });
    }

    if (professional.professionalStatus === 'approved') {
      return res.status(400).json({
        success: false,
        msg: "Professional is already approved"
      });
    }
    const missingRequirements = [];
    
    if (!professional.isVatVerified || !professional.vatNumber) {
      missingRequirements.push('VAT number validation');
    }
    
    if (!professional.isIdVerified || !professional.idProofUrl) {
      missingRequirements.push('ID proof verification');
    }

    if (!professional.stripe?.accountId || !professional.stripe?.onboardingCompleted) {
      missingRequirements.push('Stripe onboarding');
    }

    const hasCompanyDayAvailable = Object.values(professional.companyAvailability || {}).some((day: any) => day?.available);
    if (!hasCompanyDayAvailable) {
      missingRequirements.push('Company availability');
    }

    if (
      !professional.onboardingAgreements?.rulesAccepted ||
      !professional.onboardingAgreements?.termsAccepted ||
      !professional.onboardingAgreements?.selfBillingAccepted
    ) {
      missingRequirements.push('Required platform agreements');
    }

    if (missingRequirements.length > 0) {
      return res.status(400).json({
        success: false,
        msg: `Cannot approve professional. Missing required verification: ${missingRequirements.join(', ')}`,
        data: {
          missingRequirements,
          hasVat: !!professional.vatNumber,
          isVatVerified: !!professional.isVatVerified,
          hasIdProof: !!professional.idProofUrl,
          isIdVerified: !!professional.isIdVerified
        }
      });
    }

    const beforeSnapshot = {
      professionalStatus: professional.professionalStatus,
      accountStatus: professional.accountStatus,
    };

    // Update professional status
    professional.professionalStatus = 'approved';
    professional.accountStatus = 'active';
    professional.approvedBy = (adminUser._id as mongoose.Types.ObjectId).toString();
    professional.approvedAt = new Date();
    professional.rejectionReason = undefined; // Clear any previous rejection reason
    professional.suspensionReason = undefined;
    await professional.save();

    // Send approval email
    try {
      await sendProfessionalApprovalEmail(professional.email, getProfessionalDisplayName(professional));
    } catch (emailError) {
      console.error(`📧 PHASE 1: Failed to send approval email to ${professional.email}:`, emailError);
    }

    await auditLog({
      req,
      action: 'admin.professionals.approve',
      targetType: 'User',
      targetId: professional._id as mongoose.Types.ObjectId,
      details: {
        before: beforeSnapshot,
        after: { professionalStatus: 'approved', accountStatus: 'active' },
        professionalEmail: professional.email,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).json({
      success: true,
      msg: "Professional approved successfully",
      data: {
        professional: {
          _id: professional._id,
          name: professional.name,
          email: professional.email,
          professionalStatus: professional.professionalStatus,
          approvedBy: professional.approvedBy,
          approvedAt: professional.approvedAt
        }
      }
    });

  } catch (error: any) {
    console.error('Approve professional error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to approve professional"
    });
  }
};

// Reject professional
export const rejectProfessional = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        msg: "Rejection reason is required and must be at least 10 characters"
      });
    }

    await connecToDatabase();
    const adminUser = req.admin as IUser;

    const professional = await User.findOne({
      _id: professionalId,
      role: 'professional'
    });

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Professional not found"
      });
    }

    const beforeSnapshot = {
      professionalStatus: professional.professionalStatus,
      accountStatus: professional.accountStatus,
    };

    // Update professional status
    professional.professionalStatus = 'rejected';
    professional.accountStatus = 'rejected';
    professional.rejectionReason = reason.trim();
    professional.suspensionReason = undefined;
    professional.approvedBy = undefined;
    professional.approvedAt = undefined;
    await professional.save();

    // Send rejection email
    try {
      await sendProfessionalRejectionEmail(professional.email, getProfessionalDisplayName(professional), reason.trim());
    } catch (emailError) {
      console.error(`📧 PHASE 1: Failed to send rejection email to ${professional.email}:`, emailError);
      // Don't fail the rejection if email fails
    }

    await auditLog({
      req,
      action: 'admin.professionals.reject',
      targetType: 'User',
      targetId: professional._id as mongoose.Types.ObjectId,
      details: {
        before: beforeSnapshot,
        after: { professionalStatus: 'rejected', accountStatus: 'rejected' },
        rejectionReason: reason.trim(),
        professionalEmail: professional.email,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).json({
      success: true,
      msg: "Professional rejected successfully",
      data: {
        professional: {
          _id: professional._id,
          name: professional.name,
          email: professional.email,
          professionalStatus: professional.professionalStatus,
          rejectionReason: professional.rejectionReason
        }
      }
    });

  } catch (error: any) {
    console.error('Reject professional error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to reject professional"
    });
  }
};

// Suspend professional
export const suspendProfessional = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        msg: "Suspension reason is required and must be at least 10 characters"
      });
    }

    await connecToDatabase();
    const adminUser = req.admin as IUser;

    const professional = await User.findOne({
      _id: professionalId,
      role: 'professional'
    });

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Professional not found"
      });
    }

    const beforeSnapshot = {
      professionalStatus: professional.professionalStatus,
      accountStatus: professional.accountStatus,
    };

    // Update professional status
    if (professional.professionalStatus !== 'suspended' && !professional.previousProfessionalStatus) {
      professional.previousProfessionalStatus = professional.professionalStatus as any;
    }
    professional.professionalStatus = 'suspended';
    professional.accountStatus = 'suspended';
    professional.suspensionReason = reason.trim();
    await professional.save();

    // Send suspension email
    try {
      await sendProfessionalSuspensionEmail(professional.email, getProfessionalDisplayName(professional), reason.trim());
      console.log(`📧 Admin: Suspension email sent to ${professional.email}`);
    } catch (emailError) {
      console.error(`📧 ADMIN: Failed to send suspension email to ${professional.email}:`, emailError);
      // Don't fail the suspension if email fails
    }

    console.log(`⏸️ Admin: Professional ${professional.email} suspended by ${adminUser.email}`);

    await auditLog({
      req,
      action: 'admin.professionals.suspend',
      targetType: 'User',
      targetId: professional._id as mongoose.Types.ObjectId,
      details: {
        before: beforeSnapshot,
        after: { professionalStatus: 'suspended', accountStatus: 'suspended' },
        suspensionReason: reason.trim(),
        professionalEmail: professional.email,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).json({
      success: true,
      msg: "Professional suspended successfully",
      data: {
        professional: {
          _id: professional._id,
          name: professional.name,
          email: professional.email,
          professionalStatus: professional.professionalStatus,
          suspensionReason: professional.suspensionReason
        }
      }
    });

  } catch (error: any) {
    console.error('Suspend professional error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to suspend professional"
    });
  }
};

// Reactivate/Unsuspend professional
export const reactivateProfessional = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;

    await connecToDatabase();
    const adminUser = req.admin as IUser;

    const professional = await User.findOne({
      _id: professionalId,
      role: 'professional'
    });

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Professional not found"
      });
    }

    if (professional.professionalStatus !== 'suspended') {
      return res.status(400).json({
        success: false,
        msg: "Professional is not currently suspended"
      });
    }

    const beforeSnapshot = {
      professionalStatus: professional.professionalStatus,
      accountStatus: professional.accountStatus,
    };

    // Restore professional status from the pre-suspension snapshot when available
    professional.professionalStatus = (professional.previousProfessionalStatus as any) || 'approved';
    professional.previousProfessionalStatus = undefined;
    professional.accountStatus = 'active';
    professional.suspensionReason = undefined;
    await professional.save();

    // Send reactivation email
    try {
      await sendProfessionalReactivationEmail(professional.email, getProfessionalDisplayName(professional));
      console.log(`📧 Admin: Reactivation email sent to ${professional.email}`);
    } catch (emailError) {
      console.error(`📧 ADMIN: Failed to send reactivation email to ${professional.email}:`, emailError);
      // Don't fail the reactivation if email fails
    }

    console.log(`▶️ Admin: Professional ${professional.email} reactivated by ${adminUser.email}`);

    await auditLog({
      req,
      action: 'admin.professionals.reactivate',
      targetType: 'User',
      targetId: professional._id as mongoose.Types.ObjectId,
      details: {
        before: beforeSnapshot,
        after: { professionalStatus: professional.professionalStatus, accountStatus: 'active' },
        professionalEmail: professional.email,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).json({
      success: true,
      msg: "Professional reactivated successfully",
      data: {
        professional: {
          _id: professional._id,
          name: professional.name,
          email: professional.email,
          professionalStatus: professional.professionalStatus
        }
      }
    });

  } catch (error: any) {
    console.error('Reactivate professional error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to reactivate professional"
    });
  }
};

// Verify ID proof for professional
export const verifyIdProof = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;

    await connecToDatabase();
    const adminUser = req.admin as IUser;

    const professional = await User.findOne({
      _id: professionalId,
      role: 'professional'
    });

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Professional not found"
      });
    }

    if (!professional.idProofUrl) {
      return res.status(400).json({
        success: false,
        msg: "No ID proof document uploaded"
      });
    }

    // Update ID verification status
    professional.isIdVerified = true;
    await professional.save();
    return res.status(200).json({
      success: true,
      msg: "ID proof verified successfully",
      data: {
        professional: {
          _id: professional._id,
          email: professional.email,
          isIdVerified: professional.isIdVerified
        }
      }
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      msg: "Failed to verify ID proof"
    });
  }
};

// Review and resolve pending ID changes for a professional
export const reviewIdChanges = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;
    const { action, reason } = req.body; // action: 'approve' | 'reject'

    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        msg: "Action must be 'approve' or 'reject'"
      });
    }

    if (action === 'reject' && (!reason || reason.trim().length < 10)) {
      return res.status(400).json({
        success: false,
        msg: "Rejection reason must be at least 10 characters"
      });
    }

    await connecToDatabase();
    const adminUser = req.admin as IUser;

    const professional = await User.findOne({
      _id: professionalId,
      role: 'professional'
    });

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Professional not found"
      });
    }

    if (!professional.pendingIdChanges || professional.pendingIdChanges.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "No pending ID changes to review"
      });
    }

    if (action === 'approve') {
      // Delete old S3 files that are being replaced before clearing pending changes
      for (const change of professional.pendingIdChanges) {
        if (change.field === 'idProofDocument' && change.oldValue) {
          const oldKey = getS3KeyFromValue(change.oldValue);
          if (oldKey) {
            try {
              await deleteFromS3(oldKey);
              console.log(`🗑️ ID Proof: Deleted old file ${oldKey} after approval for professionalId=${String(professional._id)}`);
            } catch (deleteError) {
              console.error(`⚠️ ID Proof: Failed to delete old file ${oldKey} after approval for professionalId=${String(professional._id)}:`, deleteError);
            }
          }
        }
      }

      // Clear pending changes, re-approve professional
      professional.pendingIdChanges = undefined;
      professional.professionalStatus = 'approved';
      professional.accountStatus = 'active';
      professional.isIdVerified = true;
      professional.approvedBy = (adminUser._id as mongoose.Types.ObjectId).toString();
      professional.approvedAt = new Date();
      professional.rejectionReason = undefined;
      professional.suspensionReason = undefined;
      await professional.save();

      // Send ID change approval email (distinct from initial profile approval)
      try {
        await sendProfessionalIdChangeApprovalEmail(professional.email, getProfessionalDisplayName(professional));
      } catch (emailError) {
        console.error(`📧 PHASE 1: Failed to send ID change approval email to professionalId=${String(professional._id)}:`, emailError);
      }

      console.log(`✅ Admin: ID changes approved for professionalId=${String(professional._id)} by adminId=${String(adminUser._id)}`);

      return res.status(200).json({
        success: true,
        msg: "ID changes approved. Professional re-approved.",
        data: {
          professional: {
            _id: professional._id,
            name: professional.name,
            email: professional.email,
            professionalStatus: professional.professionalStatus
          }
        }
      });
    } else {
      // Reject: revert the changes
      for (const change of professional.pendingIdChanges) {
        if (change.field === 'idCountryOfIssue') {
          professional.idCountryOfIssue = normalizePendingOldValue(change.oldValue);
        } else if (change.field === 'idExpirationDate') {
          const oldDateValue = normalizePendingOldValue(change.oldValue);
          professional.idExpirationDate = oldDateValue ? new Date(oldDateValue) : undefined;
        } else if (change.field === 'idProofDocument') {
          const oldValue = normalizePendingOldValue(change.oldValue);
          const newValue = change.newValue?.trim();

          if (oldValue && oldValue.startsWith('http')) {
            professional.idProofUrl = oldValue;
            professional.idProofFileName = parseS3KeyFromUrl(oldValue) || undefined;
          } else if (oldValue) {
            const oldKey = getS3KeyFromValue(oldValue);
            if (oldKey) {
              professional.idProofFileName = oldKey;
              professional.idProofUrl = buildS3UrlFromKey(oldKey);
            } else {
              professional.idProofUrl = undefined;
              professional.idProofFileName = undefined;
              professional.idProofUploadedAt = undefined;
            }
          } else {
            professional.idProofUrl = undefined;
            professional.idProofFileName = undefined;
            professional.idProofUploadedAt = undefined;
          }

          const newKey = getS3KeyFromValue(newValue);
          if (newKey) {
            try {
              await deleteFromS3(newKey);
            } catch (deleteError) {
              console.warn(`⚠️ ID Proof: Failed to delete rejected upload ${newKey}:`, deleteError);
            }
          }
        }
      }

      professional.pendingIdChanges = undefined;
      professional.professionalStatus = 'approved';
      professional.accountStatus = 'active';
      professional.isIdVerified = true;
      professional.lastIdChangeRejectionReason = reason.trim();
      await professional.save();

      // Send rejection email
      try {
        await sendProfessionalIdChangeRejectionEmail(professional.email, getProfessionalDisplayName(professional), reason.trim());
      } catch (emailError) {
        console.error(`Failed to send ID change rejection email to professionalId=${String(professional._id)}:`, emailError);
      }

      console.log(`❌ Admin: ID changes rejected for professionalId=${String(professional._id)} by adminId=${String(adminUser._id)}`);

      return res.status(200).json({
        success: true,
        msg: "ID changes rejected. Previous values restored.",
        data: {
          professional: {
            _id: professional._id,
            name: professional.name,
            email: professional.email,
            professionalStatus: professional.professionalStatus,
            lastIdChangeRejectionReason: professional.lastIdChangeRejectionReason
          }
        }
      });
    }

  } catch (error: any) {
    console.error('Review ID changes error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to review ID changes"
    });
  }
};

// Get approval stats for dashboard
export const getApprovalStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connecToDatabase();
    const adminUser = req.admin as IUser;

    // Get counts for each status
    const stats = await Promise.all([
      User.countDocuments({ role: 'professional', professionalStatus: 'pending' }),
      User.countDocuments({ role: 'professional', professionalStatus: 'approved' }),
      User.countDocuments({ role: 'professional', professionalStatus: 'rejected' }),
      User.countDocuments({ role: 'professional', professionalStatus: 'suspended' })
    ]);

    const [pending, approved, rejected, suspended] = stats;
    const total = pending + approved + rejected + suspended;

    console.log(`📊 Admin: Retrieved approval stats for ${adminUser.email}`);

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          pending,
          approved,
          rejected,
          suspended,
          total
        }
      }
    });

  } catch (error: any) {
    console.error('Get approval stats error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve approval stats"
    });
  }
};
