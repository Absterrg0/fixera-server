//fixtract-server/src/handlers/Project/index.ts
import { Request, Response } from "express";
import mongoose from "mongoose";
import Project from "../../models/project";
import Booking from "../../models/booking";
import ServiceCategory from "../../models/serviceCategory";
import ServiceConfiguration from "../../models/serviceConfiguration";
import User from "../../models/user";
import ChatMessage from "../../models/chatMessage";
import {
  buildProjectScheduleProposals,
  buildProjectScheduleWindow,
  DAY_KEYS,
  fromZonedTime,
  getProjectAvailableSlotsForDate,
  getResourcePolicy,
  getUnbookableStartDates,
  getWorkingRangeUtc,
  normalizeRangeEndInclusive,
  PARTIAL_BLOCK_THRESHOLD_HOURS,
  startOfDayZoned,
  toZonedTime,
  type ResourcePolicy
} from "../../utils/scheduleEngine";
import { resolveAvailability } from "../../utils/availabilityHelpers";
import { normalizePreparationDuration } from "../../utils/projectDurations";
import { computeProjectDiff, determineReapprovalType } from "../../utils/projectDiff";
import { toSlug } from "../../utils/slug";
// import { seedServiceCategories } from '../../scripts/seedProject';

let cachedWindowFieldsSupport: boolean | null = null;
const mongoHasWindowFields = async (): Promise<boolean> => {
  if (cachedWindowFieldsSupport !== null) return cachedWindowFieldsSupport;
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) return (cachedWindowFieldsSupport = false);
    const info = await admin.serverInfo();
    const major = parseInt(String(info?.version || "0").split(".")[0], 10);
    cachedWindowFieldsSupport = Number.isFinite(major) && major >= 5;
  } catch {
    cachedWindowFieldsSupport = false;
  }
  return cachedWindowFieldsSupport;
};

const toIsoDate = (value?: Date | string | null) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const toBlockedRange = (range?: {
  startDate?: Date | string;
  endDate?: Date | string;
  reason?: string;
}) => {
  if (!range?.startDate || !range?.endDate) return null;
  const startDate = toIsoDate(range.startDate);
  const endDate = toIsoDate(range.endDate);
  if (!startDate || !endDate) return null;
  return {
    startDate,
    endDate,
    reason: range.reason,
  };
};

type ProfessionalStats = {
  avgRating: number;
  totalReviews: number;
  avgCommunication: number;
  avgValueOfDelivery: number;
  avgQualityOfService: number;
  avgResponseTimeMs: number;
};

const PROFESSIONAL_STATS_TTL_MS = 5 * 60 * 1000;
const PROFESSIONAL_STATS_CACHE_MAX_SIZE = 1000;
const professionalStatsCache = new Map<string, { stats: ProfessionalStats; expiresAt: number }>();

const evictExpiredProfessionalStats = () => {
  const now = Date.now();
  for (const [key, value] of professionalStatsCache) {
    if (value.expiresAt <= now) {
      professionalStatsCache.delete(key);
    }
  }
};

const enforceProfessionalStatsCapacity = () => {
  while (professionalStatsCache.size > PROFESSIONAL_STATS_CACHE_MAX_SIZE) {
    const oldestKey = professionalStatsCache.keys().next().value;
    if (oldestKey === undefined) break;
    professionalStatsCache.delete(oldestKey);
  }
};

