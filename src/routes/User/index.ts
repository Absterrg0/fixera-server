import { Router, Request, Response, NextFunction } from "express";
import { VerifyPhone } from "../../handlers/User/verify/phone";
import { VerifyPhoneCheck } from "../../handlers/User/verify/phone";
import emailVerificationRoutes from "./verify/email";
import { protect } from "../../middlewares/auth";
import { GetCurrentUser } from "../../handlers";
import { validateVAT, updateUserVAT, validateAndPopulateVAT } from "../../handlers/User/validateVat";
import { uploadIdProof, updateProfessionalProfile, submitForVerification, updatePhone, updateCustomerProfile, updateIdInfo, uploadProfileImage, deleteProfileImage, checkUsernameAvailability, generateUsernameSuggestionsHandler, updateUsername } from "../../handlers/User/profileManagement";
import { upload, uploadProfileImage as profileImageUpload } from "../../utils/s3Upload";
import { getLoyaltyStatus, addSpending, getLeaderboard, getUserPointsBalance, getUserPointsHistory, getProfessionalLevelStatus, boostProfessionalLevel } from "../../handlers/User/loyaltyManagement";
import { inviteEmployee, getEmployees, updateEmployeeStatus, acceptInvitation, updateEmployeeEmail, removeEmployee } from "../../handlers/User/employeeManagement";
import { changePassword, resetEmployeePassword } from "../../handlers/User/passwordManagement";
import {
    updateEmployeeAvailabilityPreference,
    updateEmployeeAvailability,
    getEmployeeEffectiveAvailability,
    updateManagedEmployeeAvailability
} from "../../handlers/User/employeeAvailability";
import {
    getServiceConfigurationForProfessional,
    getDynamicFieldsForService,
    getCategoriesForProfessional,
    getServicesByCategoryForProfessional,
    getAreasOfWork
} from "../../handlers/Professional/serviceConfigurationHandler";
import {
    saveProjectDraft,
    getProject,
    getAllProjects,
    submitProject,
    deleteProject,
    getEmployeeAssignedProjects
} from "../../handlers/Professional/projectManagement";
import {
    uploadProjectImage,
    uploadProjectVideo,
    uploadCertification,
    uploadQuestionAttachment
} from "../../handlers/Professional/fileUpload";
import { validateAddress, getGoogleMapsConfig } from "../../handlers/User/googleMaps";
import { getReferralStats, generateUserReferralCode, addLateReferralCode } from "../../handlers/User/referralManagement";
import { getProfessionalFavoriteStats, dismissFavoriteNotifications } from "../../handlers/Favorites";
import { exportMyData } from "../../handlers/User/dataExport";
import { deleteMyAccount } from "../../handlers/User/accountManagement";

const userRouter = Router();

const handleProfileImageUpload = (req: Request, res: Response, next: NextFunction) => {
    profileImageUpload.single('profileImage')(req, res, (error: any) => {
        if (error) {
            return res.status(400).json({
                success: false,
                msg: error.message || 'Invalid profile image upload'
            });
        }
        next();
    });
};

userRouter.use(protect)

userRouter.route('/me').get(GetCurrentUser)
userRouter.route("/verify-phone").post(VerifyPhone)
userRouter.route("/verify-phone-check").post(VerifyPhoneCheck)
userRouter.use("/verify-email", emailVerificationRoutes);
userRouter.route("/vat/validate").post(validateVAT)
userRouter.route("/vat").put(updateUserVAT)
userRouter.route("/vat/validate-and-populate").post(validateAndPopulateVAT) 
userRouter.route("/id-proof").post(upload.single('idProof'), uploadIdProof)
userRouter.route("/profile-image").post(handleProfileImageUpload, uploadProfileImage).delete(deleteProfileImage)
userRouter.route("/professional-profile").put(updateProfessionalProfile)
userRouter.route("/check-username/:username").get(checkUsernameAvailability)
userRouter.route("/generate-username").get(generateUsernameSuggestionsHandler)
userRouter.route("/username").put(updateUsername)
userRouter.route("/submit-for-verification").post(submitForVerification)
userRouter.route("/phone").put(updatePhone)
userRouter.route("/customer-profile").put(updateCustomerProfile)
userRouter.route("/id-info").put(updateIdInfo)
userRouter.route("/loyalty/status").get(getLoyaltyStatus)
userRouter.route("/loyalty/add-spending").post(addSpending)
userRouter.route("/loyalty/leaderboard").get(getLeaderboard)

