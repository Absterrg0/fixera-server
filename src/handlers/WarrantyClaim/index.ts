import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import Booking from "../../models/booking";
import WarrantyClaim, {
  IWarrantyClaim,
  WarrantyClaimStatus,
} from "../../models/warrantyClaim";
import Conversation from "../../models/conversation";
import ChatMessage from "../../models/chatMessage";
import User from "../../models/user";
import { addWorkingDays } from "../../utils/workingDays";
import {
  addWarrantyDuration,
  getBookingWarrantyDuration,
  normalizeWarrantyDuration,
} from "../../utils/warranty";
import {
  deleteFromS3,
  generateFileName,
  parseS3KeyFromUrl,
  uploadToS3,
  validateFile,
  validateImageFileBuffer,
  validateVideoFile,
  isAllowedS3Url,
  presignS3Url,
} from "../../utils/s3Upload";
import { SYSTEM_USER_ID } from "../../constants/system";
import {
  sendWarrantyClaimOpenedEmail,
  sendWarrantyProposalSentEmail,
} from "../../utils/emailService";
import { getProfessionalDisplayName } from "../../utils/displayName";

const WARRANTY_ADMIN_NOTIFICATIONS_EMAIL = process.env.ADMIN_NOTIFICATIONS_EMAIL || process.env.FROM_EMAIL || '';

const PROFESSIONAL_RESPONSE_DAYS = 5;
const CUSTOMER_AUTO_CLOSE_DAYS = 7;
const ACTIVE_CLAIM_STATUSES: WarrantyClaimStatus[] = [
  "open",
  "proposal_sent",
  "proposal_accepted",
  "resolved",
  "escalated",
];

const APPROVABLE_RESOLVE_STATUSES: WarrantyClaimStatus[] = [
  "open",
  "proposal_sent",
  "proposal_accepted",
  "escalated",
];

const isApprovableStatus = (status: WarrantyClaimStatus): boolean =>
  APPROVABLE_RESOLVE_STATUSES.includes(status);

const getWarrantyUploadKeyForUser = (userId: string) => `warranty-claims/${userId}/`;

const isWarrantyUrlOwnedByUser = (url: string, userId: string) => {
  const key = parseS3KeyFromUrl(url);
  return Boolean(key && key.startsWith(getWarrantyUploadKeyForUser(userId)));
};

const getParticipantWarrantyPrefixes = (claim: any) =>
  [claim?.customer, claim?.professional]
    .map((value) => (value ? String(value) : ""))
    .filter(Boolean)
    .map((userId) => getWarrantyUploadKeyForUser(userId));

const canPresignWarrantyUrlForClaim = (url: string, claim: any) => {
  const key = parseS3KeyFromUrl(url);
  if (!key || !key.startsWith("warranty-claims/")) return false;
  return getParticipantWarrantyPrefixes(claim).some((prefix) => key.startsWith(prefix));
};

const validateWarrantyUrlsForUser = (urls: string[], userId: string) => {
  const validUrls = Array.from(new Set(urls.filter((url) => isAllowedS3Url(url) && isWarrantyUrlOwnedByUser(url, userId))));
  const invalidUrls = urls.filter((url) => !validUrls.includes(url));
  return { validUrls, invalidUrls };
};

const validateWarrantyUrlsForClaim = (urls: string[], claim: any, userId: string) => {
  const existingUrls = new Set([
    ...(Array.isArray(claim?.evidence) ? claim.evidence : []),
    ...(Array.isArray(claim?.resolution?.attachments) ? claim.resolution.attachments : []),
  ]);

  const validUrls = Array.from(
    new Set(
      urls.filter((url) => {
        if (!isAllowedS3Url(url)) return false;
        if (existingUrls.has(url)) return true;
        return isWarrantyUrlOwnedByUser(url, userId);
      })
    )
  );
  const invalidUrls = urls.filter((url) => !validUrls.includes(url));
  return { validUrls, invalidUrls };
};

const presignClaim = async (claim: any) => {
  if (!claim) return claim;
  const obj = claim.toObject ? claim.toObject() : { ...claim };
  if (Array.isArray(obj.evidence) && obj.evidence.length > 0) {
    const results = await Promise.all(
      obj.evidence.map(async (url: string) => {
        if (!canPresignWarrantyUrlForClaim(url, obj)) {
          return url;
        }
        const signed = await presignS3Url(url);
        return signed ?? url;
      })
    );
    obj.evidence = results;
  }
  if (Array.isArray(obj.resolution?.attachments) && obj.resolution.attachments.length > 0) {
    obj.resolution.attachments = await Promise.all(
      obj.resolution.attachments.map(async (url: string) => {
        if (!canPresignWarrantyUrlForClaim(url, obj)) {
          return url;
        }
        const signed = await presignS3Url(url);
        return signed ?? url;
      })
    );
  }
  return obj;
};

const getRequestUserId = (req: Request): string | null => {
  const userIdRaw = req.user?._id;
  if (!userIdRaw) return null;
  return typeof userIdRaw === "string" ? userIdRaw : userIdRaw.toString();
};

const getUserRole = (req: Request): string | null => {
  return req.user?.role || null;
};

const toObjectId = (value: string) =>
  mongoose.Types.ObjectId.createFromHexString(value);

const isAdmin = (req: Request) => getUserRole(req) === "admin";

const ensureConversationLabel = async (
  conversationId: Types.ObjectId,
  userId: Types.ObjectId,
  label: string,
  session?: mongoose.ClientSession
) => {
  await Conversation.findByIdAndUpdate(conversationId, [
    {
      $set: {
        labels: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ["$labels", []] },
                as: "l",
                cond: {
                  $not: {
                    $and: [
                      { $eq: ["$$l.userId", userId] },
                      { $eq: ["$$l.label", label] },
                    ],
                  },
                },
              },
            },
            [{ userId, label }],
          ],
        },
      },
    },
  ], session ? { session } : undefined);
};