const computeProfessionalStats = async (professionalId: string): Promise<ProfessionalStats> => {
  const cached = professionalStatsCache.get(professionalId);
  if (cached && cached.expiresAt > Date.now()) {
    professionalStatsCache.delete(professionalId);
    professionalStatsCache.set(professionalId, cached);
    return cached.stats;
  }
  if (professionalStatsCache.size > PROFESSIONAL_STATS_CACHE_MAX_SIZE) {
    evictExpiredProfessionalStats();
    enforceProfessionalStatsCapacity();
  }

  try {
    const profObjectId = new mongoose.Types.ObjectId(professionalId);
    const [reviewAgg] = await Booking.aggregate([
      {
        $match: {
          professional: profObjectId,
          status: "completed",
          "customerReview.communicationLevel": { $exists: true, $ne: null },
          "customerReview.valueOfDelivery": { $exists: true, $ne: null },
          "customerReview.qualityOfService": { $exists: true, $ne: null },
          "customerReview.isHidden": { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          avgCommunication: { $avg: "$customerReview.communicationLevel" },
          avgValueOfDelivery: { $avg: "$customerReview.valueOfDelivery" },
          avgQualityOfService: { $avg: "$customerReview.qualityOfService" },
          totalReviews: { $sum: 1 },
        },
      },
    ]);

    const avgCom = reviewAgg?.avgCommunication || 0;
    const avgVal = reviewAgg?.avgValueOfDelivery || 0;
    const avgQual = reviewAgg?.avgQualityOfService || 0;
    const totalReviews = reviewAgg?.totalReviews || 0;
    const hasRatings = avgCom > 0 || avgVal > 0 || avgQual > 0;
    const avgRating = hasRatings ? (avgCom + avgVal + avgQual) / 3 : 0;

    let avgResponseTimeMs = 0;
    try {
      const proConvoIds = await ChatMessage.distinct("conversationId", { senderId: profObjectId });
      if (proConvoIds.length > 0) {
        const supportsWindowFields = await mongoHasWindowFields();
        if (supportsWindowFields) {
          const [responseAgg] = await ChatMessage.aggregate([
            { $match: { conversationId: { $in: proConvoIds } } },
            { $sort: { conversationId: 1, _id: 1 } },
            {
              $setWindowFields: {
                partitionBy: "$conversationId",
                sortBy: { _id: 1 },
                output: {
                  prevSenderRole: { $shift: { output: "$senderRole", by: -1 } },
                  prevCreatedAt: { $shift: { output: "$createdAt", by: -1 } },
                },
              },
            },
            { $match: { senderRole: "professional", prevSenderRole: "customer" } },
            { $project: { diff: { $subtract: ["$createdAt", "$prevCreatedAt"] } } },
            { $match: { diff: { $gt: 0 } } },
            { $group: { _id: null, totalMs: { $sum: "$diff" }, count: { $sum: 1 } } },
          ]);
          if (responseAgg?.count > 0) {
            avgResponseTimeMs = responseAgg.totalMs / responseAgg.count;
          }
        } else {
          const CONVO_BATCH_SIZE = 50;
          const PER_CONVO_LIMIT = 100;
          let totalMs = 0;
          let count = 0;
          for (let i = 0; i < proConvoIds.length; i += CONVO_BATCH_SIZE) {
            const batch = proConvoIds.slice(i, i + CONVO_BATCH_SIZE);
            const perConvo = await Promise.all(
              batch.map((conversationId) =>
                ChatMessage.find({ conversationId })
                  .sort({ conversationId: 1, _id: -1 })
                  .limit(PER_CONVO_LIMIT)
                  .select("conversationId senderRole createdAt")
                  .lean()
              )
            );
            for (const desc of perConvo) {
              const messages = desc.reverse();
              let prev: any = null;
              for (const m of messages) {
                if (prev && prev.senderRole === "customer" && m.senderRole === "professional") {
                  const diff = new Date(m.createdAt as any).getTime() - new Date(prev.createdAt as any).getTime();
                  if (diff > 0) { totalMs += diff; count += 1; }
                }
                prev = m;
              }
            }
          }
          if (count > 0) avgResponseTimeMs = totalMs / count;
        }
      }
    } catch (err) {
      console.warn("[Project] Failed computing avgResponseTime for professional", professionalId, err);
    }

    const stats: ProfessionalStats = {
      avgRating: Math.round(avgRating * 10) / 10,
      totalReviews,
      avgCommunication: Math.round(avgCom * 10) / 10,
      avgValueOfDelivery: Math.round(avgVal * 10) / 10,
      avgQualityOfService: Math.round(avgQual * 10) / 10,
      avgResponseTimeMs: Math.round(avgResponseTimeMs),
    };
    professionalStatsCache.delete(professionalId);
    professionalStatsCache.set(professionalId, {
      stats,
      expiresAt: Date.now() + PROFESSIONAL_STATS_TTL_MS,
    });
    enforceProfessionalStatsCapacity();
    return stats;
  } catch (err) {
    console.warn("[Project] Failed computing professional stats for", professionalId, err);
    return {
      avgRating: 0,
      totalReviews: 0,
      avgCommunication: 0,
      avgValueOfDelivery: 0,
      avgQualityOfService: 0,
      avgResponseTimeMs: 0,
    };
  }
};

const serializePublicProject = (project: any) => {
  const projectObject =
    typeof project?.toObject === "function" ? project.toObject() : project;

  if (
    !projectObject ||
    !projectObject.professionalId ||
    typeof projectObject.professionalId !== "object"
  ) {
    return projectObject;
  }

  const { email: _email, phone: _phone, ...publicProfessional } =
    projectObject.professionalId;

  return {
    ...projectObject,
    professionalId: publicProfessional,
  };
};

const getDateRange = (start?: string, end?: string, fallbackDays = 180) => {
  const rangeStart = start ? new Date(start) : new Date();
  const rangeEnd = end ? new Date(end) : new Date(rangeStart);

  if (Number.isNaN(rangeStart.getTime())) {
    rangeStart.setTime(Date.now());
  }
  if (Number.isNaN(rangeEnd.getTime())) {
    rangeEnd.setTime(rangeStart.getTime());
  }

  rangeStart.setHours(0, 0, 0, 0);
  if (!end) {
    rangeEnd.setDate(rangeStart.getDate() + fallbackDays);
  }
  rangeEnd.setHours(0, 0, 0, 0);

  if (rangeEnd <= rangeStart) {
    rangeEnd.setDate(rangeStart.getDate() + fallbackDays);
  }

  return { rangeStart, rangeEnd };
};

const toLocalMidnightUtc = (date: Date, timeZone: string) => {
  const zoned = toZonedTime(date, timeZone);
  const localMidnightZoned = new Date(
    Date.UTC(
      zoned.getUTCFullYear(),
      zoned.getUTCMonth(),
      zoned.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
  return fromZonedTime(localMidnightZoned, timeZone);
};

const buildNonWorkingDates = (
  rangeStart: Date,
  rangeEnd: Date,
  timeZone: string,
  availability: Record<string, any>
) => {
  const nonWorking: string[] = [];
  const cursor = new Date(rangeStart);
  while (cursor <= rangeEnd) {
    const zoned = toZonedTime(cursor, timeZone);
    const dayAvailability = availability[DAY_KEYS[zoned.getUTCDay()]];
    if (!dayAvailability || dayAvailability.available === false) {
      nonWorking.push(toLocalMidnightUtc(cursor, timeZone).toISOString());
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nonWorking;
};

/**
 * Parse and validate subprojectIndex query parameter.
 * Returns a validated index or an error indicator for consistent 400 responses.
 */
type SubprojectIndexResult =
  | { valid: true; index: number | undefined }
  | { valid: false; error: string };

const parseSubprojectIndex = (
  subprojectIndexRaw: string | undefined,
  subprojectsLength: number
): SubprojectIndexResult => {
  if (subprojectIndexRaw === undefined) {
    return { valid: true, index: undefined };
  }

  const parsed = Number(subprojectIndexRaw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return {
      valid: false,
      error: "Invalid subprojectIndex: expected a whole number.",
    };
  }

  if (parsed < 0 || parsed >= subprojectsLength) {
    return {
      valid: false,
      error: "Invalid subprojectIndex: out of range for this project.",
    };
  }

  return { valid: true, index: parsed };
};

export const seedData = async (req: Request, res: Response) => {
  try {
    // await seedServiceCategories();
    res.json({
      message: "Service categories seeded successfully (function disabled)",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to seed service categories" });
  }
};

export const getCategories = async (req: Request, res: Response) => {
  try {
    const country = (req.query.country as string) || "BE";
    const categories = await ServiceCategory.find({
      isActive: true,
      countries: country,
    }).select("name slug description icon services");

    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
};

export const getCategoryServices = async (req: Request, res: Response) => {
  try {
    const { categorySlug } = req.params as any;
    const country = (req.query.country as string) || "BE";

    let category = await ServiceCategory.findOne({
      slug: categorySlug,
      isActive: true,
      countries: country,
    });

    if (!category) {
      const normalized = toSlug(categorySlug);
      if (normalized && normalized !== categorySlug) {
        category = await ServiceCategory.findOne({
          slug: normalized,
          isActive: true,
          countries: country,
        });
      }
    }

    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const services = category.services.filter(
      (service) => service.isActive && service.countries.includes(country)
    );

    res.json(services);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch services" });
  }
};

export const createOrUpdateDraft = async (req: Request, res: Response) => {
  try {
    console.log("[PROJECT] SAVE PROJECT REQUEST RECEIVED");
    console.log("User ID:", req.user?.id);
    console.log("Request body keys:", Object.keys(req.body));
    console.log("Project ID from request:", req.body.id);

    const professionalId = req.user?.id;
    const projectData = normalizePreparationDuration(req.body);

    if (!professionalId) {
      console.log("[PROJECT] No professional ID found");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const professional = await User.findById(professionalId).select('role professionalStatus stripe');
    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({ error: "Only approved professionals can manage projects" });
    }

    if (professional.professionalStatus !== 'approved') {
      return res.status(403).json({
        error: "Professional approval is required before creating projects",
        code: "PROFESSIONAL_APPROVAL_REQUIRED"
      });
    }

    if (!projectData.id) {
      if (!professional.stripe?.accountId || !professional.stripe?.onboardingCompleted) {
        return res.status(403).json({
          error: "Complete Stripe setup before creating projects",
          code: "STRIPE_ONBOARDING_REQUIRED"
        });
      }
    }

    let project;

    if (projectData.id) {
      console.log(`[PROJECT] Updating existing project: ${projectData.id}`);
      console.log("Professional ID:", professionalId);

      // First check if project exists
      const existingProject = await Project.findOne({
        _id: projectData.id,
        professionalId,
      });
      console.log("Existing project found:", !!existingProject);
      console.log("Existing project status:", existingProject?.status);
      console.log("Existing project title:", existingProject?.title);

      if (!existingProject) {
        console.log("[PROJECT] Project not found or not owned by user");
        return res.status(404).json({ error: "Project not found" });
      }

      // Log what fields are being updated
      console.log("[PROJECT] Fields being updated:");
      console.log("- Title:", projectData.title);
      console.log(
        "- Description length:",
        projectData.description?.length || 0
      );
      console.log("- Category:", projectData.category);
      console.log("- Service:", projectData.service);

      // Allow updates to existing projects regardless of status for editing
      const updateData: any = {
        ...projectData,
        autoSaveTimestamp: new Date(),
        updatedAt: new Date(),
      };

      // Never let frontend data overwrite change-tracking fields
      delete updateData.previousSnapshot;
      delete updateData.pendingChanges;
      delete updateData.reapprovalType;
      delete updateData.isResubmission;

      // If editing a published/on_hold project, take a snapshot for smart reapproval
      // but do NOT change status to pending — defer to submit time
      const isPublishedEdit = ["published", "on_hold"].includes(
        (existingProject.status as any) || ""
      );
      if (isPublishedEdit) {
        // Only take snapshot on the first edit (don't overwrite if already tracking)
        if (!existingProject.previousSnapshot) {
          updateData.previousSnapshot = existingProject.toObject();
        }
        updateData.isResubmission = true;
        // Keep current status — don't let frontend overwrite it during auto-save
        delete updateData.status;
      }

      console.log("[PROJECT] Update query:", { _id: projectData.id, professionalId });
      console.log("[PROJECT] Update data keys:", Object.keys(updateData));

      project = await Project.findOneAndUpdate(
        { _id: projectData.id, professionalId },
        updateData,
        { new: true, runValidators: true }
      );

      console.log("[PROJECT] Project updated successfully");
      console.log("Updated project ID:", project?._id);
      console.log("Updated project title:", project?.title);
      console.log("Updated project status:", project?.status);
    } else {
      console.log("[PROJECT] Creating new project");
      project = new Project({
        ...projectData,
        professionalId,
        status: "draft",
        autoSaveTimestamp: new Date(),
      });
      await project.save();
      console.log("[PROJECT] New project created with ID:", project._id);
    }

    console.log("[PROJECT] Sending response - project save complete");
    console.log("Response project ID:", project?._id);
    console.log("Response status code: 200");

    res.json(project);
  } catch (error: any) {
    console.error("[PROJECT] Auto-save error:", error);
    console.error("Error stack:", error.stack);
    res
      .status(500)
      .json({ error: "Failed to save project draft", details: error.message });
  }
};

export const getDrafts = async (req: Request, res: Response) => {
  try {
    const professionalId = req.user?.id;
    const drafts = await Project.find({
      professionalId,
      status: "draft",
    }).sort({ autoSaveTimestamp: -1 });

    res.json(drafts);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch drafts" });
  }
};

export const getAllProjects = async (req: Request, res: Response) => {
  try {
    const professionalId = req.user?.id;
    const projects = await Project.find({
      professionalId,
    }).sort({ updatedAt: -1 });

    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch projects" });
  }
};

export const getProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const professionalId = req.user?.id;

    const project = await Project.findOne({
      _id: id,
      professionalId,
    });

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(project);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch project" });
  }
};

// Public endpoint - Get published project by ID (for customers to view/book)
export const getPublishedProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const project = await Project.findOne({
      _id: id,
      status: "published",
    }).populate(
      'professionalId',
      'name username businessInfo.companyName businessInfo.timezone businessInfo.city businessInfo.country email phone profileImage professionalLevel adminTags createdAt companyAvailability companyBlockedRanges'
    );

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found or not published"
      });
    }

    const professionalId = (project.professionalId as any)?._id || project.professionalId;
    const professionalStats = professionalId
      ? await computeProfessionalStats(professionalId.toString())
      : null;

    const serviceConfigurationId = project.serviceConfigurationId;
    const vatConfig = serviceConfigurationId
      ? await ServiceConfiguration.findById(serviceConfigurationId)
          .select("vatManagement.enabled vatManagement.rateRuleGroup vatManagement.reducedVatQuestions")
          .lean()
      : null;
    const serialized = serializePublicProject(project);
    res.json({
      success: true,
      project: {
        ...serialized,
        vatManagement: vatConfig?.vatManagement?.enabled
          ? {
              enabled: true,
              rateRuleGroup: vatConfig.vatManagement.rateRuleGroup,
              reducedVatQuestions: vatConfig.vatManagement.reducedVatQuestions,
            }
          : undefined,
        professionalStats,
      }
    });
  } catch (error) {
    console.error('Error fetching published project:', error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch project"
    });
  }
};

