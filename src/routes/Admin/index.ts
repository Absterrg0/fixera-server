import { Router } from "express";
import {
  getPendingProfessionals,
  getProfessionalDetails,
  requireAdmin,
  approveProfessional,
  rejectProfessional,
  suspendProfessional,
  reactivateProfessional,
  verifyIdProof,
  reviewIdChanges,
  getApprovalStats
} from "../../handlers/Admin/professionalApprovals";
import {
  getLoyaltyConfig,
  updateLoyaltyConfig,
  recalculateCustomerTiers,
  getLoyaltyAnalytics,
  getPointsConfig,
  updatePointsConfig,
  adjustUserPoints,
  getPointsAnalytics,
  getProfessionalLevelConfig,
  updateProfessionalLevelConfig,
  recalculateProfessionalLevels,
  listProfessionalManagement,
  updateProfessionalManagement,
  listCustomerManagement,
  updateCustomerManagement
} from "../../handlers/Admin/loyaltyManagement";
import {
  getAllServiceConfigurations,
  getServiceConfigurationById,
  createServiceConfiguration,
  updateServiceConfiguration,
  deleteServiceConfiguration,
  toggleServiceConfigurationActive,
  getCategories,
  getServicesByCategory
} from "../../handlers/Admin/serviceConfigurationManagement";
import { getPayments, capturePayment } from "../../handlers/Admin/payments";
import {
  getReferralConfig,
  updateReferralConfig,
  getReferralAnalytics,
  getReferralList,
  revokeReferral
} from "../../handlers/Admin/referralManagement";
import {
  getPlatformSettings,
  updatePlatformSettings,
} from "../../handlers/Admin/platformSettings";
import {
  getAdminReviews,
  hideReview,
  unhideReview,
  getHiddenReviews,
} from "../../handlers/Admin/reviewModeration";
import {
  getDisputes,
  getDisputeDetails,
  resolveDispute,
  getDisputeAnalytics,
} from "../../handlers/Admin/disputeManagement";
import { deleteUser } from "../../handlers/Admin/userDeletion";
import {
  getFavoritesOverview,
  listAllFavorites,
  deleteFavorite,
} from "../../handlers/Admin/favoritesAdmin";
import { runWarrantyClaimChecks } from "../../utils/warrantyClaimScheduler";
import { runRfqDeadlineCheck } from "../../utils/rfqDeadlineScheduler";
import { runDisputeSlaCheck } from "../../utils/disputeSlaScheduler";
import {
  listCmsContent,
  getCmsContentById,
  createCmsContent,
  updateCmsContent,
  deleteCmsContent,
  uploadCmsImage,
  listFaqCategories,
  getCmsPreviewBySlug,
  listCmsLandingSlots,
  syncCmsLandingSlots,
  listCmsServiceOptions,
} from "../../handlers/Admin/cmsManagement";
import {
  listDiscountCodes,
  getDiscountCode,
  createDiscountCode,
  updateDiscountCode,
  deleteDiscountCode,
} from "../../handlers/Admin/discountCodes";
import { uploadProfileImage as cmsImageMulter } from "../../utils/s3Upload";
import { getAdminSiteSettings, updateAdminSiteSettings } from "../../handlers/Admin/siteSettings";
import {
  adminListTickets,
  adminUpdateTicket,
  adminListMeetingRequests,
  adminUpdateMeetingRequest,
} from "../../handlers/Admin/support";
import { listEmailLogs } from "../../handlers/Admin/emailLogs";
import {
  listCancellationRequests,
  getCancellationRequest,
  approveCancellationRequest,
  denyCancellationRequest,
} from "../../handlers/Admin/cancellationRequests";
import {
  listChatReports,
  getChatReport,
  resolveChatReport,
  adminGetConversation,
  adminGetConversationMessages,
  adminStartSupportChat,
} from "../../handlers/Admin/chatModeration";
import { getAdminBookingDetail } from "../../handlers/Admin/bookingDetail";
import {
  getKpiSummary,
  getKpiByRegion,
  getKpiByService,
  getKpiProfessionalResponse,
  exportKpiCsv,
  triggerKpiEmailReport,
} from "../../handlers/Admin/kpiDashboard";

