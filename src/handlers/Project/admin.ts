import { Request, Response } from 'express';
import Project from '../../models/project';
import User from '../../models/user';
import Favorite from '../../models/favorite';
import { invalidateFavoritesOverviewCache } from '../Admin/favoritesAdmin';
import {
    sendProjectApprovalEmail,
    sendProjectRejectionEmail,
    sendProjectDeletedEmail,
    sendProjectDeactivatedEmail,
    sendProjectReactivatedEmail
} from '../../utils/emailService';
import { getProfessionalDisplayName } from '../../utils/displayName';
import { getPresignedUrl, parseS3KeyFromUrl } from '../../utils/s3Upload';

// Helper: presign all file URLs (certifications and attachments) for admin viewing
const presignProjectFiles = async (projectObj: any) => {
    const clone = { ...projectObj };

    // Certifications
    if (Array.isArray(clone.certifications)) {
        clone.certifications = await Promise.all(
            clone.certifications.map(async (c: any) => {
                const fileUrl = c?.fileUrl || c?.certificateUrl;
                if (fileUrl) {
                    const key = parseS3KeyFromUrl(fileUrl);
                    if (key) {
                        // Use long-lived expiry (max ~7 days for SigV4)
                        const signed = await getPresignedUrl(key, 7 * 24 * 60 * 60);
                        return { ...c, fileUrl: signed };
                    }
                }
                return c;
            })
        );
    }

    // RFQ Questions attachments
    if (Array.isArray(clone.rfqQuestions)) {
        clone.rfqQuestions = await Promise.all(
            clone.rfqQuestions.map(async (q: any) => {
                if (Array.isArray(q?.professionalAttachments)) {
                    const signedAttachments = await Promise.all(
                        q.professionalAttachments.map(async (a: any) => {
                            const url = typeof a === 'string' ? a : a?.url;
                            if (url) {
                                const key = parseS3KeyFromUrl(url);
                                if (key) {
                                    const signed = await getPresignedUrl(key, 7 * 24 * 60 * 60);
                                    return signed;
                                }
                            }
                            return a;
                        })
                    );
                    return { ...q, professionalAttachments: signedAttachments };
                }
                return q;
            })
        );
    }

    // Post-Booking Questions attachments
    if (Array.isArray(clone.postBookingQuestions)) {
        clone.postBookingQuestions = await Promise.all(
            clone.postBookingQuestions.map(async (q: any) => {
                if (Array.isArray(q?.professionalAttachments)) {
                    const signedAttachments = await Promise.all(
                        q.professionalAttachments.map(async (a: any) => {
                            const url = typeof a === 'string' ? a : a?.url;
                            if (url) {
                                const key = parseS3KeyFromUrl(url);
                                if (key) {
                                    const signed = await getPresignedUrl(key, 7 * 24 * 60 * 60);
                                    return signed;
                                }
                            }
                            return a;
                        })
                    );
                    return { ...q, professionalAttachments: signedAttachments };
                }
                return q;
            })
        );
    }

    return clone;
};

export const getPendingProjects = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        // Get all pending projects with full details
        const pendingProjects = await Project.find({
            status: 'pending'
        }).sort({ submittedAt: 1 });

        // Enrich with professional information
        const projectsWithProfessional = await Promise.all(
            pendingProjects.map(async (project) => {
                const professional = await User.findById(project.professionalId).select(
                    'name email phone businessInfo professionalStatus'
                );
                const base = {
                    ...project.toObject(),
                    professional: professional ? {
                        name: professional.name,
                        email: professional.email,
                        phone: professional.phone,
                        businessInfo: professional.businessInfo,
                        professionalStatus: professional.professionalStatus
                    } : null
                };
                return await presignProjectFiles(base);
            })
        );

        res.json(projectsWithProfessional);
    } catch (error) {
        console.error('Failed to fetch pending projects:', error);
        res.status(500).json({ error: 'Failed to fetch pending projects' });
    }
};

export const approveProject = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'pending' },
            {
                $set: {
                    status: 'published',
                    approvedAt: new Date(),
                    approvedBy: req.user?.id,
                    isResubmission: false,
                },
                $unset: {
                    previousSnapshot: 1,
                    pendingChanges: 1,
                    reapprovalType: 1,
                },
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Get professional details for email
        const professional = await User.findById(project.professionalId);
        console.log('Professional found:', !!professional);

        if (professional && professional.email) {
            const emailSent = await sendProjectApprovalEmail(
                professional.email,
                getProfessionalDisplayName(professional),
                project.title,
                String(project._id)
            );
            console.log('Approval email send result:', emailSent ? 'SUCCESS' : 'FAILED');
        } else {
            console.log('No email sent - professional or email not found');
        }

        res.json({ message: 'Project approved', project });
    } catch (error) {
        console.error('Failed to approve project:', error);
        res.status(500).json({ error: 'Failed to approve project' });
    }
};