const ensureWarrantyChatContext = async ({
  customerId,
  professionalId,
  actorId,
  text,
  claimId,
  claimNumber,
  bookingId,
  status,
}: {
  customerId: Types.ObjectId;
  professionalId: Types.ObjectId;
  actorId?: Types.ObjectId;
  text: string;
  claimId?: Types.ObjectId | string;
  claimNumber?: string;
  bookingId?: Types.ObjectId | string;
  status?: string;
}) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    let conversation = await Conversation.findOne({
      customerId,
      professionalId,
    }).session(session);

    if (!conversation) {
      const [created] = await Conversation.create(
        [{ customerId, professionalId, initiatedBy: actorId || customerId }],
        { session }
      );
      conversation = created;
    }

    await Conversation.findByIdAndUpdate(
      conversation._id,
      {
        $pull: { archivedBy: { $in: [customerId, professionalId] } },
        $set: { status: "active" },
      },
      { session }
    );

    await Promise.all([
      ensureConversationLabel(conversation._id, customerId, "Warranty Claim Discussion", session),
      ensureConversationLabel(
        conversation._id,
        professionalId,
        "Warranty Claim Discussion",
        session
      ),
    ]);

    const senderId = actorId || SYSTEM_USER_ID;
    if (claimId && !claimNumber) {
      throw new Error("Warranty notification requires claimNumber when claimId is provided");
    }

    await ChatMessage.create(
      [
        {
          conversationId: conversation._id,
          senderId,
          senderRole: "system",
          messageType: claimId ? "warranty_notification" : "text",
          text,
          ...(claimId
            ? {
                warrantyMeta: {
                  claimId: claimId.toString(),
                  claimNumber,
                  ...(bookingId ? { bookingId: bookingId.toString() } : {}),
                  ...(status ? { status } : {}),
                },
              }
            : {}),
          readBy: actorId ? [{ userId: actorId, readAt: new Date() }] : [],
        },
      ],
      { session }
    );

    const actorIsCustomer = actorId?.toString() === customerId.toString();
    const actorIsProfessional = actorId?.toString() === professionalId.toString();
    const setUpdate: Record<string, any> = {
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 200),
      lastMessageSenderId: senderId,
    };
    const incUpdate: Record<string, number> = {};

    if (actorIsCustomer) {
      setUpdate.customerUnreadCount = 0;
      incUpdate.professionalUnreadCount = 1;
    } else if (actorIsProfessional) {
      setUpdate.professionalUnreadCount = 0;
      incUpdate.customerUnreadCount = 1;
    } else {
      incUpdate.customerUnreadCount = 1;
      incUpdate.professionalUnreadCount = 1;
    }

    await Conversation.findByIdAndUpdate(
      conversation._id,
      {
        $set: setUpdate,
        ...(Object.keys(incUpdate).length ? { $inc: incUpdate } : {}),
      },
      { session }
    );

    await session.commitTransaction();
    return conversation;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const parseClaimStatus = (statusRaw: unknown): WarrantyClaimStatus | null => {
  const status = typeof statusRaw === "string" ? statusRaw : "";
  if (
    status === "open" ||
    status === "proposal_sent" ||
    status === "proposal_accepted" ||
    status === "resolved" ||
    status === "escalated" ||
    status === "closed"
  ) {
    return status;
  }
  return null;
};

/**
 * Ensures booking has a fully populated warrantyCoverage snapshot.
 * May call booking.save() when coverage fields are missing (startsAt, endsAt, duration).
 */
const ensureWarrantyCoverage = async (booking: any) => {
  const duration = getBookingWarrantyDuration(booking);
  if (!duration || duration.value <= 0) return null;

  const storedDuration = normalizeWarrantyDuration(
    booking.warrantyCoverage?.duration
  );
  const effectiveDuration = storedDuration || duration;

  const startDate =
    booking.warrantyCoverage?.startsAt ||
    booking.actualEndDate ||
    booking.updatedAt ||
    booking.createdAt;
  if (!startDate) return null;

  const startsAt =
    booking.warrantyCoverage?.startsAt instanceof Date
      ? booking.warrantyCoverage.startsAt
      : new Date(startDate);
  const endsAt =
    booking.warrantyCoverage?.endsAt instanceof Date
      ? booking.warrantyCoverage.endsAt
      : addWarrantyDuration(startsAt, effectiveDuration);

  const shouldPersist =
    !booking.warrantyCoverage ||
    !booking.warrantyCoverage.startsAt ||
    !booking.warrantyCoverage.endsAt ||
    !booking.warrantyCoverage.duration;

  if (shouldPersist) {
    booking.warrantyCoverage = {
      duration: effectiveDuration,
      startsAt,
      endsAt,
      source: booking.warrantyCoverage?.source || "quote",
    };
    await booking.save();
  }

  return booking.warrantyCoverage;
};

export const uploadWarrantyEvidence = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    if (req.method === "DELETE") {
      const body = req.body as { claimId?: string; urls?: string[]; keys?: string[] } | undefined;
      const claimId = body?.claimId;
      if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
        return res.status(400).json({ success: false, msg: "Valid claimId is required" });
      }

      const claim = await WarrantyClaim.findById(claimId).select("customer professional evidence");
      if (!claim) {
        return res.status(404).json({ success: false, msg: "Warranty claim not found" });
      }

      const isParticipant =
        claim.customer?.toString() === userId ||
        claim.professional?.toString() === userId;
      if (!isParticipant) {
        return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
      }

      const rawKeys = [
        ...(Array.isArray(body?.keys) ? body.keys : []),
        ...(Array.isArray(body?.urls)
          ? body.urls
              .map((url) => parseS3KeyFromUrl(url))
              .filter((key): key is string => Boolean(key))
          : []),
      ];
      const keys = Array.from(new Set(rawKeys.filter(Boolean)));
      if (keys.length === 0) {
        return res.status(400).json({ success: false, msg: "At least one valid evidence key is required" });
      }

      const claimEvidenceKeys = new Set(
        (claim.evidence || [])
          .map((url) => parseS3KeyFromUrl(url))
          .filter((key): key is string => Boolean(key))
      );
      const unauthorizedKeys = keys.filter((key) => !claimEvidenceKeys.has(key));
      if (unauthorizedKeys.length > 0) {
        return res.status(403).json({ success: false, msg: "One or more evidence files are not authorized for deletion" });
      }

      const deleteResults = await Promise.allSettled(keys.map((key) => deleteFromS3(key)));
      const deletedKeys = keys.filter((_, index) => deleteResults[index]?.status === "fulfilled");
      const urlsToRemove = (claim.evidence || []).filter((url) => {
        const evidenceKey = parseS3KeyFromUrl(url);
        return Boolean(evidenceKey && deletedKeys.includes(evidenceKey));
      });
      if (urlsToRemove.length > 0) {
        await claim.updateOne({ $pull: { evidence: { $in: urlsToRemove } } });
      }
      return res.status(200).json({ success: true, msg: "Evidence files cleaned up" });
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, msg: "No evidence files uploaded" });
    }
    if (files.length > 10) {
      return res
        .status(400)
        .json({ success: false, msg: "You can upload up to 10 evidence files" });
    }

    const uploaded: Array<{
      url: string;
      key: string;
      fileName: string;
      mimeType: string;
      fileSize: number;
    }> = [];

    try {
      for (const file of files) {
        const validation = file.mimetype.startsWith("image/")
          ? await validateImageFileBuffer(file)
          : file.mimetype.startsWith("video/")
          ? validateVideoFile(file)
          : validateFile(file);
        if (!validation.valid) {
          await Promise.all(
            uploaded.map((f) =>
              deleteFromS3(f.key).catch(() => null)
            )
          );
          return res.status(400).json({ success: false, msg: validation.error || "Invalid file" });
        }

        const fileName = generateFileName(file.originalname, userId, "warranty-claims");
        const result = await uploadToS3(file, fileName);
        uploaded.push({
          url: result.url,
          key: result.key,
          fileName: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
        });
      }
    } catch (uploadError) {
      await Promise.all(
        uploaded.map((file) =>
          deleteFromS3(file.key).catch(() => {
            return null;
          })
        )
      );
      throw uploadError;
    }

    return res.status(200).json({
      success: true,
      data: { files: uploaded },
    });
  } catch (error: any) {
    console.error("[WARRANTY] upload evidence error:", error);
    return res.status(500).json({ success: false, msg: "Failed to upload evidence" });
  }
};