// Public endpoint - Get team availability (blocked dates) for a project
export const getProjectTeamAvailability = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const subprojectIndexRaw = req.query.subprojectIndex as string | undefined;
    const excludeBookingId = req.query.excludeBookingId as string | undefined;
    const debugEnabled =
      process.env.ENABLE_DEBUG_PAYLOAD === "true" ||
      (typeof req.query.debug === "string" &&
        req.query.debug.toLowerCase() === "true") ||
      (process.env.DEBUG_PAYLOAD_SECRET &&
        req.headers["x-debug-payload"] === process.env.DEBUG_PAYLOAD_SECRET);

    const project = await Project.findOne({
      _id: id,
      status: "published",
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found"
      });
    }

    const subprojects = Array.isArray(project.subprojects)
      ? project.subprojects
      : [];
    const subprojectIndexResult = parseSubprojectIndex(
      subprojectIndexRaw,
      subprojects.length
    );
    if (!subprojectIndexResult.valid) {
      return res.status(400).json({
        success: false,
        error: subprojectIndexResult.error,
      });
    }
    const subprojectIndex = subprojectIndexResult.index;

    const teamMemberIds = project.resources || [];

    // Validate and convert team member IDs once, before any queries
    // This prevents Mongoose CastError when project.resources contains invalid ObjectIds
    const validatedTeamMemberIds: mongoose.Types.ObjectId[] = [];
    if (Array.isArray(teamMemberIds)) {
      for (const memberId of teamMemberIds) {
        if (memberId == null) {
          console.warn(
            `[getProjectTeamAvailability] Skipping null/undefined team member ID in project.resources for project ${project._id}`
          );
          continue;
        }

        // Handle string IDs
        if (typeof memberId === 'string') {
          if (mongoose.isValidObjectId(memberId)) {
            validatedTeamMemberIds.push(new mongoose.Types.ObjectId(memberId));
          } else {
            console.warn(
              `[getProjectTeamAvailability] Skipping invalid string team member ID "${memberId}" in project.resources for project ${project._id}`
            );
          }
          continue;
        }

        // Handle existing ObjectId instances or objects with toString
        const memberIdStr = String(memberId);
        if (mongoose.isValidObjectId(memberIdStr)) {
          validatedTeamMemberIds.push(new mongoose.Types.ObjectId(memberIdStr));
        } else {
          console.warn(
            `[getProjectTeamAvailability] Skipping invalid team member ID (type: ${typeof memberId}, value: ${memberIdStr}) in project.resources for project ${project._id}`
          );
        }
      }
    }
    const validatedTeamMemberIdStrings = validatedTeamMemberIds.map((id) => String(id));

    const professional = await User.findById(project.professionalId).select(
      "companyAvailability companyBlockedDates companyBlockedRanges blockedDates blockedRanges businessInfo.timezone"
    );

    // Get professional's timezone for proper date handling
    const timeZone = professional?.businessInfo?.timezone || "UTC";

    const availability = resolveAvailability(professional?.companyAvailability);
    const { rangeStart, rangeEnd } = getDateRange(startDate, endDate, 180);
    const nonWorkingDates = buildNonWorkingDates(
      rangeStart,
      rangeEnd,
      timeZone,
      availability
    );

    const blockedCategories = {
      weekends: nonWorkingDates,
      company: {
        dates: [] as string[],
        ranges: [] as Array<{ startDate: string; endDate: string; reason?: string }>,
      },
      personal: {
        dates: [] as string[],
        ranges: [] as Array<{ startDate: string; endDate: string; reason?: string }>,
      },
      bookings: {
        ranges: [] as Array<{ startDate: string; endDate: string; reason?: string }>,
      },
    };

    // Helper to normalize a date key to the professional's local midnight
    const normalizeDateKey = (dateIso: string): string => {
      const date = new Date(dateIso);
      if (Number.isNaN(date.getTime())) return "";
      return toLocalMidnightUtc(date, timeZone).toISOString();
    };

    // Get resource policy to determine if we need multi-resource logic
    const resourcePolicy = getResourcePolicy(project);
    const { minResources, totalResources } = resourcePolicy;

    // Track blocked members per date for multi-resource logic
    // Key: date ISO string (normalized to local midnight UTC), Value: Set of member IDs blocked on that date
    const dateBlockedMembers = new Map<string, Set<string>>();
    // Track which members have FULL-DAY blocks (from blockedDates, not ranges)
    const memberFullDayBlocked = new Map<string, Set<string>>(); // dateIso -> Set<memberId>
    // Track actual blocked time ranges per member (for 4-hour threshold calculation)
    const memberBlockedTimeRanges = new Map<string, Array<{ start: Date; end: Date }>>();
    const PARTIAL_BLOCK_THRESHOLD = 4; // hours
    const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    // Helper to mark a member as blocked on a date
    const markMemberBlocked = (dateIso: string, memberId: string) => {
      const dateKey = normalizeDateKey(dateIso);
      if (!dateKey) return;
      if (!dateBlockedMembers.has(dateKey)) {
        dateBlockedMembers.set(dateKey, new Set());
      }
      dateBlockedMembers.get(dateKey)!.add(memberId);
    };

    // Helper to mark a member as having a full-day block on a date
    const markMemberFullDayBlocked = (dateIso: string, memberId: string) => {
      const dateKey = normalizeDateKey(dateIso);
      if (!dateKey) return;
      if (!memberFullDayBlocked.has(dateKey)) {
        memberFullDayBlocked.set(dateKey, new Set());
      }
      memberFullDayBlocked.get(dateKey)!.add(memberId);
      markMemberBlocked(dateIso, memberId);
    };

    // Helper to store a blocked time range for a member
    const addMemberTimeRange = (startIso: string, endIso: string, memberId: string) => {
      const start = new Date(startIso);
      const end = new Date(endIso);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
      if (!memberBlockedTimeRanges.has(memberId)) {
        memberBlockedTimeRanges.set(memberId, []);
      }
      memberBlockedTimeRanges.get(memberId)!.push({ start, end });
    };

    // Helper to expand a date range and mark a member blocked only when the
    // blocked overlap with that working day is at least the threshold hours.
    // Uses professional's timezone to determine which calendar days are affected
    const expandRangeAndMarkBlocked = (startIso: string, endIso: string, memberId: string) => {
      const start = new Date(startIso);
      const end = new Date(endIso);

      // Validate dates before processing
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        console.warn(`[getProjectTeamAvailability] Invalid date range for member ${memberId}: ${startIso} - ${endIso}`);
        return;
      }

      // Store the actual time range for threshold calculation
      addMemberTimeRange(startIso, endIso, memberId);

      const rangeEndInclusive = normalizeRangeEndInclusive(end, timeZone);

      // Convert to professional's timezone to get correct calendar days
      const startZoned = toZonedTime(start, timeZone);
      const endZoned = toZonedTime(rangeEndInclusive, timeZone);

      // Get calendar days in the professional's timezone
      const startDay = new Date(Date.UTC(startZoned.getUTCFullYear(), startZoned.getUTCMonth(), startZoned.getUTCDate()));
      const endDay = new Date(Date.UTC(endZoned.getUTCFullYear(), endZoned.getUTCMonth(), endZoned.getUTCDate()));

      const cursor = new Date(startDay);
      while (cursor <= endDay) {
        const dayStartZoned = startOfDayZoned(cursor);
        const nextDayZoned = new Date(dayStartZoned.getTime());
        nextDayZoned.setUTCDate(nextDayZoned.getUTCDate() + 1);

        const dayStartUtc = fromZonedTime(dayStartZoned, timeZone);
        const dayEndUtc = fromZonedTime(nextDayZoned, timeZone);
        if (rangeEndInclusive <= dayStartUtc || start >= dayEndUtc) {
          cursor.setUTCDate(cursor.getUTCDate() + 1);
          continue;
        }

        const workingRange = getWorkingRangeUtc(availability, cursor, timeZone);
        if (!workingRange) {
          cursor.setUTCDate(cursor.getUTCDate() + 1);
          continue;
        }

        const overlapStart = Math.max(
          start.getTime(),
          dayStartUtc.getTime(),
          workingRange.startUtc.getTime()
        );
        const overlapEnd = Math.min(
          rangeEndInclusive.getTime(),
          dayEndUtc.getTime(),
          workingRange.endUtc.getTime()
        );

        if (overlapEnd > overlapStart) {
          const overlapHours = (overlapEnd - overlapStart) / (1000 * 60 * 60);
          if (overlapHours >= PARTIAL_BLOCK_THRESHOLD_HOURS) {
            markMemberBlocked(cursor.toISOString(), memberId);
          }
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    };

    // Compute blocked hours for a member on a specific day (within working hours)
    const computeMemberBlockedHoursForDay = (memberId: string, dateIso: string): number => {
      const ranges = memberBlockedTimeRanges.get(memberId);
      if (!ranges || ranges.length === 0) return 0;

      const dayUtc = new Date(dateIso);
      const zonedDay = toZonedTime(dayUtc, timeZone);
      const dayConfig = availability[DAY_NAMES[zonedDay.getUTCDay()]];
      if (!dayConfig?.available || !dayConfig?.startTime || !dayConfig?.endTime) return Infinity;

      const dateStr = dateIso.split('T')[0];
      const workingStartMs = fromZonedTime(
        new Date(Date.UTC(
          parseInt(dateStr.slice(0, 4)), parseInt(dateStr.slice(5, 7)) - 1, parseInt(dateStr.slice(8, 10)),
          parseInt(dayConfig.startTime.split(':')[0]), parseInt(dayConfig.startTime.split(':')[1]), 0
        )),
        timeZone
      ).getTime();
      const workingEndMs = fromZonedTime(
        new Date(Date.UTC(
          parseInt(dateStr.slice(0, 4)), parseInt(dateStr.slice(5, 7)) - 1, parseInt(dateStr.slice(8, 10)),
          parseInt(dayConfig.endTime.split(':')[0]), parseInt(dayConfig.endTime.split(':')[1]), 0
        )),
        timeZone
      ).getTime();

      if (workingEndMs <= workingStartMs) return Infinity;

      const dayStartMs = dayUtc.getTime();
      const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

      const clamped = ranges
        .map(range => {
          const rangeStartMs = Math.max(range.start.getTime(), dayStartMs);
          const rangeEndMs = Math.min(range.end.getTime(), dayEndMs);
          if (rangeEndMs <= rangeStartMs) return null;
          const start = Math.max(rangeStartMs, workingStartMs);
          const end = Math.min(rangeEndMs, workingEndMs);
          if (end <= start) return null;
          return { start, end };
        })
        .filter((v): v is { start: number; end: number } => v !== null)
        .sort((a, b) => a.start - b.start);

      if (clamped.length === 0) return 0;

      let totalMinutes = 0;
      let currentStart = clamped[0].start;
      let currentEnd = clamped[0].end;

      for (let i = 1; i < clamped.length; i++) {
        if (clamped[i].start <= currentEnd) {
          currentEnd = Math.max(currentEnd, clamped[i].end);
        } else {
          totalMinutes += (currentEnd - currentStart) / (1000 * 60);
          currentStart = clamped[i].start;
          currentEnd = clamped[i].end;
        }
      }
      totalMinutes += (currentEnd - currentStart) / (1000 * 60);

      return totalMinutes / 60;
    };

    // Company blocked dates/ranges block ALL resources - add directly to allBlockedDates
    const allBlockedDates = new Set<string>(nonWorkingDates);
    const allBlockedRanges: Array<{ startDate: string; endDate: string; reason?: string }> = [];

    if (professional?.companyBlockedDates) {
      professional.companyBlockedDates.forEach((blocked) => {
        const date = toIsoDate(blocked.date);
        if (!date) return;
        blockedCategories.company.dates.push(date);
        const normalizedDate = normalizeDateKey(date);
        if (normalizedDate) {
          allBlockedDates.add(normalizedDate); // Company dates always fully blocked
        }
      });
    }

    if (professional?.companyBlockedRanges) {
      professional.companyBlockedRanges.forEach((range) => {
        const blockedRange = toBlockedRange(range);
        if (!blockedRange) return;
        blockedCategories.company.ranges.push(blockedRange);
        allBlockedRanges.push(blockedRange);
        // Company ranges apply to every resource in the team.
        validatedTeamMemberIdStrings.forEach((memberId) => {
          expandRangeAndMarkBlocked(blockedRange.startDate, blockedRange.endDate, memberId);
        });
      });
    }

    // Fetch team members (name only needed for debug payloads)
    const teamMembers =
      validatedTeamMemberIds.length > 0
        ? await User.find({
          _id: { $in: validatedTeamMemberIds },
        }).select(
          debugEnabled
            ? "_id name blockedDates blockedRanges"
            : "_id blockedDates blockedRanges"
        )
        : [];

    type TeamMemberDebugInfo = Record<
      string,
      {
        name: string;
        personalBlockedDates: string[];
        personalBlockedRanges: any[];
        bookingBlockedDates: string[];
      }
    >;
    const teamMemberDebugInfo: TeamMemberDebugInfo | null = debugEnabled
      ? {}
      : null;
    if (debugEnabled) {
      teamMembers.forEach((member) => {
        const memberId = String(member._id);
        teamMemberDebugInfo![memberId] = {
          name: (member as any).name || "Unknown",
          personalBlockedDates: [],
          personalBlockedRanges: [],
          bookingBlockedDates: [],
        };
      });
    }

    // Process personal blocked dates for each team member (tracked per-member)
    teamMembers.forEach((member) => {
      const memberId = String(member._id);

      if (member.blockedDates) {
        member.blockedDates.forEach((blocked) => {
          const date = toIsoDate(blocked.date);
          if (!date) return;
          blockedCategories.personal.dates.push(date);
          markMemberFullDayBlocked(date, memberId);
          // Add to debug info
          if (debugEnabled && teamMemberDebugInfo?.[memberId]) {
            teamMemberDebugInfo[memberId].personalBlockedDates.push(date);
          }
        });
      }

      if (member.blockedRanges) {
        member.blockedRanges.forEach((range) => {
          const blockedRange = toBlockedRange(range);
          if (!blockedRange) return;
          blockedCategories.personal.ranges.push(blockedRange);
          expandRangeAndMarkBlocked(blockedRange.startDate, blockedRange.endDate, memberId);
          // Add to debug info
          if (debugEnabled && teamMemberDebugInfo?.[memberId]) {
            teamMemberDebugInfo[memberId].personalBlockedRanges.push(blockedRange);
          }
        });
      }
    });

    // Booking filter - must match scheduleEngine.ts buildPerMemberBlockedData for consistency
    // Both endpoints must use the same criteria to determine which bookings block resources
    const bookingFilter: any = {
      status: { $nin: ["completed", "cancelled", "refunded"] },
      scheduledStartDate: { $exists: true, $ne: null },
      // Require valid end date to exist (matches scheduleEngine.ts)
      $and: [
        {
          $or: [
            { scheduledBufferEndDate: { $exists: true, $ne: null } },
            { scheduledExecutionEndDate: { $exists: true, $ne: null } },
          ],
        },
      ],
      $or: [
        { project: project._id },
      ],
    };

    if (excludeBookingId && mongoose.isValidObjectId(excludeBookingId)) {
      bookingFilter._id = { $ne: new mongoose.Types.ObjectId(excludeBookingId) };
    }

    // Add team member filters if we have valid IDs
    if (validatedTeamMemberIds.length > 0) {
      bookingFilter.$or.push(
        { assignedTeamMembers: { $in: validatedTeamMemberIds } },
        { professional: { $in: validatedTeamMemberIds } }
      );
    }

    const bookings = await Booking.find(bookingFilter).select(
      "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate status assignedTeamMembers professional"
    );

    // Build set of project resources for efficient lookup (using validated IDs)
    const projectResources = new Set(validatedTeamMemberIds.map((id) => String(id)));
    const finalBlockedDateSet = new Set<string>();

    const rangeIntersectsBlockedDates = (
      range: { startDate: string; endDate: string }
    ): boolean => {
      const startKey = normalizeDateKey(range.startDate);
      const endKey = normalizeDateKey(range.endDate);
      if (!startKey || !endKey) return false;
      const start = new Date(startKey);
      const end = new Date(endKey);

      const cursor = new Date(start);

      while (cursor <= end) {
        const key = normalizeDateKey(cursor.toISOString());
        if (finalBlockedDateSet.has(key)) {
          return true;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      return false;
    };

    // Debug: track bookings info
    const bookingsDebugInfo: Array<{
      bookingId: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      blockedMembers: string[];
      blockedMemberNames: string[];
    }> | null = debugEnabled ? [] : null;

    // Track which bookings block which resources
    bookings.forEach((booking) => {
      const scheduledExecutionEndDate =
        booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
      const scheduledBufferStartDate =
        booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
      const scheduledBufferEndDate =
        booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

      // Find which of our project's resources are blocked by this booking.
      // Match scheduleEngine legacy logic for bookings without assigned team members.
      const blockedResourceIds = new Set<string>();

      const assignedTeamMembers = Array.isArray(booking.assignedTeamMembers)
        ? booking.assignedTeamMembers
        : [];
      const hasAssignedMembers = assignedTeamMembers.length > 0;

      if (hasAssignedMembers) {
        assignedTeamMembers.forEach((memberId: any) => {
          const memberIdStr = String(memberId);
          if (projectResources.has(memberIdStr)) {
            blockedResourceIds.add(memberIdStr);
          }
        });
      } else {
        // Legacy: fall back to professional or project match
        if (booking.professional) {
          const profIdStr = String(booking.professional);
          if (projectResources.has(profIdStr)) {
            blockedResourceIds.add(profIdStr);
          }
        }

        const projectId = String(project._id);
        if (booking.project && String(booking.project) === projectId) {
          projectResources.forEach((resourceId) => {
            blockedResourceIds.add(resourceId);
          });
        }
      }

      // Add to bookings debug info
      if (debugEnabled && bookingsDebugInfo && blockedResourceIds.size > 0) {
        const blockedResourceIdsArray = Array.from(blockedResourceIds);
        bookingsDebugInfo.push({
          bookingId: String(booking._id),
          scheduledStart: booking.scheduledStartDate ? toIsoDate(booking.scheduledStartDate) : null,
          scheduledEnd: scheduledExecutionEndDate ? toIsoDate(scheduledExecutionEndDate) : null,
          blockedMembers: blockedResourceIdsArray,
          blockedMemberNames: blockedResourceIdsArray.map(
            (id) => teamMemberDebugInfo?.[id]?.name || "Unknown"
          ),
        });
      }

      // Block the execution period for each blocked resource
      if (booking.scheduledStartDate && scheduledExecutionEndDate) {
        const blockedRange = toBlockedRange({
          startDate: booking.scheduledStartDate,
          endDate: scheduledExecutionEndDate,
          reason: "booking",
        });
        if (blockedRange) {
          blockedCategories.bookings.ranges.push(blockedRange);
          // Mark each blocked resource for each day in the range
          blockedResourceIds.forEach((resourceId) => {
            expandRangeAndMarkBlocked(blockedRange.startDate, blockedRange.endDate, resourceId);
            // Add blocked dates to debug info
            if (debugEnabled && teamMemberDebugInfo?.[resourceId]) {
              const start = new Date(blockedRange.startDate);
              const end = new Date(blockedRange.endDate);
              const cursor = new Date(start);
              while (cursor <= end) {
                const bookingDateKey = normalizeDateKey(cursor.toISOString());
                if (bookingDateKey) {
                  teamMemberDebugInfo[resourceId].bookingBlockedDates.push(
                    bookingDateKey.split("T")[0]
                  );
                }
                cursor.setUTCDate(cursor.getUTCDate() + 1);
              }
            }
          });
        }
      }
      // Block the buffer period (if exists) for each blocked resource
      if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
        const bufferRange = toBlockedRange({
          startDate: scheduledBufferStartDate,
          endDate: scheduledBufferEndDate.toISOString(),
          reason: "booking-buffer",
        });
        if (bufferRange) {
          blockedCategories.bookings.ranges.push(bufferRange);
          // Mark each blocked resource for each day in the range
          blockedResourceIds.forEach((resourceId) => {
            expandRangeAndMarkBlocked(bufferRange.startDate, bufferRange.endDate, resourceId);
          });
        }
      }
    });

    // Apply resource policy logic with window-based throughput and overlap checks
    // Guard: if no resources are available, return early (matches schedule engine behavior)
    // Check both totalResources (from policy) and validatedTeamMemberIds (actual valid ObjectIds)
    // This handles cases where project.resources contains invalid IDs that fail validation
    if (totalResources === 0 || validatedTeamMemberIds.length === 0) {
      console.warn(
        `[getProjectTeamAvailability] Project ${project._id} has no valid resources ` +
        `(totalResources=${totalResources}, validatedTeamMemberIds.length=${validatedTeamMemberIds.length}). ` +
        `Returning no availability.`
      );
      return res.json({
        success: true,
        blockedDates: [],
        blockedRanges: [],
        blockedCategories,
        resourcePolicy,
        noResources: true,
      });
    }

    const useMultiResourceMode = validatedTeamMemberIds.length > 0;
    const requiredOverlap =
      minResources <= 1 ? 100 : resourcePolicy.minOverlapPercentage;
    // Get execution duration from project or subprojects for window-based checks
    let executionDays: number | null = null;

    const projectData = project as any;

    // If subprojectIndex is provided, use that specific subproject's execution duration
    if (typeof subprojectIndex === 'number' &&
        projectData.subprojects &&
        Array.isArray(projectData.subprojects) &&
        projectData.subprojects[subprojectIndex]?.executionDuration?.value &&
        projectData.subprojects[subprojectIndex]?.executionDuration?.unit === 'days') {
      executionDays = Math.max(1, Math.ceil(projectData.subprojects[subprojectIndex].executionDuration.value));
    } else if (projectData.executionDuration?.value && projectData.executionDuration?.unit === 'days') {
      // Use project-level execution duration
      executionDays = Math.max(1, Math.ceil(projectData.executionDuration.value));
    } else if (projectData.subprojects && Array.isArray(projectData.subprojects)) {
      // Fallback: use the maximum execution duration from all subprojects for conservative blocking
      let maxExecution = 0;
      for (const sp of projectData.subprojects) {
        if (sp.executionDuration?.value && sp.executionDuration?.unit === 'days') {
          maxExecution = Math.max(maxExecution, sp.executionDuration.value);
        }
      }
      if (maxExecution > 0) {
        executionDays = Math.ceil(maxExecution);
      }
    }


    // Debug: Log resource policy and blocked data summary (gated behind debug flag)
    if (debugEnabled) {
      console.log(`[getProjectTeamAvailability] Project ${project._id}:`, {
        totalResources,
        minResources,
        requiredOverlap,
        executionDays,
        teamMemberIds: validatedTeamMemberIds.map(id => String(id)),
        dateBlockedMembersCount: dateBlockedMembers.size,
      });
    }

    // Per-day blocking for multi-resource availability:
    // A day is unavailable when fewer than minResources are available.
    // Uses the 4-hour threshold: a member is only considered "blocked" on a day
    // if they have a full-day block OR their blocked ranges within working hours >= 4 hours.
    // This must match days-mode scheduling start-date validation.
    if (useMultiResourceMode) {
      dateBlockedMembers.forEach((blockedMemberIds, dateIso) => {
        const fullDayBlocked = memberFullDayBlocked.get(dateIso);

        // Count actually blocked members using 4-hour threshold
        let actualBlockedCount = 0;
        blockedMemberIds.forEach(memberId => {
          // Full-day blocks always count
          if (fullDayBlocked?.has(memberId)) {
            actualBlockedCount++;
            return;
          }
          // Range-based blocks: apply 4-hour threshold
          const blockedHours = computeMemberBlockedHoursForDay(memberId, dateIso);
          if (blockedHours >= PARTIAL_BLOCK_THRESHOLD) {
            actualBlockedCount++;
          }
        });

        const availableResources = totalResources - actualBlockedCount;

        if (availableResources < minResources) {
          allBlockedDates.add(dateIso);
          finalBlockedDateSet.add(dateIso);
        }
      });
    } else {
      // Single resource mode: also apply 4-hour threshold for range-based blocks
      dateBlockedMembers.forEach((blockedMemberIds, dateIso) => {
        const fullDayBlocked = memberFullDayBlocked.get(dateIso);

        // Check if any member is actually blocked (full-day or >= 4 hours)
        let hasActualBlock = false;
        blockedMemberIds.forEach(memberId => {
          if (fullDayBlocked?.has(memberId)) {
            hasActualBlock = true;
            return;
          }
          const blockedHours = computeMemberBlockedHoursForDay(memberId, dateIso);
          if (blockedHours >= PARTIAL_BLOCK_THRESHOLD) {
            hasActualBlock = true;
          }
        });

        if (hasActualBlock) {
          allBlockedDates.add(dateIso);
          finalBlockedDateSet.add(dateIso);
        }
      });
    }

    // In multi-resource days mode, don't add individual booking/personal ranges.
    // We only want to block explicit dates (all resources unavailable or full overlap).
    const useWindowBasedCheck = useMultiResourceMode && executionDays && executionDays > 0;

    if (!useWindowBasedCheck) {
      // Only add ranges in simple mode (single resource or no execution duration)
      blockedCategories.personal.ranges.forEach((range) => {
        if (rangeIntersectsBlockedDates(range)) {
          allBlockedRanges.push(range);
        }
      });

      blockedCategories.bookings.ranges.forEach((range) => {
        if (rangeIntersectsBlockedDates(range)) {
          allBlockedRanges.push(range);
        }
      });
    }


    if (useWindowBasedCheck) {
      const unbookableYmds = await getUnbookableStartDates({
        projectId: String(project._id),
        from: rangeStart,
        to: rangeEnd,
        subprojectIndex:
          typeof subprojectIndex === "number" ? subprojectIndex : undefined,
        excludeBookingId,
      });

      unbookableYmds.forEach((ymd) => {
        const parts = ymd.split("-").map(Number);
        if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return;
        const [year, month, day] = parts;
        const zonedMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
        const key = fromZonedTime(zonedMidnight, timeZone).toISOString();
        allBlockedDates.add(key);
        finalBlockedDateSet.add(key);
      });
    }

    const blockedDatesArray = Array.from(allBlockedDates);

    const proposals = await buildProjectScheduleProposals(
      id as string,
      subprojectIndex,
      undefined,
      excludeBookingId
    );

    // Build response
    const response: any = {
      success: true,
      timezone: timeZone,
      blockedDates: blockedDatesArray,
      blockedRanges: allBlockedRanges,
      blockedCategories,
      resourcePolicy,
      earliestBookableDate: proposals?.earliestBookableDate,
    };

    // Only include _debug payload when explicitly enabled
    if (debugEnabled && teamMemberDebugInfo && bookingsDebugInfo) {
      // Build anonymization mapping: real member ID -> anonymized token
      const memberIdToToken = new Map<string, string>();
      let tokenCounter = 1;
      const getAnonymizedToken = (memberId: string): string => {
        if (!memberIdToToken.has(memberId)) {
          memberIdToToken.set(memberId, `resource_${tokenCounter++}`);
        }
        return memberIdToToken.get(memberId)!;
      };

      // Build per-date blocked members info for debug (anonymized)
      const dateBlockedMembersDebug: Record<string, { blockedCount: number; blockedTokens: string[] }> = {};
      dateBlockedMembers.forEach((memberIds, dateKey) => {
        const dateStr = dateKey.split('T')[0];
        dateBlockedMembersDebug[dateStr] = {
          blockedCount: memberIds.size,
          blockedTokens: Array.from(memberIds).map(id => getAnonymizedToken(id)),
        };
      });

      // Anonymize team member debug info (remove names and real IDs)
      const teamMembersAnonymized: Record<string, {
        personalBlockedDatesCount: number;
        personalBlockedRangesCount: number;
        bookingBlockedDatesCount: number;
      }> = {};
      Object.entries(teamMemberDebugInfo).forEach(([memberId, info]) => {
        const token = getAnonymizedToken(memberId);
        teamMembersAnonymized[token] = {
          personalBlockedDatesCount: info.personalBlockedDates.length,
          personalBlockedRangesCount: info.personalBlockedRanges.length,
          bookingBlockedDatesCount: info.bookingBlockedDates.length,
        };
      });

      // Anonymize bookings debug info (remove names and real IDs)
      const bookingsAnonymized = bookingsDebugInfo.map((booking) => ({
        scheduledStart: booking.scheduledStart,
        scheduledEnd: booking.scheduledEnd,
        blockedCount: booking.blockedMembers.length,
        blockedTokens: booking.blockedMembers.map(id => getAnonymizedToken(id)),
      }));

      response._debug = {
        subprojectIndex,
        projectId: String(project._id),
        timeZone,
        totalBlockedDates: blockedDatesArray.length,
        totalBlockedRanges: allBlockedRanges.length,
        useWindowBasedCheck,
        executionDays,
        minResources,
        totalResources,
        requiredOverlap,
        teamMembers: teamMembersAnonymized,
        bookings: bookingsAnonymized,
        dateBlockedMembers: dateBlockedMembersDebug,
      };
    }

    res.json(response);
  } catch (error) {
    console.error('Error fetching team availability:', error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch team availability"
    });
  }
};