export const rejectProject = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const { feedback } = req.body;

        if (!feedback || feedback.trim().length === 0) {
            return res.status(400).json({ error: 'Rejection reason is required' });
        }

        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'pending' },
            {
                $set: {
                    status: 'rejected',
                    adminFeedback: feedback,
                    isResubmission: false,
                },
                $unset: {
                    previousSnapshot: 1,
                    pendingChanges: 1,
                    reapprovalType: 1,
                },
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Get professional details for email
        const professional = await User.findById(project.professionalId);
        console.log('Professional found:', !!professional);

        if (professional && professional.email) {
            const emailSent = await sendProjectRejectionEmail(
                professional.email,
                getProfessionalDisplayName(professional),
                project.title,
                feedback,
                String(project._id)
            );
            console.log('Rejection email send result:', emailSent ? 'SUCCESS' : 'FAILED');
        } else {
            console.log('No email sent - professional or email not found');
        }

        res.json({ message: 'Project rejected', project });
    } catch (error) {
        console.error('Failed to reject project:', error);
        res.status(500).json({ error: 'Failed to reject project' });
    }
};

// Delete a project (admin only)
export const deleteProjectByAdmin = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const { reason } = req.body;

        if (!reason || reason.trim().length === 0) {
            return res.status(400).json({ error: 'Deletion reason is required' });
        }

        const project = await Project.findById(id);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Get professional details for email before deletion
        const professional = await User.findById(project.professionalId);
        const projectTitle = project.title;

        // Delete the project
        await Project.findByIdAndDelete(id);
        try {
            await Favorite.deleteMany({ targetType: 'project', targetId: id });
        } catch (cleanupErr) {
            console.warn('Favorite cleanup failed after admin project delete', { projectId: id, error: cleanupErr });
        } finally {
            invalidateFavoritesOverviewCache();
        }

        // Send email notification
        if (professional && professional.email) {
            await sendProjectDeletedEmail(
                professional.email,
                getProfessionalDisplayName(professional),
                projectTitle,
                reason
            );
        }

        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        console.error('Failed to delete project:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
};

// Deactivate a published project (admin only)
export const deactivateProject = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const { reason } = req.body;

        if (!reason || reason.trim().length === 0) {
            return res.status(400).json({ error: 'Deactivation reason is required' });
        }

        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'published' },
            {
                status: 'suspended',
                adminFeedback: reason
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Published project not found' });
        }

        // Get professional details for email
        const professional = await User.findById(project.professionalId);
        if (professional && professional.email) {
            await sendProjectDeactivatedEmail(
                professional.email,
                getProfessionalDisplayName(professional),
                project.title,
                reason,
                String(project._id)
            );
        }

        res.json({ message: 'Project deactivated', project });
    } catch (error) {
        console.error('Failed to deactivate project:', error);
        res.status(500).json({ error: 'Failed to deactivate project' });
    }
};

// Reactivate a deactivated project (admin only)
export const reactivateProject = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;

        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'suspended' },
            {
                status: 'published',
                adminFeedback: undefined // Clear the feedback
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Deactivated project not found' });
        }

        // Get professional details for email
        const professional = await User.findById(project.professionalId);
        if (professional && professional.email) {
            await sendProjectReactivatedEmail(
                professional.email,
                getProfessionalDisplayName(professional),
                project.title,
                String(project._id)
            );
        }

        res.json({ message: 'Project reactivated', project });
    } catch (error) {
        console.error('Failed to reactivate project:', error);
        res.status(500).json({ error: 'Failed to reactivate project' });
    }
};

// Get change details for a project (admin only)
export const getProjectChanges = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const project = await Project.findById(id);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json({
            isResubmission: project.isResubmission || false,
            reapprovalType: project.reapprovalType || null,
            changes: project.pendingChanges || [],
        });
    } catch (error) {
        console.error('Failed to fetch project changes:', error);
        res.status(500).json({ error: 'Failed to fetch project changes' });
    }
};

// Get approved (published/on_hold) projects for admin moderation
export const getApprovedProjects = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { status } = req.query as any;
        const statuses = status === 'on_hold'
            ? ['on_hold']
            : status === 'published'
            ? ['published']
            : status === 'suspended'
            ? ['suspended']
            : ['published', 'on_hold', 'suspended'];

        const approved = await Project.find({ status: { $in: statuses } })
            .sort({ approvedAt: -1, updatedAt: -1 });

        const withProfessional = await Promise.all(
            approved.map(async (project) => {
                const professional = await User.findById(project.professionalId).select(
                    'name email phone businessInfo professionalStatus'
                );
                const base = {
                    ...project.toObject(),
                    professional: professional ? {
                        name: professional.name,
                        email: professional.email,
                        phone: professional.phone,
                        businessInfo: professional.businessInfo,
                        professionalStatus: professional.professionalStatus
                    } : null
                };
                return await presignProjectFiles(base);
            })
        );

        res.json(withProfessional);
    } catch (error) {
        console.error('Failed to fetch approved projects:', error);
        res.status(500).json({ error: 'Failed to fetch approved projects' });
    }
};