export const attachClaimEvidence = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const { claimId } = req.params;
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Valid claimId is required" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) {
      return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    }
    if (claim.customer.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, msg: "No evidence files uploaded" });
    }

    const maxEvidence = 10;
    const currentCount = claim.evidence?.length || 0;
    if (currentCount + files.length > maxEvidence) {
      return res.status(400).json({
        success: false,
        msg: `Cannot exceed ${maxEvidence} evidence files. Currently ${currentCount}, attempting to add ${files.length}.`,
      });
    }

    const uploaded: Array<{ url: string; key: string }> = [];
    try {
      for (const file of files) {
        const validation = file.mimetype.startsWith("image/")
          ? await validateImageFileBuffer(file)
          : file.mimetype.startsWith("video/")
          ? validateVideoFile(file)
          : validateFile(file);
        if (!validation.valid) {
          await Promise.all(uploaded.map((f) => deleteFromS3(f.key).catch(() => null)));
          return res.status(400).json({ success: false, msg: validation.error || "Invalid file" });
        }

        const fileName = generateFileName(file.originalname, userId, "warranty-claims");
        const result = await uploadToS3(file, fileName);
        uploaded.push({ url: result.url, key: result.key });
      }
    } catch (uploadError) {
      await Promise.all(uploaded.map((f) => deleteFromS3(f.key).catch(() => null)));
      throw uploadError;
    }

    const newUrls = uploaded.map((f) => f.url);
    claim.evidence = [...(claim.evidence || []), ...newUrls];
    await claim.save();

    return res.status(200).json({
      success: true,
      msg: "Evidence attached to claim",
      data: { urls: newUrls },
    });
  } catch (error: any) {
    console.error("[WARRANTY] attach claim evidence error:", error);
    return res.status(500).json({ success: false, msg: "Failed to attach evidence" });
  }
};

export const deleteDraftClaim = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const { claimId } = req.params;
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Valid claimId is required" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) {
      return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    }
    if (claim.customer.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }
    if (claim.status !== "open") {
      return res.status(400).json({
        success: false,
        msg: "Only open claims can be deleted",
      });
    }

    // Clean up any S3 evidence files
    if (claim.evidence && claim.evidence.length > 0) {
      await Promise.all(
        claim.evidence.map((url) => {
          const key = parseS3KeyFromUrl(url);
          return key ? deleteFromS3(key).catch(() => null) : null;
        })
      );
    }

    await WarrantyClaim.findByIdAndDelete(claimId);

    return res.status(200).json({ success: true, msg: "Draft claim deleted" });
  } catch (error: any) {
    console.error("[WARRANTY] delete draft claim error:", error);
    return res.status(500).json({ success: false, msg: "Failed to delete draft claim" });
  }
};