export const getProjectWorkingHours = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const project = await Project.findOne({
      _id: id,
      status: "published",
    }).select("professionalId");

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    const professional = await User.findById(project.professionalId).select(
      "companyAvailability businessInfo.timezone"
    );

    const availability = resolveAvailability(professional?.companyAvailability);

    res.json({
      success: true,
      availability,
      timezone: professional?.businessInfo?.timezone || "UTC",
    });
  } catch (error) {
    console.error("Error fetching working hours:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch working hours",
    });
  }
};

export const getProjectScheduleProposals = async (req: Request, res: Response) => {
  try {
    console.log('[SCHEDULE PROPOSALS API] Request for project:', req.params.id);
    const { id } = req.params;
    const subprojectIndexRaw = req.query.subprojectIndex as string | undefined;
    const excludeBookingId = req.query.excludeBookingId as string | undefined;

    const project = await Project.findById(id).select("subprojects");
    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    const subprojects = Array.isArray(project.subprojects)
      ? project.subprojects
      : [];
    const subprojectIndexResult = parseSubprojectIndex(
      subprojectIndexRaw,
      subprojects.length
    );
    if (!subprojectIndexResult.valid) {
      return res.status(400).json({
        success: false,
        error: subprojectIndexResult.error,
      });
    }
    const subprojectIndex = subprojectIndexResult.index;

    const parseDur = (v: unknown, u: unknown): { ok: true; value?: { value: number; unit: 'hours' | 'days' } } | { ok: false; error: string } => {
      if (v == null && u == null) return { ok: true };
      const value = Number(v);
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, error: 'Duration value must be a positive number' };
      }
      if (u !== 'hours' && u !== 'days') {
        return { ok: false, error: "Duration unit must be 'hours' or 'days'" };
      }
      return { ok: true, value: { value, unit: u } };
    };
    const executionParsed = parseDur(req.query.executionValue, req.query.executionUnit);
    if (!executionParsed.ok) {
      return res.status(400).json({ success: false, error: executionParsed.error });
    }
    const preparationParsed = parseDur(req.query.preparationValue, req.query.preparationUnit);
    if (!preparationParsed.ok) {
      return res.status(400).json({ success: false, error: preparationParsed.error });
    }
    const bufferParsed = parseDur(req.query.bufferValue, req.query.bufferUnit);
    if (!bufferParsed.ok) {
      return res.status(400).json({ success: false, error: bufferParsed.error });
    }
    const durationOverride = executionParsed.value || preparationParsed.value || bufferParsed.value
      ? { execution: executionParsed.value, preparation: preparationParsed.value, buffer: bufferParsed.value }
      : undefined;

    const proposals = await buildProjectScheduleProposals(id as string, subprojectIndex, durationOverride, excludeBookingId);

    if (!proposals) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    console.log('[SCHEDULE PROPOSALS API] Response:', {
      earliestProposal: proposals.earliestProposal,
      shortestThroughputProposal: proposals.shortestThroughputProposal
    });

    res.json({
      success: true,
      proposals,
    });
  } catch (error) {
    console.error("Error fetching schedule proposals:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch schedule proposals",
    });
  }
};