const adminRouter = Router();

// All admin routes require authentication and admin role
adminRouter.use(requireAdmin);

// Professional management routes (must be before :professionalId param routes)
adminRouter.route('/professionals/manage').get(listProfessionalManagement);
adminRouter.route('/professionals/manage/:professionalId').patch(updateProfessionalManagement);

// Professional approval routes
adminRouter.route('/professionals').get(getPendingProfessionals);
adminRouter.route('/professionals/:professionalId').get(getProfessionalDetails);
adminRouter.route('/professionals/:professionalId/approve').put(approveProfessional);
adminRouter.route('/professionals/:professionalId/reject').put(rejectProfessional);
adminRouter.route('/professionals/:professionalId/suspend').put(suspendProfessional);
adminRouter.route('/professionals/:professionalId/reactivate').put(reactivateProfessional);
adminRouter.route('/professionals/:professionalId/verify-id').put(verifyIdProof);
adminRouter.route('/professionals/:professionalId/id-changes').put(reviewIdChanges);
adminRouter.route('/stats/approvals').get(getApprovalStats);

// Loyalty system management routes
adminRouter.route('/loyalty/config').get(getLoyaltyConfig).put(updateLoyaltyConfig);
adminRouter.route('/loyalty/recalculate').post(recalculateCustomerTiers);
adminRouter.route('/loyalty/analytics').get(getLoyaltyAnalytics);

// Points system management routes
adminRouter.route('/points/config').get(getPointsConfig).put(updatePointsConfig);
adminRouter.route('/points/analytics').get(getPointsAnalytics);
adminRouter.route('/points/adjust').post(adjustUserPoints);

// Professional level management routes
adminRouter.route('/professional-levels/config').get(getProfessionalLevelConfig).put(updateProfessionalLevelConfig);
adminRouter.route('/professional-levels/recalculate').post(recalculateProfessionalLevels);
adminRouter.route('/customers/manage').get(listCustomerManagement);
adminRouter.route('/customers/manage/:customerId').patch(updateCustomerManagement);

// Referral system management routes
adminRouter.route('/referral/config').get(getReferralConfig);
adminRouter.route('/referral/config').put(updateReferralConfig);
adminRouter.route('/referral/analytics').get(getReferralAnalytics);
adminRouter.route('/referral/list').get(getReferralList);
adminRouter.route('/referral/:referralId/revoke').put(revokeReferral);

// Service configuration management routes
adminRouter.route('/service-configurations').get(getAllServiceConfigurations);
adminRouter.route('/service-configurations').post(createServiceConfiguration);
adminRouter.route('/service-configurations/categories').get(getCategories);
adminRouter.route('/service-configurations/services/:category').get(getServicesByCategory);
adminRouter.route('/service-configurations/:id').get(getServiceConfigurationById);
adminRouter.route('/service-configurations/:id').put(updateServiceConfiguration);
adminRouter.route('/service-configurations/:id').delete(deleteServiceConfiguration);
adminRouter.route('/service-configurations/:id/toggle-active').patch(toggleServiceConfigurationActive);
adminRouter.route('/payments').get(getPayments);
adminRouter.route('/payments/:paymentId/capture').post(capturePayment);

// Review moderation routes
adminRouter.route('/reviews').get(getAdminReviews);
adminRouter.route('/reviews/hidden').get(getHiddenReviews);
adminRouter.route('/reviews/:bookingId/hide').put(hideReview);
adminRouter.route('/reviews/:bookingId/unhide').put(unhideReview);

// Dispute management routes
adminRouter.route('/disputes').get(getDisputes);
adminRouter.route('/disputes/analytics').get(getDisputeAnalytics);
adminRouter.route('/disputes/:bookingId').get(getDisputeDetails);
adminRouter.route('/disputes/:bookingId/resolve').post(resolveDispute);

// User deletion route
adminRouter.route('/users/:userId').delete(deleteUser);

// Favorites admin routes
adminRouter.route('/favorites/overview').get(getFavoritesOverview);
adminRouter.route('/favorites').get(listAllFavorites);
adminRouter.route('/favorites/:id').delete(deleteFavorite);