export const openWarrantyClaim = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    const userRole = getUserRole(req);
    if (!userId || userRole !== "customer") {
      return res.status(403).json({ success: false, msg: "Only customers can open warranty claims" });
    }

    const { bookingId, reason, description, evidence } = req.body as {
      bookingId?: string;
      reason?: string;
      description?: string;
      evidence?: string[];
    };

    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Valid bookingId is required" });
    }
    if (!reason) {
      return res.status(400).json({ success: false, msg: "Claim reason is required" });
    }
    if (!description || description.trim().length < 10) {
      return res
        .status(400)
        .json({ success: false, msg: "Please provide at least 10 characters describing the issue" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }
    if (booking.customer.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this booking" });
    }
    if (booking.status !== "completed") {
      return res.status(400).json({
        success: false,
        msg: "Warranty claims can only be opened for completed bookings",
      });
    }

    const warrantyCoverage = await ensureWarrantyCoverage(booking);
    if (!warrantyCoverage || !warrantyCoverage.duration || warrantyCoverage.duration.value <= 0) {
      return res.status(400).json({
        success: false,
        msg: "This booking does not include warranty coverage",
      });
    }
    if (!warrantyCoverage.endsAt || new Date() >= new Date(warrantyCoverage.endsAt)) {
      return res.status(400).json({
        success: false,
        msg: "Warranty period has expired for this booking",
      });
    }

    const existingActive = await WarrantyClaim.findOne({
      booking: booking._id,
      status: { $in: ACTIVE_CLAIM_STATUSES },
    });
    if (existingActive) {
      return res.status(409).json({
        success: false,
        msg: "An active warranty claim already exists for this booking",
        claim: existingActive,
      });
    }

    const professionalId = booking.professional;
    if (!professionalId) {
      return res.status(400).json({
        success: false,
        msg: "Booking has no assigned professional",
      });
    }

    const { validUrls: evidenceUrls, invalidUrls: invalidEvidenceUrls } = validateWarrantyUrlsForUser(
      Array.isArray(evidence) ? evidence.slice(0, 10) : [],
      userId
    );
    if (invalidEvidenceUrls.length > 0) {
      return res.status(400).json({ success: false, msg: "One or more evidence attachments are not owned by the current user" });
    }

    const openedAt = new Date();
    const claim = await WarrantyClaim.create({
      booking: booking._id,
      customer: booking.customer,
      professional: professionalId,
      reason,
      description: description.trim(),
      evidence: evidenceUrls,
      warrantyEndsAt: warrantyCoverage.endsAt,
      openedAt,
      sla: {
        professionalResponseDueAt: addWorkingDays(openedAt, PROFESSIONAL_RESPONSE_DAYS),
        customerAutoCloseDays: CUSTOMER_AUTO_CLOSE_DAYS,
      },
    });

    await ensureWarrantyChatContext({
      customerId: booking.customer as Types.ObjectId,
      professionalId: professionalId as Types.ObjectId,
      actorId: toObjectId(userId),
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} opened by customer.`,
    });

    try {
      const [customerUser, professionalUser] = await Promise.all([
        User.findById(booking.customer).select('email name').lean(),
        User.findById(professionalId).select('email name businessInfo username').lean(),
      ]);
      if (professionalUser?.email && WARRANTY_ADMIN_NOTIFICATIONS_EMAIL) {
        await sendWarrantyClaimOpenedEmail(
          professionalUser.email,
          WARRANTY_ADMIN_NOTIFICATIONS_EMAIL,
          getProfessionalDisplayName(professionalUser),
          customerUser?.name || 'Customer',
          String(booking._id),
          claim.claimNumber || String(claim._id)
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send warranty-claim-opened email:', emailError?.message || emailError);
    }

    return res.status(201).json({
      success: true,
      msg: "Warranty claim opened successfully",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] open claim error:", error);
    return res.status(500).json({ success: false, msg: "Failed to open warranty claim" });
  }
};

export const getWarrantyClaimByBooking = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }
    const { bookingId } = req.params;
    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid bookingId" });
    }

    const booking = await Booking.findById(bookingId).select("customer professional");
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const userIsParticipant =
      booking.customer.toString() === userId ||
      booking.professional?.toString() === userId ||
      isAdmin(req);
    if (!userIsParticipant) {
      return res.status(403).json({ success: false, msg: "Not authorized for this booking" });
    }

    const [activeClaimRaw, latestClaimRaw] = await Promise.all([
      WarrantyClaim.findOne({
        booking: booking._id,
        status: { $in: ACTIVE_CLAIM_STATUSES },
      }).sort({ createdAt: -1 }),
      WarrantyClaim.findOne({ booking: booking._id }).sort({ createdAt: -1 }),
    ]);

    const [activeClaim, latestClaim] = await Promise.all([
      presignClaim(activeClaimRaw),
      presignClaim(latestClaimRaw),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        activeClaim,
        latestClaim,
      },
    });
  } catch (error: any) {
    console.error("[WARRANTY] get by booking error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load warranty claim" });
  }
};

export const getWarrantyClaimById = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }
    const { claimId } = req.params;
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }

    const claim = await WarrantyClaim.findById(claimId)
      .populate("booking", "bookingNumber status")
      .populate("customer", "name email")
      .populate("professional", "name email businessInfo");
    if (!claim) {
      return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    }

    const userIsParticipant =
      claim.customer.toString() === userId ||
      claim.professional.toString() === userId ||
      isAdmin(req);
    if (!userIsParticipant) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }

    const presigned = await presignClaim(claim);
    return res.status(200).json({ success: true, claim: presigned });
  } catch (error: any) {
    console.error("[WARRANTY] get claim by id error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load warranty claim" });
  }
};

export const listMyWarrantyClaims = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    const role = getUserRole(req);
    if (!userId || !role) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const { status, page = "1", limit = "20" } = req.query;
    const pageNumber = Math.max(Number.parseInt(String(page), 10) || 1, 1);
    const limitNumber = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
    const skip = (pageNumber - 1) * limitNumber;

    const query: Record<string, any> = {};
    const parsedStatus = parseClaimStatus(status);
    if (parsedStatus) query.status = parsedStatus;

    if (role === "customer") query.customer = toObjectId(userId);
    if (role === "professional") query.professional = toObjectId(userId);

    const [claims, total] = await Promise.all([
      WarrantyClaim.find(query)
        .populate("booking", "bookingNumber status")
        .populate("customer", "name email")
        .populate("professional", "name email businessInfo")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber),
      WarrantyClaim.countDocuments(query),
    ]);

    const presignedClaims = await Promise.all(claims.map((c) => presignClaim(c)));

    return res.status(200).json({
      success: true,
      data: {
        claims: presignedClaims,
        pagination: {
          total,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(total / limitNumber),
        },
      },
    });
  } catch (error: any) {
    console.error("[WARRANTY] list my claims error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load warranty claims" });
  }
};

export const submitWarrantyProposal = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || getUserRole(req) !== "professional") {
      return res.status(403).json({ success: false, msg: "Only professionals can submit claim proposals" });
    }
    const { claimId } = req.params;
    const { message, proposedScheduleAt, resolveByDate } = req.body as {
      message?: string;
      proposedScheduleAt?: string;
      resolveByDate?: string;
    };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }
    if (!message || message.trim().length < 5) {
      return res.status(400).json({ success: false, msg: "Proposal message is required" });
    }
    const parsedResolveByDate = resolveByDate ? new Date(resolveByDate) : null;
    if (!parsedResolveByDate || Number.isNaN(parsedResolveByDate.getTime())) {
      return res.status(400).json({ success: false, msg: "Resolve date is required" });
    }
    const now = Date.now();
    if (parsedResolveByDate.getTime() <= now) {
      return res.status(400).json({ success: false, msg: "Resolve date must be in the future" });
    }
    const parsedProposedScheduleAt = proposedScheduleAt ? new Date(proposedScheduleAt) : null;
    if (parsedProposedScheduleAt && Number.isNaN(parsedProposedScheduleAt.getTime())) {
      return res.status(400).json({ success: false, msg: "Proposed schedule date is invalid" });
    }
    if (parsedProposedScheduleAt && parsedProposedScheduleAt.getTime() <= now) {
      return res.status(400).json({ success: false, msg: "Proposed schedule date must be in the future" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) {
      return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    }
    if (claim.professional.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }
    if (!["open", "proposal_sent"].includes(claim.status)) {
      return res.status(400).json({
        success: false,
        msg: `Cannot submit proposal while claim is ${claim.status}`,
      });
    }

    claim.proposal = {
      ...claim.proposal,
      message: message.trim(),
      resolveByDate: parsedResolveByDate,
      proposedScheduleAt: parsedProposedScheduleAt || undefined,
      proposedBy: toObjectId(userId),
      proposedAt: new Date(),
      customerDecision: undefined,
      decidedAt: undefined,
      decisionNote: undefined,
    };
    claim.status = "proposal_sent";
    claim.statusHistory.push({
      status: "proposal_sent",
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: "Professional submitted warranty resolve proposal",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      actorId: toObjectId(userId),
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber}: professional submitted a resolve proposal for ${new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(parsedResolveByDate)}.`,
    });

    try {
      const [customerUser, professionalUser] = await Promise.all([
        User.findById(claim.customer).select('email name').lean(),
        User.findById(claim.professional).select('name businessInfo username').lean(),
      ]);
      if (customerUser?.email) {
        await sendWarrantyProposalSentEmail(
          customerUser.email,
          customerUser.name || 'Customer',
          getProfessionalDisplayName(professionalUser),
          message.trim(),
          String(claim.booking),
          claim.claimNumber || String(claim._id)
        );
      }
    } catch (emailError: any) {
      console.error('Failed to send warranty-proposal-sent email:', emailError?.message || emailError);
    }

    return res.status(200).json({
      success: true,
      msg: "Resolve proposal submitted",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] submit proposal error:", error);
    return res.status(500).json({ success: false, msg: "Failed to submit proposal" });
  }
};