export const getProjectAvailableSlots = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const date = req.query.date as string | undefined;
    const subprojectIndexRaw = req.query.subprojectIndex as string | undefined;

    if (!id || typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        error: "date query parameter is required (YYYY-MM-DD)",
      });
    }

    const [year, month, day] = date.split("-").map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      Number.isNaN(probe.getTime()) ||
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() + 1 !== month ||
      probe.getUTCDate() !== day
    ) {
      return res.status(400).json({
        success: false,
        error: "date query parameter must be a valid calendar date (YYYY-MM-DD)",
      });
    }

    const project = await Project.findOne({ _id: id, status: "published" }).select("subprojects");
    if (!project) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const subprojects = Array.isArray(project.subprojects) ? project.subprojects : [];
    const subprojectIndexResult = parseSubprojectIndex(subprojectIndexRaw, subprojects.length);
    if (!subprojectIndexResult.valid) {
      return res.status(400).json({ success: false, error: subprojectIndexResult.error });
    }

    const result = await getProjectAvailableSlotsForDate({
      projectId: id as string,
      subprojectIndex: subprojectIndexResult.index,
      startDate: date,
    });

    if (!result) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    return res.json({ success: true, slots: result.slots, mode: result.mode });
  } catch (error) {
    console.error("Error fetching available slots:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch slots" });
  }
};