// Points Routes
userRouter.route("/points/balance").get(getUserPointsBalance)
userRouter.route("/points/history").get(getUserPointsHistory)

// Professional Level Routes
userRouter.route("/professional-level").get(getProfessionalLevelStatus)
userRouter.route("/professional-level/boost").post(boostProfessionalLevel)

// Referral Routes
userRouter.route("/referral/stats").get(getReferralStats)
userRouter.route("/referral/generate-code").post(generateUserReferralCode)
userRouter.route("/referral/add-late-code").post(addLateReferralCode)

// Employee Management Routes
userRouter.route("/employee/invite").post(inviteEmployee)
userRouter.route("/employee/list").get(getEmployees)
userRouter.route("/employee/:employeeId/status").put(updateEmployeeStatus)
userRouter.route("/employee/:employeeId/email").put(updateEmployeeEmail)
userRouter.route("/employee/:employeeId").delete(removeEmployee)
userRouter.route("/employee/accept-invitation").post(acceptInvitation)

// Password Management Routes
userRouter.route("/change-password").put(changePassword)
userRouter.route("/employee/reset-password").put(resetEmployeePassword)

// Employee Availability Routes
userRouter.route("/employee/availability/preference").put(updateEmployeeAvailabilityPreference)
userRouter.route("/employee/availability").put(updateEmployeeAvailability)
userRouter.route("/employee/availability/effective").get(getEmployeeEffectiveAvailability)
userRouter.route("/employee/:employeeId/availability").put(updateManagedEmployeeAvailability)

// Service Configuration Routes (for Professionals)
userRouter.route("/service-configuration").get(getServiceConfigurationForProfessional)
userRouter.route("/service-configuration/dynamic-fields").get(getDynamicFieldsForService)
userRouter.route("/categories").get(getCategoriesForProfessional)
userRouter.route("/services/:category").get(getServicesByCategoryForProfessional)
userRouter.route("/areas-of-work").get(getAreasOfWork)

// Project Management Routes
userRouter.route("/projects").get(getAllProjects).post(saveProjectDraft)
userRouter.route("/projects/:id").get(getProject).delete(deleteProject)
userRouter.route("/projects/:id/submit").post(submitProject)

// Employee Project Routes
userRouter.route("/employee/projects").get(getEmployeeAssignedProjects)

// Project File Upload Routes
userRouter.route("/projects/upload/image").post(upload.single('image'), uploadProjectImage)
userRouter.route("/projects/upload/video").post(upload.single('video'), uploadProjectVideo)
userRouter.route("/projects/upload/certification").post(upload.single('certification'), uploadCertification)
userRouter.route("/projects/upload/attachment").post(upload.single('attachment'), uploadQuestionAttachment)

// Google Maps Routes
userRouter.route("/validate-address").post(validateAddress)
userRouter.route("/google-maps-config").get(getGoogleMapsConfig)

// Professional favorites stats + in-app notification dismissal
userRouter.route("/professional/favorites-stats").get(getProfessionalFavoriteStats)
userRouter.route("/professional/favorites-notifications/seen").post(dismissFavoriteNotifications)

// GDPR — data export and account deletion (right-to-be-forgotten)
userRouter.route("/me/export").get(exportMyData)
userRouter.route("/me/account").delete(deleteMyAccount)

// Platform commission (read-only for professionals)
userRouter.route("/commission-rate").get(async (req, res) => {
  try {
    const PlatformSettings = (await import("../../models/platformSettings")).default;
    const config = await PlatformSettings.getCurrentConfig();
    return res.status(200).json({ success: true, data: { commissionPercent: config.commissionPercent } });
  } catch (error) {
    console.error("Failed to retrieve commission rate:", error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve commission rate" });
  }
});

export default userRouter;