export const declineWarrantyClaim = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || getUserRole(req) !== "professional") {
      return res.status(403).json({ success: false, msg: "Only professionals can decline claims" });
    }
    const { claimId } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }
    if (!reason || reason.trim().length < 3) {
      return res.status(400).json({ success: false, msg: "Decline reason is required" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (claim.professional.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }
    if (!ACTIVE_CLAIM_STATUSES.includes(claim.status)) {
      return res.status(400).json({ success: false, msg: "Claim is already closed" });
    }

    claim.escalation = {
      escalatedAt: new Date(),
      escalatedBy: toObjectId(userId),
      autoEscalated: false,
      reason: "Professional declined warranty claim",
      note: reason.trim(),
    };
    claim.status = "escalated";
    claim.statusHistory.push({
      status: "escalated",
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: `Professional declined claim: ${reason.trim()}`,
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      actorId: toObjectId(userId),
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} was declined by professional and escalated to admin.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Claim declined and escalated to admin",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] decline claim error:", error);
    return res.status(500).json({ success: false, msg: "Failed to decline claim" });
  }
};

export const respondToWarrantyProposal = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || getUserRole(req) !== "customer") {
      return res.status(403).json({ success: false, msg: "Only customers can respond to proposals" });
    }
    const { claimId } = req.params;
    const { action, note } = req.body as { action?: "accept" | "decline"; note?: string };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }
    if (!action || !["accept", "decline"].includes(action)) {
      return res.status(400).json({ success: false, msg: "Action must be accept or decline" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (claim.customer.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }
    if (claim.status !== "proposal_sent") {
      return res.status(400).json({ success: false, msg: "No pending proposal to respond to" });
    }

    if (!claim.proposal) {
      claim.proposal = {
        message: "",
        proposedBy: claim.professional,
        proposedAt: new Date(),
      };
    }

    claim.proposal.customerDecision = action === "accept" ? "accepted" : "declined";
    claim.proposal.decidedAt = new Date();
    claim.proposal.decisionNote = note?.trim();

    if (action === "accept") {
      claim.status = "proposal_accepted";
      claim.statusHistory.push({
        status: "proposal_accepted",
        timestamp: new Date(),
        updatedBy: toObjectId(userId),
        note: "Customer accepted warranty proposal",
      });
    } else {
      claim.status = "escalated";
      claim.escalation = {
        escalatedAt: new Date(),
        escalatedBy: toObjectId(userId),
        autoEscalated: false,
        reason: "Customer declined warranty proposal",
        note: note?.trim(),
      };
      claim.statusHistory.push({
        status: "escalated",
        timestamp: new Date(),
        updatedBy: toObjectId(userId),
        note: "Customer declined proposal and escalated claim",
      });
    }

    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      actorId: toObjectId(userId),
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text:
        action === "accept"
          ? `Warranty claim ${claim.claimNumber}: customer accepted proposal.`
          : `Warranty claim ${claim.claimNumber}: customer declined proposal and escalated.`,
    });

    return res.status(200).json({
      success: true,
      msg: action === "accept" ? "Proposal accepted" : "Proposal declined and escalated",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] proposal response error:", error);
    return res.status(500).json({ success: false, msg: "Failed to respond to proposal" });
  }
};

export const markWarrantyResolved = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || getUserRole(req) !== "professional") {
      return res.status(403).json({ success: false, msg: "Only professionals can mark claims as resolved" });
    }
    const { claimId } = req.params;
    const { summary, attachments } = req.body as { summary?: string; attachments?: string[] };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }
    if (!summary || summary.trim().length < 5) {
      return res.status(400).json({ success: false, msg: "Resolution summary is required" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (claim.professional.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }
    if (!["proposal_accepted", "escalated"].includes(claim.status)) {
      return res.status(400).json({
        success: false,
        msg: `Cannot mark claim resolved while status is ${claim.status}`,
      });
    }

    const { validUrls: resolutionAttachments, invalidUrls: invalidResolutionAttachments } = validateWarrantyUrlsForClaim(
      Array.isArray(attachments) ? attachments.slice(0, 10) : [],
      claim,
      userId
    );
    if (invalidResolutionAttachments.length > 0) {
      return res.status(400).json({ success: false, msg: "One or more resolution attachments are not authorized for this claim" });
    }

    const resolvedAt = new Date();
    const autoCloseDays = claim.sla?.customerAutoCloseDays || CUSTOMER_AUTO_CLOSE_DAYS;
    claim.resolution = {
      summary: summary.trim(),
      attachments: resolutionAttachments,
      resolvedAt,
      resolvedBy: toObjectId(userId),
    };
    claim.sla = {
      ...(claim.sla || { customerAutoCloseDays: autoCloseDays }),
      customerAutoCloseDays: autoCloseDays,
      customerConfirmationDueAt: new Date(
        resolvedAt.getTime() + autoCloseDays * 24 * 60 * 60 * 1000
      ),
    };
    claim.status = "resolved";
    claim.statusHistory.push({
      status: "resolved",
      timestamp: resolvedAt,
      updatedBy: toObjectId(userId),
      note: "Professional marked warranty claim resolved",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      actorId: toObjectId(userId),
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} marked as resolved by professional.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Claim marked as resolved",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] mark resolved error:", error);
    return res.status(500).json({ success: false, msg: "Failed to mark claim resolved" });
  }
};

export const confirmWarrantyResolution = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || getUserRole(req) !== "customer") {
      return res.status(403).json({ success: false, msg: "Only customers can confirm resolution" });
    }
    const { claimId } = req.params;
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (claim.customer.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }
    if (claim.status !== "resolved") {
      return res.status(400).json({ success: false, msg: "Claim is not awaiting resolution confirmation" });
    }

    claim.resolution = {
      ...(claim.resolution || {
        summary: "Resolved",
        resolvedAt: new Date(),
        resolvedBy: claim.professional,
      }),
      customerConfirmedAt: new Date(),
      confirmedBy: toObjectId(userId),
    };
    claim.status = "closed";
    claim.statusHistory.push({
      status: "closed",
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: "Customer confirmed warranty resolution",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      actorId: toObjectId(userId),
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} was confirmed and closed by customer.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Warranty claim closed",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] confirm resolution error:", error);
    return res.status(500).json({ success: false, msg: "Failed to confirm resolution" });
  }
};