/**
 * Get the schedule window (including completion date) for a specific start date.
 * This uses the same backend logic as booking creation to ensure consistency.
 */
export const getProjectScheduleWindow = async (req: Request, res: Response) => {
  try {
    console.log('[SCHEDULE WINDOW API] Request received:', {
      projectId: req.params.id,
      query: req.query
    });

    const { id } = req.params;
    const {
      subprojectIndex: subprojectIndexRaw,
      startDate,
      startTime,
    } = req.query;

    if (!startDate || typeof startDate !== "string") {
      console.log('[SCHEDULE WINDOW API] Missing startDate');
      return res.status(400).json({
        success: false,
        error: "startDate query parameter is required",
      });
    }

    const project = await Project.findById(id).select("subprojects");
    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    const subprojects = Array.isArray(project.subprojects)
      ? project.subprojects
      : [];
    const subprojectIndexResult = parseSubprojectIndex(
      subprojectIndexRaw as string | undefined,
      subprojects.length
    );
    if (!subprojectIndexResult.valid) {
      return res.status(400).json({
        success: false,
        error: subprojectIndexResult.error,
      });
    }
    const subprojectIndex = subprojectIndexResult.index;

    const parseDurW = (v: unknown, u: unknown): { ok: true; value?: { value: number; unit: 'hours' | 'days' } } | { ok: false; error: string } => {
      if (v == null && u == null) return { ok: true };
      const value = Number(v);
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, error: 'Duration value must be a positive number' };
      }
      if (u !== 'hours' && u !== 'days') {
        return { ok: false, error: "Duration unit must be 'hours' or 'days'" };
      }
      return { ok: true, value: { value, unit: u } };
    };
    const executionParsedW = parseDurW(req.query.executionValue, req.query.executionUnit);
    if (!executionParsedW.ok) {
      return res.status(400).json({ success: false, error: executionParsedW.error });
    }
    const preparationParsedW = parseDurW(req.query.preparationValue, req.query.preparationUnit);
    if (!preparationParsedW.ok) {
      return res.status(400).json({ success: false, error: preparationParsedW.error });
    }
    const bufferParsedW = parseDurW(req.query.bufferValue, req.query.bufferUnit);
    if (!bufferParsedW.ok) {
      return res.status(400).json({ success: false, error: bufferParsedW.error });
    }
    const durationOverrideW = executionParsedW.value || preparationParsedW.value || bufferParsedW.value
      ? { execution: executionParsedW.value, preparation: preparationParsedW.value, buffer: bufferParsedW.value }
      : undefined;

    const window = await buildProjectScheduleWindow({
      projectId: id as string,
      subprojectIndex,
      startDate: startDate as string,
      startTime: typeof startTime === "string" ? startTime : undefined,
      durationOverride: durationOverrideW,
    });

    if (!window) {
      console.log('[SCHEDULE WINDOW API] No window returned - date not available');
      return res.status(400).json({
        success: false,
        error: "Selected date is not available or invalid",
      });
    }

    const response = {
      success: true,
      window: {
        scheduledStartDate: window.scheduledStartDate.toISOString(),
        scheduledExecutionEndDate: window.scheduledExecutionEndDate.toISOString(),
        scheduledBufferStartDate: window.scheduledBufferStartDate?.toISOString(),
        scheduledBufferEndDate: window.scheduledBufferEndDate?.toISOString(),
        scheduledBufferUnit: window.scheduledBufferUnit,
        scheduledStartTime: window.scheduledStartTime,
        scheduledEndTime: window.scheduledEndTime,
        throughputDays: window.throughputDays,
      },
    };
    console.log('[SCHEDULE WINDOW API] Success response:', response);
    res.json(response);
  } catch (error) {
    console.error("[SCHEDULE WINDOW API] Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch schedule window",
    });
  }
};