// Platform settings routes
adminRouter.route('/platform-settings').get(getPlatformSettings).put(updatePlatformSettings);

// Site settings (social media links etc)
adminRouter.route('/site-settings').get(getAdminSiteSettings).put(updateAdminSiteSettings);

// Professional support management
adminRouter.route('/support/tickets').get(adminListTickets);
adminRouter.route('/support/tickets/:id').patch(adminUpdateTicket);
adminRouter.route('/support/meeting-requests').get(adminListMeetingRequests);
adminRouter.route('/support/meeting-requests/:id').patch(adminUpdateMeetingRequest);

// Discount code management routes
adminRouter.route('/discount-codes').get(listDiscountCodes).post(createDiscountCode);
adminRouter.route('/discount-codes/:id').get(getDiscountCode).patch(updateDiscountCode).delete(deleteDiscountCode);

// CMS management routes
adminRouter.route('/cms').get(listCmsContent).post(createCmsContent);
adminRouter.route('/cms/faq-categories').get(listFaqCategories);
adminRouter.route('/cms/landing-slots').get(listCmsLandingSlots);
adminRouter.route('/cms/landing-slots/sync').post(syncCmsLandingSlots);
adminRouter.route('/cms/service-options').get(listCmsServiceOptions);
adminRouter.route('/cms/upload-image').post(cmsImageMulter.single('image'), uploadCmsImage);
adminRouter.route('/cms/preview/:type/:slug').get(getCmsPreviewBySlug);
adminRouter.route('/cms/:id').get(getCmsContentById).put(updateCmsContent).delete(deleteCmsContent);

// Email logs
adminRouter.route('/email-logs').get(listEmailLogs);

// Cancellation requests
adminRouter.route('/cancellation-requests').get(listCancellationRequests);
adminRouter.route('/cancellation-requests/:id').get(getCancellationRequest);
adminRouter.route('/cancellation-requests/:id/approve').post(approveCancellationRequest);
adminRouter.route('/cancellation-requests/:id/deny').post(denyCancellationRequest);

// Booking detail (consolidated)
adminRouter.route('/bookings/:id/full').get(getAdminBookingDetail);

// Chat moderation
adminRouter.route('/chat-reports').get(listChatReports);
adminRouter.route('/chat-reports/:id').get(getChatReport);
adminRouter.route('/chat-reports/:id/resolve').post(resolveChatReport);
adminRouter.route('/conversations/:id').get(adminGetConversation);
adminRouter.route('/conversations/:id/messages').get(adminGetConversationMessages);
adminRouter.route('/chat/start-support').post(adminStartSupportChat);

// Manual scheduler triggers
adminRouter.route('/run-warranty-checks').post(async (_req, res) => {
  try {
    const result = await runWarrantyClaimChecks();
    return res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[Admin] Manual warranty check failed:', error);
    return res.status(500).json({ success: false, msg: 'Warranty check failed' });
  }
});

adminRouter.route('/run-rfq-checks').post(async (_req, res) => {
  try {
    const result = await runRfqDeadlineCheck();
    return res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[Admin] Manual RFQ check failed:', error);
    return res.status(500).json({ success: false, msg: 'RFQ deadline check failed' });
  }
});

adminRouter.route('/run-dispute-sla-check').post(async (_req, res) => {
  try {
    const result = await runDisputeSlaCheck();
    return res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[Admin] Manual dispute SLA check failed:', error);
    return res.status(500).json({ success: false, msg: 'Dispute SLA check failed' });
  }
});

// Monthly KPI dashboard
adminRouter.route('/kpi/summary').get(getKpiSummary);
adminRouter.route('/kpi/by-region').get(getKpiByRegion);
adminRouter.route('/kpi/by-service').get(getKpiByService);
adminRouter.route('/kpi/professional-response').get(getKpiProfessionalResponse);
adminRouter.route('/kpi/export').get(exportKpiCsv);
adminRouter.route('/kpi/email-report').post(triggerKpiEmailReport);

export default adminRouter;