export const escalateWarrantyClaim = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }
    const { claimId } = req.params;
    const { reason, note } = req.body as { reason?: string; note?: string };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });

    const role = getUserRole(req);
    const customerCanEscalateResolved =
      role === "customer" &&
      claim.customer.toString() === userId &&
      claim.status === "resolved";
    const professionalCanEscalate =
      role === "professional" &&
      claim.professional.toString() === userId;
    if (!isAdmin(req) && !professionalCanEscalate && !customerCanEscalateResolved) {
      return res.status(403).json({ success: false, msg: "Not authorized for this claim" });
    }
    if (claim.status === "closed") {
      return res.status(400).json({ success: false, msg: "Claim is already closed" });
    }

    claim.status = "escalated";
    claim.escalation = {
      escalatedAt: new Date(),
      escalatedBy: toObjectId(userId),
      autoEscalated: false,
      reason: reason?.trim() || "Manual escalation requested",
      note: note?.trim(),
    };
    claim.statusHistory.push({
      status: "escalated",
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: reason?.trim() || "Claim manually escalated",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      actorId: toObjectId(userId),
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} escalated to admin.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Claim escalated to admin",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] escalate claim error:", error);
    return res.status(500).json({ success: false, msg: "Failed to escalate claim" });
  }
};

export const adminCloseWarrantyClaim = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || !isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }
    const { claimId } = req.params;
    const { note } = req.body as { note?: string };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (claim.status === "closed") {
      return res.status(400).json({ success: false, msg: "Claim is already closed" });
    }

    claim.status = "closed";
    claim.resolution = {
      ...(claim.resolution || {
        summary: "Closed by admin",
        resolvedAt: new Date(),
        resolvedBy: toObjectId(userId),
      }),
      customerConfirmedAt: new Date(),
      confirmedBy: toObjectId(userId),
    };
    claim.statusHistory.push({
      status: "closed",
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: note?.trim() || "Closed by admin",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} was closed by admin.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Warranty claim closed by admin",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin close error:", error);
    return res.status(500).json({ success: false, msg: "Failed to close claim" });
  }
};

export const adminApproveWarrantyClaim = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || !isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }
    const { claimId } = req.params;
    const { note } = req.body as { note?: string };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    const allowedPreApprovalStatuses = ["open", "proposal_sent", "escalated"];
    if (!allowedPreApprovalStatuses.includes(claim.status)) {
      return res.status(400).json({ success: false, msg: `Claim cannot be approved from status "${claim.status}"` });
    }

    claim.status = "proposal_accepted";
    claim.statusHistory.push({
      status: "proposal_accepted",
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: note?.trim() || "Admin approved warranty claim",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} was approved by admin and moved to resolution.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Warranty claim approved by admin",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin approve error:", error);
    return res.status(500).json({ success: false, msg: "Failed to approve claim" });
  }
};