export const submitProject = async (req: Request, res: Response) => {
  try {
    console.log("[PROJECT] SUBMIT PROJECT REQUEST RECEIVED");
    const { id } = req.params;
    const professionalId = req.user?.id;

    console.log("Project ID:", id);
    console.log("Professional ID:", professionalId);

    if (!professionalId) {
      console.log("[PROJECT] No professional ID found");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const professional = await User.findById(professionalId).select('role professionalStatus');
    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({ error: "Only approved professionals can submit projects" });
    }

    if (professional.professionalStatus !== 'approved') {
      return res.status(403).json({
        error: "Professional approval is required before submitting projects",
        code: "PROFESSIONAL_APPROVAL_REQUIRED"
      });
    }

    const project = await Project.findOne({
      _id: id,
      professionalId,
    });

    console.log("Project found:", !!project);
    console.log("Project status:", project?.status);

    if (!project) {
      console.log("[PROJECT] Project not found");
      return res.status(404).json({ error: "Project not found" });
    }

    // Allow resubmission for draft, rejected, pending, published, or on_hold projects
    if (
      !["draft", "rejected", "pending", "published", "on_hold"].includes(project.status)
    ) {
      console.log("[PROJECT] Invalid status for submission:", project.status);
      return res
        .status(400)
        .json({ error: "Project cannot be submitted in current status" });
    }

    console.log("[PROJECT] Project validation passed, running quality checks...");

    const qualityChecks = [];

    if (!project.title || project.title.length < 30) {
      qualityChecks.push({
        category: "content",
        status: "failed" as const,
        message: "Title must be at least 30 characters long",
        checkedAt: new Date(),
      });
    }

    if (!project.description || project.description.length < 100) {
      qualityChecks.push({
        category: "content",
        status: "failed" as const,
        message: "Description must be at least 100 characters long",
        checkedAt: new Date(),
      });
    }

    if (project.subprojects.length === 0) {
      qualityChecks.push({
        category: "pricing",
        status: "failed" as const,
        message: "At least one subproject/pricing variation is required",
        checkedAt: new Date(),
      });
    }

    if (!project.resources || project.resources.length === 0) {
      qualityChecks.push({
        category: "resources",
        status: "failed" as const,
        message: "At least one team resource is required for scheduling",
        checkedAt: new Date(),
      });
    }

    const failedChecks = qualityChecks.filter(
      (check) => check.status === "failed"
    );

    if (failedChecks.length > 0) {
      project.qualityChecks = qualityChecks;
      await project.save();
      return res.status(400).json({
        error: "Quality checks failed",
        qualityChecks: failedChecks,
      });
    }

    // Smart reapproval logic for resubmissions
    project.qualityChecks = qualityChecks;

    if (project.isResubmission && project.previousSnapshot) {
      // Fetch professional's company name for moderation
      const professional = await User.findById(professionalId).select(
        "businessInfo.companyName"
      );
      const companyName =
        professional?.businessInfo?.companyName || undefined;

      // Compute diff between approved snapshot and current data
      const currentData = project.toObject();
      const changes = computeProjectDiff(
        project.previousSnapshot,
        currentData,
        companyName
      );
      const reapprovalType = determineReapprovalType(changes);

      console.log(
        `[PROJECT] Resubmission diff: ${changes.length} changes, type: ${reapprovalType}`
      );

      // Auto-approve when all automated checks pass (no structural or flagged content changes)
      if (reapprovalType === "none") {
        console.log("[PROJECT] Resubmission auto-approved – no admin review needed");
        project.status = "published";
        project.previousSnapshot = undefined;
        project.pendingChanges = undefined;
        project.reapprovalType = undefined;
        project.isResubmission = false;

        await project.save();
        return res.json({
          message: "Changes approved automatically",
          id: project._id,
          status: project.status,
        });
      }

      // Structural changes or moderation failures → send to admin for review
      project.status = "pending";
      project.submittedAt = new Date();
      // Only store Category A/B changes — "none" fields don't need admin review
      project.pendingChanges = changes.filter((c) => c.category !== "none");
      project.reapprovalType = reapprovalType;
      project.adminFeedback = undefined;
      project.approvedAt = undefined;
      project.approvedBy = undefined;

      await project.save();
      console.log(`[PROJECT] Resubmission sent to admin for review (type: ${reapprovalType})`);
      return res.json({
        message: "Changes submitted for admin review",
        id: project._id,
        status: project.status,
        submittedAt: project.submittedAt,
      });
    }

    // First-time submission or rejected re-edit: always go to pending
    const isResubmission = project.status !== "draft";
    project.status = "pending";
    project.submittedAt = new Date();

    // Clear admin feedback on resubmission
    if (isResubmission) {
      project.adminFeedback = undefined;
    }

    await project.save();

    const message = isResubmission
      ? "Project resubmitted for approval"
      : "Project submitted for approval";
    console.log("[PROJECT] Project submitted successfully");
    console.log("Message:", message);

    res.json({ message, id: project._id, status: project.status, submittedAt: project.submittedAt });
  } catch (error: any) {
    console.error("[PROJECT] Submit project error:", error);
    console.error("Error stack:", error.stack);
    res
      .status(500)
      .json({ error: "Failed to submit project", details: error.message });
  }
};