export const adminDeclineWarrantyClaim = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || !isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }
    const { claimId } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }
    if (!reason || reason.trim().length < 3) {
      return res.status(400).json({ success: false, msg: "Decline reason is required" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (claim.status === "closed") {
      return res.status(400).json({ success: false, msg: "Claim is already closed" });
    }

    claim.status = "closed";
    claim.resolution = {
      ...(claim.resolution || {
        resolvedAt: new Date(),
        resolvedBy: toObjectId(userId),
      }),
      summary: `Declined by admin: ${reason.trim()}`,
      resolvedAt: claim.resolution?.resolvedAt || new Date(),
      resolvedBy: claim.resolution?.resolvedBy || toObjectId(userId),
    };
    claim.statusHistory.push({
      status: "closed",
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: `Admin declined claim: ${reason.trim()}`,
    });
    await claim.save();

    const truncatedReason = reason.trim().length > 300 ? `${reason.trim().slice(0, 297)}...` : reason.trim();
    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} was declined and closed by admin: ${truncatedReason}`,
    });

    return res.status(200).json({
      success: true,
      msg: "Warranty claim declined and closed by admin",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin decline error:", error);
    return res.status(500).json({ success: false, msg: "Failed to decline claim" });
  }
};

export const adminApproveWarrantyResolve = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || !isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }
    const { claimId } = req.params;
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (!isApprovableStatus(claim.status)) {
      return res.status(400).json({ success: false, msg: `Claim cannot be resolved from status "${claim.status}"` });
    }

    const proposalSummary = claim.proposal?.message?.trim();
    if (!proposalSummary) {
      return res.status(400).json({ success: false, msg: "There is no proposed resolution to approve. Use adjust to set one." });
    }

    const resolvedAt = new Date();
    const approveAutoCloseDays = claim.sla?.customerAutoCloseDays || CUSTOMER_AUTO_CLOSE_DAYS;
    claim.resolution = {
      ...(claim.resolution || {}),
      summary: proposalSummary,
      resolvedAt,
      resolvedBy: toObjectId(userId),
    };
    claim.sla = {
      ...(claim.sla || { customerAutoCloseDays: approveAutoCloseDays }),
      customerAutoCloseDays: approveAutoCloseDays,
      customerConfirmationDueAt: new Date(resolvedAt.getTime() + approveAutoCloseDays * 24 * 60 * 60 * 1000),
    };
    claim.status = "resolved";
    claim.statusHistory.push({
      status: "resolved",
      timestamp: resolvedAt,
      updatedBy: toObjectId(userId),
      note: "Admin approved proposed resolution",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber}: admin approved the proposed resolution.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Proposed resolution approved by admin",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin approve resolve error:", error);
    return res.status(500).json({ success: false, msg: "Failed to approve resolution" });
  }
};

export const adminAdjustWarrantyResolve = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || !isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }
    const { claimId } = req.params;
    const { resolveDescription, resolveByDate } = req.body as {
      resolveDescription?: string;
      resolveByDate?: string;
    };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }

    let parsedResolveByDate: Date | undefined;
    if (resolveByDate !== undefined && resolveByDate !== null && resolveByDate !== "") {
      const candidate = new Date(resolveByDate);
      if (Number.isNaN(candidate.getTime())) {
        return res.status(400).json({ success: false, msg: "resolveByDate is invalid" });
      }
      parsedResolveByDate = candidate;
    }

    const trimmedDescription =
      typeof resolveDescription === "string" ? resolveDescription.trim() : undefined;
    if (trimmedDescription !== undefined && trimmedDescription.length > 3000) {
      return res.status(400).json({ success: false, msg: "resolveDescription is too long" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });
    if (!isApprovableStatus(claim.status)) {
      return res.status(400).json({ success: false, msg: `Claim cannot be resolved from status "${claim.status}"` });
    }

    if (trimmedDescription !== undefined || parsedResolveByDate !== undefined) {
      claim.proposal = {
        ...(claim.proposal || {
          message: "",
          proposedBy: toObjectId(userId),
          proposedAt: new Date(),
        }),
        ...(trimmedDescription !== undefined ? { message: trimmedDescription } : {}),
        ...(parsedResolveByDate !== undefined ? { resolveByDate: parsedResolveByDate } : {}),
      };
    }

    const adjustSummary = trimmedDescription || claim.resolution?.summary || claim.proposal?.message?.trim();
    if (!adjustSummary) {
      return res.status(400).json({ success: false, msg: "A resolution description is required to resolve this claim" });
    }

    const resolvedAt = new Date();
    const adjustAutoCloseDays = claim.sla?.customerAutoCloseDays || CUSTOMER_AUTO_CLOSE_DAYS;
    claim.resolution = {
      ...(claim.resolution || {}),
      summary: adjustSummary,
      resolvedAt,
      resolvedBy: toObjectId(userId),
    };
    claim.sla = {
      ...(claim.sla || { customerAutoCloseDays: adjustAutoCloseDays }),
      customerAutoCloseDays: adjustAutoCloseDays,
      customerConfirmationDueAt: new Date(resolvedAt.getTime() + adjustAutoCloseDays * 24 * 60 * 60 * 1000),
    };
    claim.status = "resolved";
    claim.statusHistory.push({
      status: "resolved",
      timestamp: resolvedAt,
      updatedBy: toObjectId(userId),
      note: "Admin adjusted and approved resolution",
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber}: admin adjusted the resolution and marked it resolved.`,
    });

    return res.status(200).json({
      success: true,
      msg: "Resolution adjusted and resolved by admin",
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin adjust resolve error:", error);
    return res.status(500).json({ success: false, msg: "Failed to adjust resolution" });
  }
};

export const adminSetWarrantyStatus = async (req: Request, res: Response) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId || !isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }
    const { claimId } = req.params;
    const { status, note } = req.body as { status?: string; note?: string };
    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ success: false, msg: "Invalid claimId" });
    }
    const parsedStatus = parseClaimStatus(status);
    if (!parsedStatus) {
      return res.status(400).json({ success: false, msg: "Invalid status value" });
    }
    if (parsedStatus === "closed") {
      return res.status(400).json({ success: false, msg: "Use the decline action to close a claim so closure details are recorded" });
    }

    const claim = await WarrantyClaim.findById(claimId);
    if (!claim) return res.status(404).json({ success: false, msg: "Warranty claim not found" });

    if (parsedStatus === "resolved" && !claim.resolution?.resolvedAt) {
      const resolvedAt = new Date();
      claim.resolution = {
        ...(claim.resolution || {}),
        summary: claim.resolution?.summary || "Resolved by admin",
        resolvedAt,
        resolvedBy: toObjectId(userId),
      };
      if (!claim.sla?.customerConfirmationDueAt) {
        const setStatusAutoCloseDays = claim.sla?.customerAutoCloseDays || CUSTOMER_AUTO_CLOSE_DAYS;
        claim.sla = {
          ...(claim.sla || { customerAutoCloseDays: setStatusAutoCloseDays }),
          customerAutoCloseDays: setStatusAutoCloseDays,
          customerConfirmationDueAt: new Date(resolvedAt.getTime() + setStatusAutoCloseDays * 24 * 60 * 60 * 1000),
        };
      }
    }

    claim.status = parsedStatus;
    claim.statusHistory.push({
      status: parsedStatus,
      timestamp: new Date(),
      updatedBy: toObjectId(userId),
      note: note?.trim() || `Admin set status to ${parsedStatus}`,
    });
    await claim.save();

    await ensureWarrantyChatContext({
      customerId: claim.customer,
      professionalId: claim.professional,
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      bookingId: claim.booking,
      status: claim.status,
      text: `Warranty claim ${claim.claimNumber} status was set to ${parsedStatus} by admin.`,
    });

    return res.status(200).json({
      success: true,
      msg: `Warranty claim status set to ${parsedStatus}`,
      claim,
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin set status error:", error);
    return res.status(500).json({ success: false, msg: "Failed to set claim status" });
  }
};

export const listAdminWarrantyClaims = async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }
    const { status, page = "1", limit = "25", search } = req.query;
    const pageNumber = Math.max(Number.parseInt(String(page), 10) || 1, 1);
    const limitNumber = Math.min(Math.max(Number.parseInt(String(limit), 10) || 25, 1), 100);
    const skip = (pageNumber - 1) * limitNumber;

    const query: Record<string, any> = {};
    const parsedStatus = parseClaimStatus(status);
    if (parsedStatus) {
      query.status = parsedStatus;
    }
    if (typeof search === "string" && search.trim().length > 0) {
      query.claimNumber = {
        $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }

    const [claims, total] = await Promise.all([
      WarrantyClaim.find(query)
        .populate("booking", "bookingNumber status")
        .populate("customer", "name email")
        .populate("professional", "name email businessInfo")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber),
      WarrantyClaim.countDocuments(query),
    ]);

    const presignedClaims = await Promise.all(claims.map((c) => presignClaim(c)));

    return res.status(200).json({
      success: true,
      data: {
        claims: presignedClaims,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total,
          totalPages: Math.ceil(total / limitNumber),
        },
      },
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin list claims error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load claims" });
  }
};