// Duplicate a project for the current professional
export const duplicateProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const professionalId = req.user?.id;

    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const original = await Project.findOne({ _id: id, professionalId });
    if (!original) {
      return res.status(404).json({ error: "Project not found" });
    }

    const plain = original.toObject();
    // Reset fields for a clean draft copy
    delete (plain as any)._id;
    delete (plain as any).id;
    const duplicated = new Project({
      ...plain,
      title: `${plain.title} (Copy)`,
      status: "draft",
      adminFeedback: undefined,
      submittedAt: undefined,
      approvedAt: undefined,
      approvedBy: undefined,
      previousSnapshot: undefined,
      pendingChanges: undefined,
      reapprovalType: undefined,
      isResubmission: false,
      autoSaveTimestamp: new Date(),
      createdAt: undefined,
      updatedAt: undefined,
    });

    await duplicated.save();
    res.json(duplicated);
  } catch (error) {
    res.status(500).json({ error: "Failed to duplicate project" });
  }
};

// Delete a project owned by the current professional
export const deleteProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const professionalId = req.user?.id;

    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await Project.findOneAndDelete({ _id: id, professionalId });
    if (!result) {
      return res.status(404).json({ error: "Project not found" });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete project" });
  }
};

// Update project status (Hold/Resume for published projects)
export const updateProjectStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };
    const professionalId = req.user?.id;

    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!status || !["published", "on_hold"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const project = await Project.findOne({ _id: id, professionalId });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const currentStatus = project.status;
    const allowed =
      (currentStatus === "published" && status === "on_hold") ||
      (currentStatus === "on_hold" && status === "published");
    if (!allowed) {
      return res.status(400).json({ error: "Status transition not allowed" });
    }

    project.status = status as any;
    await project.save();
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ error: "Failed to update project status" });
  }
};

// Master listing with search and filters for Manage Projects screen
export const getProjectsMaster = async (req: Request, res: Response) => {
  try {
    const professionalId = req.user?.id;
    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const search = (req.query.search as string) || "";
    const status = (req.query.status as string) || "all";
    const category = (req.query.category as string) || "all";
    const service = (req.query.service as string) || "all";
    const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || "20", 10), 1),
      100
    );

    const filter: any = { professionalId };
    if (status && status !== "all") {
      if (status === "rejected") {
        filter.status = "rejected";
      } else if (status === "cancelled") {
        filter.status = "closed";
      } else {
        filter.status = status;
      }
    }
    if (category && category !== "all") {
      // Match either the primary category field or within services[] selections
      filter.$or = [{ category }, { "services.category": category }];
    }
    if (service && service !== "all") {
      // Match either the primary service field or within services[] selections
      const serviceConditions = [{ service }, { "services.service": service }];
      if (filter.$or) {
        // If category filter already set $or, combine with $and
        filter.$and = (filter.$and || []).concat([{ $or: serviceConditions }]);
      } else {
        filter.$or = serviceConditions;
      }
    }
    if (search) {
      const regex = new RegExp(search, "i");
      filter.$and = (filter.$and || []).concat([
        {
          $or: [{ title: regex }, { description: regex }, { keywords: regex }],
        },
      ]);
    }

    const [items, total, distinctServices, counts] = await Promise.all([
      Project.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Project.countDocuments(filter),
      Project.distinct("service", { professionalId }),
      // Status counts for header cards – normalize raw DB statuses
      (async () => {
        const professionalObjectId = new mongoose.Types.ObjectId(professionalId);
        const pipeline = [
          { $match: { professionalId: professionalObjectId } },
          {
            $addFields: {
              normalizedStatus: {
                $switch: {
                  branches: [
                    { case: { $eq: ["$status", "pending"] }, then: "pending" },
                    { case: { $eq: ["$status", "published"] }, then: "published" },
                    { case: { $eq: ["$status", "on_hold"] }, then: "on_hold" },
                    { case: { $eq: ["$status", "suspended"] }, then: "suspended" },
                    { case: { $eq: ["$status", "rejected"] }, then: "rejected" },
                  ],
                  default: "draft",
                },
              },
            },
          },
          { $group: { _id: "$normalizedStatus", count: { $sum: 1 } } },
        ];
        const raw = await (Project as any).aggregate(pipeline);
        const byStatus: Record<string, number> = raw.reduce(
          (acc: any, r: any) => {
            acc[r._id] = r.count;
            return acc;
          },
          {} as Record<string, number>
        );

        return {
          drafts: byStatus["draft"] || 0,
          pending: byStatus["pending"] || 0,
          published: byStatus["published"] || 0,
          on_hold: byStatus["on_hold"] || 0,
          suspended: byStatus["suspended"] || 0,
          rejected: byStatus["rejected"] || 0,
        };
      })(),
    ]);

    res.json({
      items,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
      counts,
      distinctServices: distinctServices.filter(Boolean).sort(),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch projects" });
  }
};