export const getAdminWarrantyAnalytics = async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }

    const lastDays = Math.max(Number.parseInt(String(req.query.lastDays || "30"), 10) || 30, 1);
    const threshold = Number.parseFloat(String(req.query.rateThreshold || "0.2"));
    const minCompletedBookings = Math.max(
      Number.parseInt(String(req.query.minCompletedBookings || "5"), 10) || 5,
      1
    );

    const since = new Date();
    since.setDate(since.getDate() - lastDays);

    const claims = await WarrantyClaim.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$professional",
          claimsCount: { $sum: 1 },
          escalatedCount: {
            $sum: { $cond: [{ $eq: ["$status", "escalated"] }, 1, 0] },
          },
          closedCount: {
            $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] },
          },
        },
      },
    ]);

    const totalClaims = claims.reduce((acc, item) => acc + (item.claimsCount || 0), 0);
    const totalEscalated = claims.reduce((acc, item) => acc + (item.escalatedCount || 0), 0);
    const totalClosed = claims.reduce((acc, item) => acc + (item.closedCount || 0), 0);

    const resolutionAggregate = await WarrantyClaim.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          status: "closed",
          "resolution.resolvedAt": { $exists: true, $ne: null },
        },
      },
      {
        $project: {
          resolutionMs: {
            $subtract: ["$resolution.resolvedAt", "$createdAt"],
          },
        },
      },
      {
        $match: {
          resolutionMs: { $gte: 0 },
        },
      },
      {
        $project: {
          resolutionHours: {
            $divide: ["$resolutionMs", 1000 * 60 * 60],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgResolutionHours: { $avg: "$resolutionHours" },
        },
      },
    ]);

    const completedBookingsByPro = await Booking.aggregate([
      {
        $match: {
          status: "completed",
          updatedAt: { $gte: since },
          professional: { $exists: true, $ne: null },
        },
      },
      {
        $group: {
          _id: "$professional",
          completedBookings: { $sum: 1 },
        },
      },
    ]);

    const completedMap = new Map<string, number>();
    completedBookingsByPro.forEach((item) => {
      completedMap.set(String(item._id), item.completedBookings || 0);
    });

    const professionalsNeedingData = claims.map((item) => item._id).filter(Boolean);
    const professionals = await User.find({
      _id: { $in: professionalsNeedingData },
    }).select("name email businessInfo");
    const proMap = new Map(
      professionals.map((pro: any) => [String(pro._id), pro])
    );

    const flaggedProfessionals = claims
      .map((item) => {
        const professionalId = String(item._id);
        const completedBookings = completedMap.get(professionalId) || 0;
        const claimRate = completedBookings > 0 ? item.claimsCount / completedBookings : 0;
        return {
          professionalId,
          professional: proMap.get(professionalId) || null,
          claimsCount: item.claimsCount || 0,
          escalatedCount: item.escalatedCount || 0,
          completedBookings,
          claimRate,
        };
      })
      .filter(
        (item) =>
          item.completedBookings >= minCompletedBookings &&
          item.claimRate >= threshold
      )
      .sort((a, b) => b.claimRate - a.claimRate);

    return res.status(200).json({
      success: true,
      data: {
        window: {
          lastDays,
          since,
        },
        summary: {
          totalClaims,
          totalEscalated,
          totalClosed,
          avgResolutionHours: resolutionAggregate[0]?.avgResolutionHours || 0,
        },
        flaggedProfessionals,
        thresholds: {
          rateThreshold: threshold,
          minCompletedBookings,
        },
      },
    });
  } catch (error: any) {
    console.error("[WARRANTY] admin analytics error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load warranty analytics" });
  }
};

export const autoEscalateWarrantyClaim = async (
  claim: IWarrantyClaim,
  note = "Auto-escalated: no professional response within 5 business days"
) => {
  // Atomically claim the transition so concurrent runs cannot duplicate it
  const updated = await WarrantyClaim.findOneAndUpdate(
    { _id: claim._id, status: "open" },
    {
      $set: {
        status: "escalated",
        escalation: {
          escalatedAt: new Date(),
          escalatedBy: SYSTEM_USER_ID,
          autoEscalated: true,
          reason: "Professional response SLA missed",
          note,
        },
      },
      $push: {
        statusHistory: {
          status: "escalated",
          timestamp: new Date(),
          updatedBy: SYSTEM_USER_ID,
          note,
        },
      },
    },
    { new: true }
  );
  if (!updated) return;

  await ensureWarrantyChatContext({
    customerId: updated.customer,
    professionalId: updated.professional,
    claimId: updated._id,
    claimNumber: updated.claimNumber,
    bookingId: updated.booking,
    status: updated.status,
    text: `Warranty claim ${updated.claimNumber} was auto-escalated to admin due to missed response SLA.`,
  });
};

export const autoCloseResolvedWarrantyClaim = async (
  claim: IWarrantyClaim,
  note = "Auto-closed: customer did not confirm resolution in time"
) => {
  // Build the resolution object, preserving any existing fields
  const resolution = {
    ...(claim.resolution || {
      summary: "Resolved",
      resolvedAt: new Date(),
      resolvedBy: claim.professional,
    }),
    autoClosedAt: new Date(),
  };

  // Atomically claim the transition so concurrent runs cannot duplicate it
  const updated = await WarrantyClaim.findOneAndUpdate(
    { _id: claim._id, status: "resolved" },
    {
      $set: {
        status: "closed",
        resolution,
      },
      $push: {
        statusHistory: {
          status: "closed",
          timestamp: new Date(),
          updatedBy: SYSTEM_USER_ID,
          note,
        },
      },
    },
    { new: true }
  );
  if (!updated) return;

  await ensureWarrantyChatContext({
    customerId: updated.customer,
    professionalId: updated.professional,
    claimId: updated._id,
    claimNumber: updated.claimNumber,
    bookingId: updated.booking,
    status: updated.status,
    text: `Warranty claim ${updated.claimNumber} was auto-closed after customer confirmation deadline.`,
  });
};
