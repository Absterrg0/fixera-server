//fixera-server/src/utils/scheduleEngine.ts
import mongoose from "mongoose";
import Booking from "../models/booking";
import Project from "../models/project";
import User from "../models/user";
import { DEFAULT_AVAILABILITY, resolveAvailability } from "./availabilityHelpers";
import { DateTime } from "luxon";

type DurationUnit = "hours" | "days";

type Duration = {
  value: number;
  unit: DurationUnit;
};

type ProposalWindow = {
  start: string;
  end: string;
  executionEnd: string;
};

export type ScheduleProposals = {
  mode: DurationUnit;
  earliestBookableDate: string;
  earliestProposal?: ProposalWindow;
  shortestThroughputProposal?: ProposalWindow;
  _debug?: {
    subprojectIndex?: number;
    projectId?: string;
    prepEnd: string;
    searchStart: string;
    preparationDuration: string;
    executionDuration: string;
    timeZone: string;
    useMultiResource: boolean;
    resourcePolicy: {
      minResources: number;
      totalResources: number;
      minOverlapPercentage: number;
    } | null;
    earliestBookableDateRaw: string;
    usedFallback: boolean;
  };
};

type CustomerBlocks = {
  dates?: Array<{ date: string | Date; reason?: string }>;
  windows?: Array<{
    date: string | Date;
    startTime: string;
    endTime: string;
    reason?: string;
  }>;
};

// Multi-resource availability types
type MemberBlockedData = {
  blockedDates: Set<string>;
  blockedRanges: Array<{ start: Date; end: Date; reason?: string }>;
};

type PerMemberBlockedData = Map<string, MemberBlockedData>;

export type ResourcePolicy = {
  minResources: number;
  minOverlapPercentage: number;
  totalResources: number;
};

export const DEFAULT_MIN_OVERLAP_PERCENTAGE = 90;

export const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export const PARTIAL_BLOCK_THRESHOLD_HOURS = 4;

/**
 * Safely convert string IDs to MongoDB ObjectIds, filtering out invalid IDs.
 */
const toValidObjectIds = (ids: string[]): mongoose.Types.ObjectId[] => {
  return ids
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
};

/**
 * Normalize, validate, and deduplicate resource IDs while preserving input order.
 */
const getOrderedResourceIds = (resources: any[] | undefined): string[] => {
  if (!resources || !Array.isArray(resources) || resources.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const orderedIds: string[] = [];

  for (const id of resources) {
    if (id == null) continue;

    const idStr = typeof id === "string" ? id : String(id);
    if (!mongoose.isValidObjectId(idStr)) continue;
    if (seenIds.has(idStr)) continue;

    seenIds.add(idStr);
    orderedIds.push(idStr);
  }

  return orderedIds;
};

/**
 * Validate and deduplicate resource IDs, converting to ObjectIds.
 * Handles both string IDs and existing ObjectId instances.
 * Returns validated, deduplicated ObjectIds.
 */
export const validateAndDedupeResourceIds = (
  resources: any[] | undefined
): mongoose.Types.ObjectId[] => {
  const orderedIds = getOrderedResourceIds(resources);
  return orderedIds.map((id) => new mongoose.Types.ObjectId(id));
};

/**
 * Convert a UTC Date to a "zoned" Date where UTC methods return local time values.
 * This is equivalent to date-fns-tz's toZonedTime.
 *
 * Example: If utcDate is 2024-03-15T10:00:00Z and timeZone is "America/New_York" (UTC-4),
 * the result's getUTCHours() will return 6 (the local hour in New York).
 *
 * @throws Error if the timezone is invalid or the DateTime cannot be created
 */
export const toZonedTime = (date: Date, timeZone: string): Date => {
  const dt = DateTime.fromJSDate(date, { zone: "utc" }).setZone(timeZone);
  if (!dt.isValid) {
    throw new Error(
      `toZonedTime: Invalid DateTime produced for timezone "${timeZone}". ` +
      `Reason: ${dt.invalidReason || "unknown"}, Explanation: ${dt.invalidExplanation || "none"}`
    );
  }
  // Create a new Date using the local time components as if they were UTC
  return new Date(Date.UTC(
    dt.year,
    dt.month - 1, // Luxon months are 1-indexed, Date.UTC expects 0-indexed
    dt.day,
    dt.hour,
    dt.minute,
    dt.second,
    dt.millisecond
  ));
};

/**
 * Convert a "zoned" Date (where UTC methods represent local time) back to actual UTC.
 * This is equivalent to date-fns-tz's fromZonedTime.
 *
 * Example: If zonedDate's getUTCHours() returns 6 and timeZone is "America/New_York" (UTC-4),
 * the result will be the actual UTC time: 2024-03-15T10:00:00Z.
 *
 * @throws Error if the timezone is invalid or the DateTime cannot be created
 */
export const fromZonedTime = (zonedDate: Date, timeZone: string): Date => {
  // Interpret the UTC components of zonedDate as local time in the target timezone
  const dt = DateTime.fromObject(
    {
      year: zonedDate.getUTCFullYear(),
      month: zonedDate.getUTCMonth() + 1, // Luxon months are 1-indexed
      day: zonedDate.getUTCDate(),
      hour: zonedDate.getUTCHours(),
      minute: zonedDate.getUTCMinutes(),
      second: zonedDate.getUTCSeconds(),
      millisecond: zonedDate.getUTCMilliseconds(),
    },
    { zone: timeZone }
  );
  if (!dt.isValid) {
    throw new Error(
      `fromZonedTime: Invalid DateTime produced for timezone "${timeZone}". ` +
      `Reason: ${dt.invalidReason || "unknown"}, Explanation: ${dt.invalidExplanation || "none"}`
    );
  }
  return dt.toJSDate();
};

export const startOfDayZoned = (zonedDate: Date) =>
  new Date(
    Date.UTC(
      zonedDate.getUTCFullYear(),
      zonedDate.getUTCMonth(),
      zonedDate.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

const addDaysZoned = (zonedDate: Date, days: number) => {
  const next = new Date(zonedDate.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

export const isExactMidnightUtc = (date: Date) =>
  date.getUTCHours() === 0 &&
  date.getUTCMinutes() === 0 &&
  date.getUTCSeconds() === 0 &&
  date.getUTCMilliseconds() === 0;

export const normalizeRangeEndInclusive = (rangeEnd: Date, timeZone: string) => {
  if (!isExactMidnightUtc(rangeEnd)) return rangeEnd;
  const endZoned = toZonedTime(rangeEnd, timeZone);
  const endDayStart = startOfDayZoned(endZoned);
  const endDayNextStart = addDaysZoned(endDayStart, 1);
  return fromZonedTime(endDayNextStart, timeZone);
};

const formatDateKey = (zonedDate: Date) => {
  const year = zonedDate.getUTCFullYear();
  const month = String(zonedDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(zonedDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const parseTimeToMinutes = (value?: string) => {
  if (!value) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

const formatMinutesToTime = (minutesFromMidnight: number) => {
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

const buildZonedTime = (zonedDate: Date, minutesFromMidnight: number) => {
  const base = startOfDayZoned(zonedDate);
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  base.setUTCHours(hours, minutes, 0, 0);
  return base;
};

const getWorkingHoursForDate = (
  availability: Record<string, any>,
  zonedDate: Date
) => {
  const dayKey = DAY_KEYS[zonedDate.getUTCDay()];
  const dayAvailability = availability?.[dayKey];
  if (!dayAvailability || dayAvailability.available === false) {
    return {
      available: false,
      startMinutes: null,
      endMinutes: null,
      startTime: null,
      endTime: null,
    };
  }

  const defaultDay = DEFAULT_AVAILABILITY[dayKey];
  const startTime = dayAvailability.startTime || defaultDay.startTime || "09:00";
  const endTime = dayAvailability.endTime || defaultDay.endTime || "17:00";
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);

  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return {
      available: false,
      startMinutes: null,
      endMinutes: null,
      startTime: null,
      endTime: null,
    };
  }

  return {
    available: true,
    startMinutes,
    endMinutes,
    startTime,
    endTime,
  };
};

const getPrepHoursForDate = (
  availability: Record<string, any>,
  zonedDate: Date
) => {
  const dayKey = DAY_KEYS[zonedDate.getUTCDay()];
  const dayAvailability = availability?.[dayKey] || {};
  const defaultDay = DEFAULT_AVAILABILITY[dayKey];
  const startTime = dayAvailability.startTime || defaultDay.startTime || "09:00";
  const endTime = dayAvailability.endTime || defaultDay.endTime || "17:00";
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);

  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return {
      startMinutes: null,
      endMinutes: null,
      startTime: null,
      endTime: null,
    };
  }

  return {
    startMinutes,
    endMinutes,
    startTime,
    endTime,
  };
};

export type DurationOverride = {
  execution?: { value: number; unit: 'hours' | 'days' };
  preparation?: { value: number; unit: 'hours' | 'days' };
  buffer?: { value: number; unit: 'hours' | 'days' };
};

const getProjectDurations = (project: any, subprojectIndex?: number, override?: DurationOverride) => {
  const subproject =
    typeof subprojectIndex === "number" &&
    Array.isArray(project.subprojects) &&
    project.subprojects[subprojectIndex]
      ? project.subprojects[subprojectIndex]
      : null;

  const hasValidExecutionOverride =
    override?.execution &&
    typeof override.execution.value === 'number' &&
    override.execution.value > 0 &&
    (override.execution.unit === 'hours' || override.execution.unit === 'days');
  const execution = hasValidExecutionOverride
    ? override!.execution
    : (subproject?.executionDuration || project.executionDuration);
  const isRfqPackage = subproject?.pricing?.type === "rfq";
  const executionValue =
    typeof execution?.value === "number" && execution.value > 0
      ? execution.value
      : isRfqPackage
      ? execution?.range?.max || execution?.range?.min
      : execution?.range?.min || execution?.range?.max;

  if (!isRfqPackage && (!execution || typeof executionValue !== "number" || executionValue <= 0)) {
    return null;
  }

  const rfqFallbackUnit = execution?.unit || "days";
  const resolvedValue = typeof executionValue === "number" && executionValue > 0 ? executionValue : isRfqPackage ? 1 : 0;
  if (resolvedValue <= 0) {
    return null;
  }

  const hasValidBufferOverride =
    override?.buffer &&
    typeof override.buffer.value === 'number' &&
    override.buffer.value > 0 &&
    (override.buffer.unit === 'hours' || override.buffer.unit === 'days');
  const buffer = hasValidBufferOverride
    ? override!.buffer
    : (subproject?.buffer || project.bufferDuration || null);

  const effectiveUnit = execution?.unit || rfqFallbackUnit;
  const overridePrep =
    override?.preparation &&
    typeof override.preparation.value === "number" &&
    override.preparation.value > 0 &&
    (override.preparation.unit === 'hours' || override.preparation.unit === 'days')
      ? override.preparation
      : null;
  const prepValue = overridePrep?.value ?? subproject?.preparationDuration?.value;
  const prepUnit = overridePrep?.unit || subproject?.preparationDuration?.unit || effectiveUnit;

  const preparation =
    typeof prepValue === "number"
      ? ({ value: prepValue, unit: prepUnit } as Duration)
      : null;

  return {
    execution: { value: resolvedValue, unit: effectiveUnit } as Duration,
    buffer: buffer
      ? ({ value: buffer.value, unit: buffer.unit } as Duration)
      : null,
    preparation,
  };
};

const buildHolidayChecker = (professional: any, timeZone: string) => {
  const holidayDates = new Set<string>();
  const holidayRanges: Array<{ start: Date; end: Date }> = [];

  professional?.companyBlockedDates?.forEach((blocked: any) => {
    if (!blocked?.isHoliday || !blocked?.date) return;
    const zoned = toZonedTime(new Date(blocked.date), timeZone);
    holidayDates.add(formatDateKey(zoned));
  });

  professional?.companyBlockedRanges?.forEach((range: any) => {
    if (!range?.isHoliday || !range.startDate || !range.endDate) return;
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    holidayRanges.push({ start, end });
  });

  const isHoliday = (zonedDate: Date) => {
    const key = formatDateKey(zonedDate);
    if (holidayDates.has(key)) return true;

    if (holidayRanges.length === 0) return false;
    const dayStartUtc = fromZonedTime(startOfDayZoned(zonedDate), timeZone);
    const dayEndUtc = fromZonedTime(addDaysZoned(startOfDayZoned(zonedDate), 1), timeZone);

    return holidayRanges.some((range) => {
      const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
      return rangeEnd > dayStartUtc && range.start < dayEndUtc;
    });
  };

  return { isHoliday };
};

const buildBlockedData = async (
  project: any,
  professional: any,
  timeZone: string,
  customerBlocks?: CustomerBlocks,
  excludeBookingId?: string
) => {
  const blockedDates = new Set<string>();
  const blockedRanges: Array<{ start: Date; end: Date; reason?: string }> = [];

  professional?.companyBlockedDates?.forEach((blocked: any) => {
    if (!blocked?.date) return;
    const zoned = toZonedTime(new Date(blocked.date), timeZone);
    blockedDates.add(formatDateKey(zoned));
  });

  professional?.companyBlockedRanges?.forEach((range: any) => {
    if (!range?.startDate || !range?.endDate) return;
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    blockedRanges.push({ start, end, reason: range.reason });
  });

  const teamMemberIds = getOrderedResourceIds(project.resources);
  if (teamMemberIds.length > 0) {
    const teamMembers = await User.find({
      _id: { $in: teamMemberIds },
    }).select("blockedDates blockedRanges");

    teamMembers.forEach((member) => {
      member.blockedDates?.forEach((blocked: any) => {
        if (!blocked?.date) return;
        const zoned = toZonedTime(new Date(blocked.date), timeZone);
        blockedDates.add(formatDateKey(zoned));
      });

      member.blockedRanges?.forEach((range: any) => {
        if (!range?.startDate || !range?.endDate) return;
        const start = new Date(range.startDate);
        const end = new Date(range.endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
        blockedRanges.push({ start, end, reason: range.reason });
      });
    });
  }

  const bookingFilter: any = {
    status: { $nin: ["completed", "cancelled", "refunded"] },
    scheduledStartDate: { $exists: true, $ne: null },
    $or: [{ project: project._id }],
    $and: [
      {
        $or: [
          { scheduledBufferEndDate: { $exists: true, $ne: null } },
          { scheduledExecutionEndDate: { $exists: true, $ne: null } },
        ],
      },
    ],
  };

  if (excludeBookingId && mongoose.isValidObjectId(excludeBookingId)) {
    bookingFilter._id = { $ne: new mongoose.Types.ObjectId(excludeBookingId) };
  }

  if (teamMemberIds.length > 0) {
    // Convert string IDs to ObjectIds for proper MongoDB matching (filtering invalid IDs)
    const teamMemberObjectIds = toValidObjectIds(teamMemberIds);
    if (teamMemberObjectIds.length > 0) {
      bookingFilter.$or.push(
        { assignedTeamMembers: { $in: teamMemberObjectIds } },
        { professional: { $in: teamMemberObjectIds } }
      );
    }
  }

  const bookings = await Booking.find(bookingFilter).select(
    "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit status"
  );

  bookings.forEach((booking) => {
    // Block the execution period
    if (booking.scheduledStartDate && booking.scheduledExecutionEndDate) {
      blockedRanges.push({
        start: new Date(booking.scheduledStartDate),
        end: new Date(booking.scheduledExecutionEndDate),
        reason: "booking",
      });
    }
    // Block the buffer period (if exists)
    if (booking.scheduledBufferStartDate && booking.scheduledBufferEndDate && booking.scheduledExecutionEndDate) {
      blockedRanges.push({
        start: new Date(booking.scheduledBufferStartDate),
        end: new Date(booking.scheduledBufferEndDate),
        reason: "booking-buffer",
      });
    }
  });

  if (customerBlocks?.dates) {
    customerBlocks.dates.forEach((blocked) => {
      if (!blocked?.date) return;
      const zoned = toZonedTime(new Date(blocked.date), timeZone);
      blockedDates.add(formatDateKey(zoned));
    });
  }

  if (customerBlocks?.windows) {
    customerBlocks.windows.forEach((window) => {
      if (!window?.date) return;
      const startMinutes = parseTimeToMinutes(window.startTime);
      const endMinutes = parseTimeToMinutes(window.endTime);
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        return;
      }

      const zonedDay = toZonedTime(new Date(window.date), timeZone);
      const dayStart = startOfDayZoned(zonedDay);
      const startZoned = buildZonedTime(dayStart, startMinutes);
      const endZoned = buildZonedTime(dayStart, endMinutes);
      blockedRanges.push({
        start: fromZonedTime(startZoned, timeZone),
        end: fromZonedTime(endZoned, timeZone),
        reason: "customer-block",
      });
    });
  }

  return { blockedDates, blockedRanges };
};

/**
 * Collect company-level blocked dates and ranges, including customer blocks.
 * These blocks apply to all team members.
 */
const collectCompanyBlocks = (
  professional: any,
  timeZone: string,
  customerBlocks?: CustomerBlocks
): {
  companyBlockedDates: Set<string>;
  companyBlockedRanges: Array<{ start: Date; end: Date; reason?: string }>;
} => {
  const companyBlockedDates = new Set<string>();
  const companyBlockedRanges: Array<{ start: Date; end: Date; reason?: string }> = [];

  // Add professional's company-level blocked dates
  professional?.companyBlockedDates?.forEach((blocked: any) => {
    if (!blocked?.date) return;
    const zoned = toZonedTime(new Date(blocked.date), timeZone);
    companyBlockedDates.add(formatDateKey(zoned));
  });

  // Add professional's company-level blocked ranges
  professional?.companyBlockedRanges?.forEach((range: any) => {
    if (!range?.startDate || !range?.endDate) return;
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    companyBlockedRanges.push({ start, end, reason: range.reason });
  });

  // Add customer blocked dates (applies to all members)
  if (customerBlocks?.dates) {
    customerBlocks.dates.forEach((blocked) => {
      if (!blocked?.date) return;
      const zoned = toZonedTime(new Date(blocked.date), timeZone);
      companyBlockedDates.add(formatDateKey(zoned));
    });
  }

  // Add customer blocked windows as ranges (applies to all members)
  if (customerBlocks?.windows) {
    customerBlocks.windows.forEach((window) => {
      if (!window?.date) return;
      const startMinutes = parseTimeToMinutes(window.startTime);
      const endMinutes = parseTimeToMinutes(window.endTime);
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        return;
      }
      const zonedDay = toZonedTime(new Date(window.date), timeZone);
      const dayStart = startOfDayZoned(zonedDay);
      const startZoned = buildZonedTime(dayStart, startMinutes);
      const endZoned = buildZonedTime(dayStart, endMinutes);
      companyBlockedRanges.push({
        start: fromZonedTime(startZoned, timeZone),
        end: fromZonedTime(endZoned, timeZone),
        reason: "customer-block",
      });
    });
  }

  return { companyBlockedDates, companyBlockedRanges };
};

/**
 * Fetch team members from database and build their personal blocked data.
 * Each member inherits company blocks and adds their own personal blocks.
 */
const collectTeamMemberBlocks = async (
  teamMemberIds: string[],
  companyBlockedDates: Set<string>,
  companyBlockedRanges: Array<{ start: Date; end: Date; reason?: string }>,
  timeZone: string
): Promise<Map<string, MemberBlockedData>> => {
  const memberBlocksMap = new Map<string, MemberBlockedData>();

  if (teamMemberIds.length === 0) {
    return memberBlocksMap;
  }

  const teamMembers = await User.find({ _id: { $in: teamMemberIds } }).select(
    "blockedDates blockedRanges"
  );

  teamMembers.forEach((member: any) => {
    const memberId = member._id.toString();
    const blockedDates = new Set<string>(companyBlockedDates);
    const blockedRanges = [...companyBlockedRanges];

    // Add member's personal blocked dates
    member.blockedDates?.forEach((blocked: any) => {
      if (!blocked?.date) return;
      const zoned = toZonedTime(new Date(blocked.date), timeZone);
      blockedDates.add(formatDateKey(zoned));
    });

    // Add member's personal blocked ranges
    member.blockedRanges?.forEach((range: any) => {
      if (!range?.startDate || !range?.endDate) return;
      const start = new Date(range.startDate);
      const end = new Date(range.endDate);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
      blockedRanges.push({ start, end, reason: range.reason });
    });

    memberBlocksMap.set(memberId, { blockedDates, blockedRanges });
  });

  return memberBlocksMap;
};

/**
 * Process bookings and assign blocked periods to affected team members.
 * Updates memberBlocksMap in place with booking-related blocks.
 */
const assignBookingBlocks = (
  bookings: any[],
  teamMemberIdsSet: Set<string>,
  projectId: any,
  memberBlocksMap: Map<string, MemberBlockedData>,
  companyBlockedDates: Set<string>,
  companyBlockedRanges: Array<{ start: Date; end: Date; reason?: string }>,
  teamMemberIds: string[]
): void => {
  bookings.forEach((booking) => {
    // Determine which team members are affected by this booking
    const affectedMembers = new Set<string>();

    const hasAssignedMembers =
      booking.assignedTeamMembers && booking.assignedTeamMembers.length > 0;

    // If booking has assignedTeamMembers, use those
    if (hasAssignedMembers) {
      booking.assignedTeamMembers.forEach((memberId: any) => {
        const id = memberId.toString();
        if (teamMemberIdsSet.has(id)) {
          affectedMembers.add(id);
        }
      });
    } else {
      // Legacy bookings without assignedTeamMembers: fall back to professional/project data
      if (booking.professional) {
        const profId = booking.professional.toString();
        if (teamMemberIdsSet.has(profId)) {
          affectedMembers.add(profId);
        }
      }

      // If booking is for this project, assume all team members were involved (legacy)
      if (booking.project?.toString() === projectId?.toString()) {
        teamMemberIds.forEach((id) => affectedMembers.add(id));
      }
    }

    // Add blocks only to affected members
    affectedMembers.forEach((memberId) => {
      let memberData = memberBlocksMap.get(memberId);
      if (!memberData) {
        memberData = {
          blockedDates: new Set<string>(companyBlockedDates),
          blockedRanges: [...companyBlockedRanges],
        };
        memberBlocksMap.set(memberId, memberData);
      }

      // Block the execution period
      if (booking.scheduledStartDate && booking.scheduledExecutionEndDate) {
        memberData.blockedRanges.push({
          start: new Date(booking.scheduledStartDate),
          end: new Date(booking.scheduledExecutionEndDate),
          reason: "booking",
        });
      }

      // Block the buffer period (if exists)
      if (booking.scheduledBufferStartDate && booking.scheduledBufferEndDate && booking.scheduledExecutionEndDate) {
        memberData.blockedRanges.push({
          start: new Date(booking.scheduledBufferStartDate),
          end: new Date(booking.scheduledBufferEndDate),
          reason: "booking-buffer",
        });
      }
    });
  });
};

/**
 * Build blocked data per individual team member for multi-resource availability.
 * Returns a Map keyed by member ID with each member's blocked dates and ranges.
 * Composes collectCompanyBlocks, collectTeamMemberBlocks, and assignBookingBlocks.
 */
const buildPerMemberBlockedData = async (
  project: any,
  professional: any,
  timeZone: string,
  customerBlocks?: CustomerBlocks,
  excludeBookingId?: string
): Promise<PerMemberBlockedData> => {
  const perMemberData: PerMemberBlockedData = new Map();

  // Normalize all resource IDs to strings up-front using a Set for O(1) lookups
  const teamMemberIds = getOrderedResourceIds(project.resources);
  const teamMemberIdsSet = new Set<string>(teamMemberIds);

  // Step 1: Collect company-level blocks (including customer blocks)
  const { companyBlockedDates, companyBlockedRanges } = collectCompanyBlocks(
    professional,
    timeZone,
    customerBlocks
  );

  // Step 2: Collect team member personal blocks
  const memberBlocksMap = await collectTeamMemberBlocks(
    teamMemberIds,
    companyBlockedDates,
    companyBlockedRanges,
    timeZone
  );

  // Step 3: Fetch and process bookings
  const teamMemberObjectIds = toValidObjectIds(teamMemberIds);
  const bookingFilter: any = {
    status: { $nin: ["completed", "cancelled", "refunded"] },
    scheduledStartDate: { $exists: true, $ne: null },
    $or: [{ project: project._id }],
    $and: [
      {
        $or: [
          { scheduledBufferEndDate: { $exists: true, $ne: null } },
          { scheduledExecutionEndDate: { $exists: true, $ne: null } },
        ],
      },
    ],
  };

  if (excludeBookingId && mongoose.isValidObjectId(excludeBookingId)) {
    bookingFilter._id = { $ne: new mongoose.Types.ObjectId(excludeBookingId) };
  }

  // Only add team member filters if we have valid ObjectIds
  if (teamMemberObjectIds.length > 0) {
    bookingFilter.$or.push(
      { assignedTeamMembers: { $in: teamMemberObjectIds } },
      { professional: { $in: teamMemberObjectIds } }
    );
  }

  const bookings = await Booking.find(bookingFilter).select(
    "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit assignedTeamMembers professional project status"
  );

  // Step 4: Assign booking blocks to affected members
  assignBookingBlocks(
    bookings,
    teamMemberIdsSet,
    project._id,
    memberBlocksMap,
    companyBlockedDates,
    companyBlockedRanges,
    teamMemberIds
  );

  // Step 5: Ensure all team members have entries and populate perMemberData
  teamMemberIds.forEach((memberId) => {
    if (!memberBlocksMap.has(memberId)) {
      memberBlocksMap.set(memberId, {
        blockedDates: new Set<string>(companyBlockedDates),
        blockedRanges: [...companyBlockedRanges],
      });
    }
    perMemberData.set(memberId, memberBlocksMap.get(memberId)!);
  });

  return perMemberData;
};

/**
 * Check if a specific member is blocked on a given day.
 */
const isMemberDayBlocked = (
  memberData: MemberBlockedData,
  availability: Record<string, any>,
  zonedDate: Date,
  timeZone: string
): boolean => {
  const dateKey = formatDateKey(zonedDate);
  if (memberData.blockedDates.has(dateKey)) return true;
  if (!isWorkingDay(availability, zonedDate)) return true;

  const workingRange = getWorkingRangeUtc(availability, zonedDate, timeZone);
  if (!workingRange) return true;

  const dayStartUtc = fromZonedTime(startOfDayZoned(zonedDate), timeZone);
  const dayEndUtc = fromZonedTime(addDaysZoned(startOfDayZoned(zonedDate), 1), timeZone);

  const intervals = memberData.blockedRanges
    .map((range) => {
      const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
      if (rangeEnd <= dayStartUtc || range.start >= dayEndUtc) {
        return null;
      }
      const start = range.start > dayStartUtc ? range.start : dayStartUtc;
      const end = rangeEnd < dayEndUtc ? rangeEnd : dayEndUtc;
      return { start, end };
    })
    .filter(Boolean) as Array<{ start: Date; end: Date }>;

  if (intervals.length === 0) return false;

  const clamped = intervals
    .map((interval) => {
      const start = Math.max(interval.start.getTime(), workingRange.startUtc.getTime());
      const end = Math.min(interval.end.getTime(), workingRange.endUtc.getTime());
      return { start, end };
    })
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  if (clamped.length === 0) return false;

  let totalMinutes = 0;
  let currentStart = clamped[0].start;
  let currentEnd = clamped[0].end;

  for (let i = 1; i < clamped.length; i++) {
    const interval = clamped[i];
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      totalMinutes += (currentEnd - currentStart) / (1000 * 60);
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }

  totalMinutes += (currentEnd - currentStart) / (1000 * 60);
  return totalMinutes / 60 >= PARTIAL_BLOCK_THRESHOLD_HOURS;
};

/**
 * Count how many resources are available for a given day.
 */
const countAvailableResourcesForDay = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  zonedDate: Date,
  timeZone: string
): number => {
  let count = 0;
  perMemberBlocked.forEach((memberData) => {
    if (!isMemberDayBlocked(memberData, availability, zonedDate, timeZone)) {
      count++;
    }
  });
  return count;
};

/**
 * Check if a time range overlaps with any blocked ranges for a member.
 */
const memberTimeOverlapsRanges = (
  memberData: MemberBlockedData,
  startUtc: Date,
  endUtc: Date,
  timeZone: string
): boolean => {
  return memberData.blockedRanges.some((range) => {
    const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
    return startUtc < rangeEnd && endUtc > range.start;
  });
};

/**
 * Count how many resources are available during a specific time window (hours mode).
 */
const countAvailableResourcesForWindow = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startUtc: Date,
  endUtc: Date,
  timeZone: string
): number => {
  let count = 0;
  const startZoned = toZonedTime(startUtc, timeZone);

  perMemberBlocked.forEach((memberData) => {
    // Check if it's a working day
    if (!isWorkingDay(availability, startZoned)) return;

    // Check if date is blocked
    const dateKey = formatDateKey(startZoned);
    if (memberData.blockedDates.has(dateKey)) return;

    // Check if window overlaps with blocked ranges
    if (!memberTimeOverlapsRanges(memberData, startUtc, endUtc, timeZone)) {
      count++;
    }
  });

  return count;
};

/**
 * Check if a specific member is available during a time window.
 */
const isMemberAvailableForWindow = (
  memberData: MemberBlockedData | undefined,
  availability: Record<string, any>,
  startUtc: Date,
  endUtc: Date,
  timeZone: string
): boolean => {
  if (!memberData) return false;
  const startZoned = toZonedTime(startUtc, timeZone);

  if (!isWorkingDay(availability, startZoned)) return false;

  const dateKey = formatDateKey(startZoned);
  if (memberData.blockedDates.has(dateKey)) return false;

  return !memberTimeOverlapsRanges(memberData, startUtc, endUtc, timeZone);
};

type DaysOverlapResult = {
  overlapPercentage: number;
  canComplete: boolean;
};

/**
 * Compute overlap percentage for days mode with an optional throughput cap.
 * Overlap is measured against required execution days. Completion is only
 * possible if enough fully-available days are found within the evaluated window.
 * When no cap is provided, we evaluate up to a generous safety ceiling.
 */
const computeDaysOverlapPercentage = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startZoned: Date,
  executionDays: number,
  memberIds: string[],
  timeZone: string,
  maxThroughputDays?: number
): DaysOverlapResult => {
  if (executionDays <= 0) {
    return { overlapPercentage: 100, canComplete: true };
  }

  let availableDays = 0;
  let workingDays = 0;
  let cursor = startZoned;
  const workingDayCap =
    typeof maxThroughputDays === 'number'
      ? Math.max(executionDays, maxThroughputDays)
      : Number.POSITIVE_INFINITY;
  const maxIterations = 366 * 5; // Guard against infinite loops without capping throughput
  let iterations = 0;

  while (
    iterations < maxIterations &&
    availableDays < executionDays &&
    workingDays < workingDayCap
  ) {
    iterations++;
    if (isWorkingDay(availability, cursor)) {
      workingDays++;
      const allAvailable = memberIds.every((memberId) => {
        const memberData = perMemberBlocked.get(memberId);
        return memberData
          ? !isMemberDayBlocked(memberData, availability, cursor, timeZone)
          : false;
      });
      if (allAvailable) {
        availableDays++;
      }
    }
    cursor = addDaysZoned(cursor, 1);
  }

  return {
    overlapPercentage: (availableDays / executionDays) * 100,
    canComplete: availableDays >= executionDays,
  };
};

/**
 * Compute overlap percentage for hours mode.
 * Returns the percentage of execution time where all members in the subset are available.
 * Samples at 30-minute intervals for efficiency.
 */
const computeHoursOverlapPercentage = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startUtc: Date,
  endUtc: Date,
  memberIds: string[],
  timeZone: string
): number => {
  const totalMinutes = (endUtc.getTime() - startUtc.getTime()) / (1000 * 60);
  if (totalMinutes <= 0) return 100;

  const sampleInterval = 30; // Sample every 30 minutes
  const totalSamples = Math.max(1, Math.ceil(totalMinutes / sampleInterval));
  let availableSamples = 0;

  for (let i = 0; i < totalSamples; i++) {
    const sampleTime = new Date(startUtc.getTime() + i * sampleInterval * 60 * 1000);
    // Ensure sampleTime doesn't exceed endUtc
    if (sampleTime.getTime() >= endUtc.getTime()) {
      break;
    }
    // Clamp sampleEnd to not exceed endUtc
    const sampleEnd = new Date(
      Math.min(sampleTime.getTime() + sampleInterval * 60 * 1000, endUtc.getTime())
    );

    const allAvailable = memberIds.every((memberId) =>
      isMemberAvailableForWindow(
        perMemberBlocked.get(memberId),
        availability,
        sampleTime,
        sampleEnd,
        timeZone
      )
    );

    if (allAvailable) {
      availableSamples++;
    }
  }

  return (availableSamples / totalSamples) * 100;
};

const getRequiredOverlapPercentage = (resourcePolicy: ResourcePolicy): number =>
  resourcePolicy.minResources <= 1 ? 100 : resourcePolicy.minOverlapPercentage;

const binomial = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  if (k > n - k) k = n - k;

  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
    if (result > Number.MAX_SAFE_INTEGER) return Infinity;
  }
  return Math.round(result);
};

const DEFAULT_MAX_COMBINATIONS = 10000;

const forEachSubset = (
  resourceIds: string[],
  subsetSize: number,
  callback: (subset: string[]) => boolean,
  maxIterations: number = DEFAULT_MAX_COMBINATIONS
): boolean => {
  if (subsetSize <= 0 || resourceIds.length < subsetSize) {
    return false;
  }

  const totalCombinations = binomial(resourceIds.length, subsetSize);
  if (totalCombinations > maxIterations) {
    console.warn(
      `forEachSubset: combination count (${totalCombinations}) exceeds maxIterations (${maxIterations}). ` +
        `Aborting enumeration to prevent combinatorial explosion.`
    );
    return false;
  }

  const subset: string[] = [];
  const maxStart = resourceIds.length;
  let iterationCount = 0;

  const walk = (startIndex: number): boolean => {
    if (subset.length === subsetSize) {
      iterationCount++;
      if (iterationCount > maxIterations) {
        return false;
      }
      return callback([...subset]);
    }

    const remainingNeeded = subsetSize - subset.length;
    for (let i = startIndex; i <= maxStart - remainingNeeded; i++) {
      subset.push(resourceIds[i]);
      if (walk(i + 1)) {
        return true;
      }
      subset.pop();
    }

    return false;
  };

  return walk(0);
};

const findFirstEligibleSubsetForDays = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startZoned: Date,
  executionDays: number,
  resourcePolicy: ResourcePolicy,
  resourceIds: string[],
  timeZone: string
): string[] | null => {
  const requiredOverlap = getRequiredOverlapPercentage(resourcePolicy);
  let selectedSubset: string[] | null = null;

  forEachSubset(resourceIds, resourcePolicy.minResources, (subset) => {
    const { overlapPercentage, canComplete } = computeDaysOverlapPercentage(
      perMemberBlocked,
      availability,
      startZoned,
      executionDays,
      subset,
      timeZone
    );

    if (canComplete && overlapPercentage >= requiredOverlap) {
      selectedSubset = subset;
      return true;
    }

    return false;
  });

  return selectedSubset;
};

const findFirstEligibleSubsetForHours = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startUtc: Date,
  endUtc: Date,
  resourcePolicy: ResourcePolicy,
  resourceIds: string[],
  timeZone: string,
  bufferStartUtc?: Date,
  bufferEndUtc?: Date
): string[] | null => {
  const requiredOverlap = getRequiredOverlapPercentage(resourcePolicy);
  let selectedSubset: string[] | null = null;

  forEachSubset(resourceIds, resourcePolicy.minResources, (subset) => {
    const overlapPercentage = computeHoursOverlapPercentage(
      perMemberBlocked,
      availability,
      startUtc,
      endUtc,
      subset,
      timeZone
    );

    if (overlapPercentage >= requiredOverlap) {
      if (bufferStartUtc && bufferEndUtc) {
        if (
          !isSubsetClearOfRanges(
            perMemberBlocked,
            subset,
            bufferStartUtc,
            bufferEndUtc,
            timeZone
          )
        ) {
          return false;
        }
      }

      selectedSubset = subset;
      return true;
    }

    return false;
  });

  return selectedSubset;
};

const computeBestOverlapPercentageForDays = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startZoned: Date,
  executionDays: number,
  resourcePolicy: ResourcePolicy,
  resourceIds: string[],
  timeZone: string
): number => {
  let bestOverlap = 0;

  forEachSubset(resourceIds, resourcePolicy.minResources, (subset) => {
    const { overlapPercentage } = computeDaysOverlapPercentage(
      perMemberBlocked,
      availability,
      startZoned,
      executionDays,
      subset,
      timeZone
    );
    if (overlapPercentage > bestOverlap) {
      bestOverlap = overlapPercentage;
    }
    return false;
  });

  return bestOverlap;
};

const isSubsetClearOfRanges = (
  perMemberBlocked: PerMemberBlockedData,
  subset: string[],
  startUtc: Date,
  endUtc: Date,
  timeZone: string
): boolean => {
  return subset.every((memberId) => {
    const memberData = perMemberBlocked.get(memberId);
    if (!memberData) return false;
    return !memberTimeOverlapsRanges(memberData, startUtc, endUtc, timeZone);
  });
};

/**
 * Get resource policy from project with defaults applied.
 * totalResources is the count of validated resources in the project.
 */
export const getResourcePolicy = (project: any): ResourcePolicy => {
  const totalResources = getOrderedResourceIds(project.resources).length;
  const minResources = Math.min(
    Math.max(project.minResources || 1, 1),
    totalResources || 1
  );
  const minOverlapPercentage = Math.min(
    Math.max(project.minOverlapPercentage ?? DEFAULT_MIN_OVERLAP_PERCENTAGE, 10),
    100
  );

  return { minResources, minOverlapPercentage, totalResources };
};

/**
 * Check if resource-based availability should be used (any resources present).
 */
const isMultiResourceMode = (project: any): boolean => {
  const { totalResources } = getResourcePolicy(project);
  return totalResources > 0;
};

const loadProjectAndProfessional = async (projectId: string) => {
  const project = await Project.findOne({
    _id: projectId,
    status: "published",
  }).lean();

  if (!project) {
    return { project: null, professional: null };
  }

  const professional = await User.findById(project.professionalId).select(
    "companyAvailability availability companyBlockedDates companyBlockedRanges businessInfo.timezone"
  );

  return { project, professional: professional || null };
};

export const getWorkingRangeUtc = (
  availability: Record<string, any>,
  zonedDate: Date,
  timeZone: string
) => {
  const hours = getWorkingHoursForDate(availability, zonedDate);
  if (!hours.available || hours.startMinutes === null || hours.endMinutes === null) {
    return null;
  }

  const startZoned = buildZonedTime(zonedDate, hours.startMinutes);
  const endZoned = buildZonedTime(zonedDate, hours.endMinutes);
  const startUtc = fromZonedTime(startZoned, timeZone);
  const endUtc = fromZonedTime(endZoned, timeZone);
  if (endUtc <= startUtc) return null;
  return { startUtc, endUtc };
};

const isWorkingDay = (availability: Record<string, any>, zonedDate: Date) => {
  const hours = getWorkingHoursForDate(availability, zonedDate);
  return hours.available;
};

/**
 * Check if a day is blocked (strict intersection mode - all resources must be free).
 * This is the original behavior when minResources <= 1.
 */
const isDayBlocked = (
  availability: Record<string, any>,
  zonedDate: Date,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => {
  const dateKey = formatDateKey(zonedDate);
  if (blockedDates.has(dateKey)) return true;
  if (!isWorkingDay(availability, zonedDate)) return true;

  const workingRange = getWorkingRangeUtc(availability, zonedDate, timeZone);
  if (!workingRange) return true;

  const dayStartUtc = fromZonedTime(startOfDayZoned(zonedDate), timeZone);
  const dayEndUtc = fromZonedTime(addDaysZoned(startOfDayZoned(zonedDate), 1), timeZone);

  const intervals = blockedRanges
    .map((range) => {
      const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
      if (rangeEnd <= dayStartUtc || range.start >= dayEndUtc) {
        return null;
      }
      const start = range.start > dayStartUtc ? range.start : dayStartUtc;
      const end = rangeEnd < dayEndUtc ? rangeEnd : dayEndUtc;
      return { start, end };
    })
    .filter(Boolean) as Array<{ start: Date; end: Date }>;

  if (intervals.length === 0) return false;

  const clamped = intervals
    .map((interval) => {
      const start = Math.max(interval.start.getTime(), workingRange.startUtc.getTime());
      const end = Math.min(interval.end.getTime(), workingRange.endUtc.getTime());
      return { start, end };
    })
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  if (clamped.length === 0) return false;

  let totalMinutes = 0;
  let currentStart = clamped[0].start;
  let currentEnd = clamped[0].end;

  for (let i = 1; i < clamped.length; i++) {
    const interval = clamped[i];
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      totalMinutes += (currentEnd - currentStart) / (1000 * 60);
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }

  totalMinutes += (currentEnd - currentStart) / (1000 * 60);

  return totalMinutes / 60 >= PARTIAL_BLOCK_THRESHOLD_HOURS;
};

/**
 * Check if a day is blocked in multi-resource mode.
 * A day is blocked if fewer than minResources are available.
 */
const isDayBlockedMultiResource = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  zonedDate: Date,
  minResources: number,
  timeZone: string
): boolean => {
  if (!isWorkingDay(availability, zonedDate)) return true;

  const availableCount = countAvailableResourcesForDay(
    perMemberBlocked,
    availability,
    zonedDate,
    timeZone
  );

  return availableCount < minResources;
};

/**
 * Unified day blocked check that uses multi-resource mode when applicable.
 */
const isDayBlockedWithPolicy = (
  availability: Record<string, any>,
  zonedDate: Date,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string,
  perMemberBlocked?: PerMemberBlockedData,
  resourcePolicy?: ResourcePolicy
): boolean => {
  // Use multi-resource mode if applicable
  if (
    perMemberBlocked &&
    resourcePolicy &&
    resourcePolicy.totalResources > 0
  ) {
    return isDayBlockedMultiResource(
      perMemberBlocked,
      availability,
      zonedDate,
      resourcePolicy.minResources,
      timeZone
    );
  }

  // Fall back to strict intersection mode
  return isDayBlocked(availability, zonedDate, blockedDates, blockedRanges, timeZone);
};

/**
 * Count how many members from a specific subset are available on a given day.
 */
const countAvailableSubsetMembersForDay = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  zonedDate: Date,
  timeZone: string,
  subset: string[]
): number => {
  let count = 0;
  for (const memberId of subset) {
    const memberData = perMemberBlocked.get(memberId);
    if (memberData && !isMemberDayBlocked(memberData, availability, zonedDate, timeZone)) {
      count++;
    }
  }
  return count;
};

const advanceWorkingDays = (
  startDate: Date,
  workingDays: number,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string,
  // Optional multi-resource parameters
  perMemberBlocked?: PerMemberBlockedData,
  resourcePolicy?: ResourcePolicy,
  // Optional: the selected subset of resources for this execution
  selectedSubset?: string[]
) => {
  if (workingDays <= 0) {
    return startDate;
  }

  let cursor = startDate;
  let counted = 0;
  const maxIterations = 366 * 2; // Guard against infinite loops
  let iterations = 0;

  // Calculate allowed solo days based on overlap percentage
  // For example: 75% overlap with 5 days = ceil(5 * 0.75) = 4 overlap days, 1 solo day allowed
  // Solo days are days where at least 1 resource can work alone (not all minResources available)
  let allowedSoloDays = 0;
  let soloDaysUsed = 0;
  const minResources = resourcePolicy?.minResources ?? 1;

  if (
    perMemberBlocked &&
    resourcePolicy &&
    resourcePolicy.totalResources > 0 &&
    selectedSubset &&
    selectedSubset.length > 0 &&
    resourcePolicy.minOverlapPercentage < 100
  ) {
    // Calculate: requiredOverlapDays = ceil(workingDays * overlapPercentage / 100)
    // allowedSoloDays = workingDays - requiredOverlapDays
    const requiredOverlapDays = Math.ceil(
      workingDays * resourcePolicy.minOverlapPercentage / 100
    );
    allowedSoloDays = Math.max(0, workingDays - requiredOverlapDays);

    console.log('[ADVANCE_WORKING_DAYS] Solo day calculation:', {
      workingDays,
      overlapPercentage: resourcePolicy.minOverlapPercentage,
      requiredOverlapDays,
      allowedSoloDays,
      subsetSize: selectedSubset.length,
      minResources,
    });
  }

  while (counted < workingDays && iterations < maxIterations) {
    iterations++;

    let dayIsBlocked = false;
    let isSoloDay = false;

    if (
      perMemberBlocked &&
      resourcePolicy &&
      resourcePolicy.totalResources > 0 &&
      selectedSubset &&
      selectedSubset.length > 0
    ) {
      // Multi-resource mode with subset: check availability against the selected subset
      if (!isWorkingDay(availability, cursor)) {
        dayIsBlocked = true;
      } else {
        const availableInSubset = countAvailableSubsetMembersForDay(
          perMemberBlocked,
          availability,
          cursor,
          timeZone,
          selectedSubset
        );

        if (availableInSubset >= minResources) {
          // Full overlap day - all required resources available
          dayIsBlocked = false;
        } else if (availableInSubset >= 1 && soloDaysUsed < allowedSoloDays) {
          // Solo day - at least 1 resource available and we have budget for solo days
          dayIsBlocked = false;
          isSoloDay = true;
        } else {
          // Not enough resources and no solo day budget remaining
          dayIsBlocked = true;
        }
      }
    } else if (perMemberBlocked && resourcePolicy && resourcePolicy.totalResources > 0) {
      // Multi-resource mode without subset: use original logic (minResources check)
      dayIsBlocked = isDayBlockedMultiResource(
        perMemberBlocked,
        availability,
        cursor,
        minResources,
        timeZone
      );
    } else {
      // Single resource mode: use simple block check
      dayIsBlocked = isDayBlocked(availability, cursor, blockedDates, blockedRanges, timeZone);
    }

    if (!dayIsBlocked) {
      counted += 1;
      if (isSoloDay) {
        soloDaysUsed += 1;
      }
      if (counted >= workingDays) {
        if (allowedSoloDays > 0) {
          console.log('[ADVANCE_WORKING_DAYS] Final result:', {
            startDate: formatDateKey(startDate),
            endDate: formatDateKey(cursor),
            totalDaysCounted: counted,
            soloDaysUsed,
            allowedSoloDays,
          });
        }
        return cursor;
      }
    }
    cursor = addDaysZoned(cursor, 1);
  }

  return cursor;
};

/**
 * Count working days between two dates (inclusive) for throughput calculation.
 * Counts all days that are working days based on availability schedule (e.g., Mon-Fri).
 * Does NOT skip blocked days - blocked days still count as time passing (throughput).
 * Only skips weekends and non-working days based on the professional's availability.
 */
const countWorkingDaysBetween = (
  startDate: Date,
  endDate: Date,
  availability: Record<string, any>,
): number => {
  let cursor = startDate;
  let count = 0;
  const maxIterations = 366 * 2; // Guard against infinite loops
  let iterations = 0;

  while (cursor <= endDate && iterations < maxIterations) {
    iterations++;
    // Only check if it's a working day (Mon-Fri based on availability), not if it's blocked
    if (isWorkingDay(availability, cursor)) {
      count++;
    }
    cursor = addDaysZoned(cursor, 1);
  }

  return count;
};

const calculatePrepEnd = (
  preparation: Duration | null,
  availability: Record<string, any>,
  timeZone: string,
  isHoliday: (date: Date) => boolean
) => {
  const zonedNow = toZonedTime(new Date(), timeZone);

  if (!preparation || !preparation.value || preparation.value <= 0) {
    return zonedNow;
  }

  const isWeekend = (date: Date) => {
    const day = date.getUTCDay();
    return day === 0 || day === 6;
  };

  const isPrepWorkingDay = (date: Date) => {
    if (isWeekend(date)) return false;
    if (isHoliday(date)) return false;
    return true;
  };

  if (preparation.unit === "days") {
    let cursor = startOfDayZoned(zonedNow);
    let nowMinutes = zonedNow.getUTCHours() * 60 + zonedNow.getUTCMinutes();
    const todayHours = getPrepHoursForDate(availability, cursor);

    if (!isPrepWorkingDay(cursor)) {
      cursor = addDaysZoned(cursor, 1);
      nowMinutes = 0;
    } else if (todayHours.endMinutes === null) {
      cursor = addDaysZoned(cursor, 1);
      nowMinutes = 0;
    } else if (nowMinutes >= todayHours.endMinutes) {
      cursor = addDaysZoned(cursor, 1);
      nowMinutes = 0;
    }

    let counted = 0;
    let lastPrepDay = cursor;
    const maxIterations = 366 * 2; // Guard against infinite loops (2 years of days)
    let iterations = 0;

    while (counted < preparation.value && iterations < maxIterations) {
      iterations += 1;
      if (isPrepWorkingDay(cursor)) {
        counted += 1;
        lastPrepDay = cursor;
      }
      cursor = addDaysZoned(cursor, 1);
    }

    return addDaysZoned(startOfDayZoned(lastPrepDay), 1);
  }

  let remainingMinutes = preparation.value * 60;
  let cursor = zonedNow;
  const maxIterations = 366 * 2; // Guard against infinite loops
  let iterations = 0;

  while (remainingMinutes > 0 && iterations < maxIterations) {
    iterations += 1;
    const dayStart = startOfDayZoned(cursor);
    if (!isPrepWorkingDay(dayStart)) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const hours = getPrepHoursForDate(availability, dayStart);
    if (hours.startMinutes === null || hours.endMinutes === null) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    let currentMinutes =
      cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
    if (currentMinutes < hours.startMinutes) {
      currentMinutes = hours.startMinutes;
    }
    if (currentMinutes >= hours.endMinutes) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const availableMinutes = hours.endMinutes - currentMinutes;
    if (remainingMinutes <= availableMinutes) {
      return buildZonedTime(dayStart, currentMinutes + remainingMinutes);
    }

    remainingMinutes -= availableMinutes;
    cursor = addDaysZoned(dayStart, 1);
  }

  return cursor;
};

const getAvailableSlotsForDate = (
  zonedDate: Date,
  executionHours: number,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string,
  notBefore?: Date,
  buffer?: Duration | null,
  perMemberBlocked?: PerMemberBlockedData,
  resourcePolicy?: ResourcePolicy,
  orderedResourceIds?: string[]
) => {
  const dateKey = formatDateKey(zonedDate);
  const useResourcePolicy =
    perMemberBlocked &&
    resourcePolicy &&
    orderedResourceIds &&
    orderedResourceIds.length > 0;

  // In strict mode, check if date is fully blocked
  if (!useResourcePolicy && blockedDates.has(dateKey)) return [];

  const hours = getWorkingHoursForDate(availability, zonedDate);
  if (!hours.available || hours.startMinutes === null || hours.endMinutes === null) {
    return [];
  }

  const executionMinutes = executionHours * 60;
  const lastSlotStart = hours.endMinutes - executionMinutes;
  if (lastSlotStart < hours.startMinutes) {
    return [];
  }

  const zonedNow = toZonedTime(new Date(), timeZone);
  const isToday = formatDateKey(zonedNow) === dateKey;
  const nowMinutes =
    zonedNow.getUTCHours() * 60 + zonedNow.getUTCMinutes();

  const notBeforeMinutes =
    notBefore && formatDateKey(notBefore) === dateKey
      ? notBefore.getUTCHours() * 60 + notBefore.getUTCMinutes()
      : null;

  let currentStart = hours.startMinutes;
  if (isToday) {
    currentStart = Math.max(currentStart, nowMinutes);
  }
  if (notBeforeMinutes !== null) {
    currentStart = Math.max(currentStart, notBeforeMinutes);
  }

  const roundToSlot = (minutes: number) => Math.ceil(minutes / 30) * 30;
  currentStart = roundToSlot(currentStart);

  const dayStart = startOfDayZoned(zonedDate);
  const slots: Array<{ startZoned: Date; startTime: string }> = [];

  for (let startMinutes = currentStart; startMinutes <= lastSlotStart; startMinutes += 30) {
    const slotStartZoned = buildZonedTime(dayStart, startMinutes);
    const slotStartUtc = fromZonedTime(slotStartZoned, timeZone);
    const slotEndUtc = new Date(slotStartUtc.getTime() + executionMinutes * 60000);

    let bufferStartUtc: Date | undefined;
    let bufferEndUtc: Date | undefined;
    if (buffer && buffer.value > 0) {
      const executionEndZoned = new Date(
        slotStartZoned.getTime() + executionMinutes * 60000
      );
      const bufferStartZoned = getBufferStartZoned(
        executionEndZoned,
        "hours",
        buffer
      );
      const bufferEndZoned = calculateBufferEnd(
        executionEndZoned,
        buffer,
        "hours",
        availability,
        blockedDates,
        blockedRanges,
        timeZone
      );

      if (bufferStartZoned && bufferEndZoned > bufferStartZoned) {
        bufferStartUtc = fromZonedTime(bufferStartZoned, timeZone);
        bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
      }
    }

    let selectedSubset: string[] | null = null;
    if (useResourcePolicy) {
      // Resource policy mode: find a single subset that covers the execution window
      selectedSubset = findFirstEligibleSubsetForHours(
        perMemberBlocked!,
        availability,
        slotStartUtc,
        slotEndUtc,
        resourcePolicy!,
        orderedResourceIds!,
        timeZone,
        bufferStartUtc,
        bufferEndUtc
      );

      if (!selectedSubset) {
        continue;
      }
    } else {
      // Strict intersection mode: check if window overlaps any blocked ranges
      const overlaps = windowOverlapsRanges(
        slotStartUtc,
        slotEndUtc,
        blockedRanges,
        timeZone
      );

      if (overlaps) {
        continue;
      }
      if (bufferStartUtc && bufferEndUtc) {
        if (windowOverlapsRanges(bufferStartUtc, bufferEndUtc, blockedRanges, timeZone)) {
          continue;
        }
      }
    }

    const timeLabel = formatMinutesToTime(startMinutes);
    slots.push({ startZoned: slotStartZoned, startTime: timeLabel });
  }

  return slots;
};

const getBufferStartZoned = (
  executionEndZoned: Date,
  executionMode: DurationUnit,
  buffer: Duration | null
) => {
  if (!buffer || !buffer.value || buffer.value <= 0) {
    return null;
  }

  if (executionMode === "hours" && buffer.unit === "hours") {
    return executionEndZoned;
  }

  return addDaysZoned(startOfDayZoned(executionEndZoned), 1);
};

const addWorkingHours = (
  startZoned: Date,
  hoursToAdd: number,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => {
  let remainingMinutes = hoursToAdd * 60;
  let cursor = startZoned;
  const maxIterations = 366 * 3;
  let iterations = 0;

  while (remainingMinutes > 0 && iterations < maxIterations) {
    iterations += 1;
    const dayStart = startOfDayZoned(cursor);
    if (isDayBlocked(availability, dayStart, blockedDates, blockedRanges, timeZone)) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const hours = getWorkingHoursForDate(availability, dayStart);
    if (!hours.available || hours.startMinutes === null || hours.endMinutes === null) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    let currentMinutes = cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
    if (currentMinutes < hours.startMinutes) {
      currentMinutes = hours.startMinutes;
    }
    if (currentMinutes >= hours.endMinutes) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const availableMinutes = hours.endMinutes - currentMinutes;
    if (remainingMinutes <= availableMinutes) {
      return buildZonedTime(dayStart, currentMinutes + remainingMinutes);
    }

    remainingMinutes -= availableMinutes;
    cursor = addDaysZoned(dayStart, 1);
  }

  return cursor;
};

const windowOverlapsRanges = (
  windowStartUtc: Date,
  windowEndUtc: Date,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => blockedRanges.some((range) => {
  const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
  return windowStartUtc < rangeEnd && windowEndUtc > range.start;
});

const calculateBufferEnd = (
  executionEndZoned: Date,
  buffer: Duration | null,
  executionMode: DurationUnit,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => {
  if (!buffer || !buffer.value || buffer.value <= 0) {
    return executionEndZoned;
  }

  if (buffer.unit === "hours") {
    const bufferStart = getBufferStartZoned(
      executionEndZoned,
      executionMode,
      buffer
    );
    if (!bufferStart) {
      return executionEndZoned;
    }
    return addWorkingHours(
      bufferStart,
      buffer.value,
      availability,
      blockedDates,
      blockedRanges,
      timeZone
    );
  }

  const bufferStart = getBufferStartZoned(executionEndZoned, executionMode, buffer);
  if (!bufferStart) {
    return executionEndZoned;
  }

  let bufferDays = buffer.value;
  const bufferEndDay = advanceWorkingDays(
    bufferStart,
    Math.ceil(bufferDays),
    availability,
    blockedDates,
    blockedRanges,
    timeZone
  );
  const workingHours = getWorkingHoursForDate(availability, bufferEndDay);
  const endMinutes =
    workingHours.endMinutes ??
    parseTimeToMinutes(DEFAULT_AVAILABILITY.monday.endTime) ??
    1020;
  return buildZonedTime(bufferEndDay, endMinutes);
};

/**
 * Build schedule proposals using pre-loaded project and professional data.
 * This avoids N+1 queries when called in bulk.
 * Supports resource policy mode when project has resources.
 */
export const buildProjectScheduleProposalsWithData = async (
  project: any,
  professional: any,
  subprojectIndex?: number,
  durationOverride?: DurationOverride
): Promise<ScheduleProposals | null> => {
  if (!project || !professional) {
    return null;
  }

  const durations = getProjectDurations(project, subprojectIndex, durationOverride);
  if (!durations || !durations.execution?.value) {
    return null;
  }

  const availability = resolveAvailability(
    professional.companyAvailability
  );
  const timeZone = professional.businessInfo?.timezone || "UTC";
  const { isHoliday } = buildHolidayChecker(professional, timeZone);

  // Get resource policy and determine if multi-resource mode is active
  const resourcePolicy = getResourcePolicy(project);
  const useMultiResource = isMultiResourceMode(project);
  const orderedResourceIds = getOrderedResourceIds(project.resources);

  if (orderedResourceIds.length === 0) {
    return null;
  }

  // Build blocked data (merged for strict mode, per-member for multi-resource)
  const { blockedDates, blockedRanges } = await buildBlockedData(
    project,
    professional,
    timeZone
  );

  // Collect company-only blocked dates and ranges for multi-resource start date validation
  // Personal/customer blocks should not veto multi-resource start dates - only company-level blocks should
  const { companyBlockedDates, companyBlockedRanges } = collectCompanyBlocks(professional, timeZone);

  // Debug flag for verbose schedule proposal logging (set via environment variable)
  const enableScheduleDebug = process.env.ENABLE_SCHEDULE_DEBUG === "true";

  // Build per-member blocked data if in multi-resource mode
  let perMemberBlocked: PerMemberBlockedData | undefined;
  if (useMultiResource) {
    perMemberBlocked = await buildPerMemberBlockedData(
      project,
      professional,
      timeZone
    );
  }

  const prepEnd = calculatePrepEnd(
    durations.preparation,
    availability,
    timeZone,
    isHoliday
  );

  const execution = durations.execution;
  const executionMode = execution.unit;
  const searchStart =
    executionMode === "hours" ? prepEnd : startOfDayZoned(prepEnd);
  const maxDays = 180;

  const _debugInfo = {
    subprojectIndex,
    prepEnd: prepEnd.toISOString(),
    searchStart: searchStart.toISOString(),
    preparationDuration: durations.preparation ? `${durations.preparation.value} ${durations.preparation.unit}` : 'none',
    executionDuration: `${execution.value} ${execution.unit}`,
    timeZone,
    useMultiResource,
    resourcePolicy: resourcePolicy ? {
      minResources: resourcePolicy.minResources,
      totalResources: resourcePolicy.totalResources,
      minOverlapPercentage: resourcePolicy.minOverlapPercentage,
    } : null,
    projectId: project._id?.toString(),
  };

  let earliestBookableDate: Date | null = null;
  let earliestProposal: ProposalWindow | undefined;
  let shortestProposal: ProposalWindow | undefined;
  let shortestThroughput: number | null = null;

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset += 1) {
    const currentDay = addDaysZoned(searchStart, dayOffset);

    if (executionMode === "hours") {
      // Pass multi-resource params to getAvailableSlotsForDate
      const slots = getAvailableSlotsForDate(
        currentDay,
        execution.value,
        availability,
        blockedDates,
        blockedRanges,
        timeZone,
        prepEnd,
        durations.buffer,
        perMemberBlocked,
        useMultiResource ? resourcePolicy : undefined,
        useMultiResource ? orderedResourceIds : undefined
      );

      if (slots.length === 0) {
        continue;
      }

      if (!earliestBookableDate) {
        earliestBookableDate = startOfDayZoned(currentDay);
      }

      if (!earliestProposal) {
        const slot = slots[0];
        const startUtc = fromZonedTime(slot.startZoned, timeZone);
        const executionEndZoned = new Date(
          slot.startZoned.getTime() + execution.value * 60 * 60000
        );
        const executionEndUtc = fromZonedTime(executionEndZoned, timeZone);
        const bufferEndZoned = calculateBufferEnd(
          executionEndZoned,
          durations.buffer,
          executionMode,
          availability,
          blockedDates,
          blockedRanges,
          timeZone
        );
        const bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
        earliestProposal = {
          start: startUtc.toISOString(),
          end: bufferEndUtc.toISOString(),
          executionEnd: executionEndUtc.toISOString(),
        };
        shortestProposal = earliestProposal;
        break;
      }
    } else {
      const currentDayStr = currentDay.toISOString();
      const executionDays = Math.max(1, Math.ceil(execution.value));

      // Track selected subset for multi-resource mode (used in advanceWorkingDays for overlap %)
      let selectedSubset: string[] | null = null;

      // For multi-resource days mode, use window-based overlap check, but still
      // enforce that the chosen start day has at least minResources available.
      if (useMultiResource && perMemberBlocked && resourcePolicy) {
        // Still require it to be a working day
        const isWorking = isWorkingDay(availability, currentDay);
        if (enableScheduleDebug) {
          const dayOfWeekNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          const dayOfWeek = dayOfWeekNames[currentDay.getUTCDay()];
          console.log(`[SCHEDULE_PROPOSALS] Checking date: ${formatDateKey(currentDay)} (${dayOfWeek}), isWorkingDay: ${isWorking}`);
        }

        if (!isWorking) {
          continue;
        }

        // Skip dates that are company-blocked (dates or ranges) - they cannot be start dates
        // Only company-level blocks veto multi-resource start dates (not personal/customer blocks)
        // Personal blocks are handled by the per-member overlap calculation
        const dateKey = formatDateKey(currentDay);
        if (companyBlockedDates.has(dateKey)) {
          if (enableScheduleDebug) {
            console.log(`[SCHEDULE_PROPOSALS] Skipping ${dateKey} - date is company-blocked`);
          }
          continue;
        }

        // Also check company blocked ranges (e.g., holiday weeks)
        const currentDayUtc = fromZonedTime(currentDay, timeZone);
        const isInCompanyBlockedRange = companyBlockedRanges.some((range) => {
          return currentDayUtc >= range.start && currentDayUtc <= range.end;
        });
        if (isInCompanyBlockedRange) {
          if (enableScheduleDebug) {
            console.log(`[SCHEDULE_PROPOSALS] Skipping ${dateKey} - date is within a company-blocked range`);
          }
          continue;
        }

        // Start day must have enough resources available for the project's minResources.
        // This prevents proposing windows that begin on an unavailable day.
        const availableOnStartDay = countAvailableResourcesForDay(
          perMemberBlocked,
          availability,
          currentDay,
          timeZone
        );
        if (availableOnStartDay < resourcePolicy.minResources) {
          if (enableScheduleDebug) {
            console.log(
              `[SCHEDULE_PROPOSALS] Skipping ${dateKey} - insufficient start-day resources ` +
              `(available=${availableOnStartDay}, required=${resourcePolicy.minResources})`
            );
          }
          continue;
        }

        selectedSubset = findFirstEligibleSubsetForDays(
          perMemberBlocked,
          availability,
          currentDay,
          executionDays,
          resourcePolicy,
          orderedResourceIds,
          timeZone
        );

        if (!selectedSubset) {
          continue;
        }
      } else {
        // Single-resource or no policy: use strict per-day check
        const dayIsBlocked = isDayBlockedWithPolicy(
          availability,
          currentDay,
          blockedDates,
          blockedRanges,
          timeZone,
          perMemberBlocked,
          undefined
        );

        if (dayIsBlocked) {
          continue;
        }
      }

      // Only set earliestBookableDate after passing ALL checks
      if (!earliestBookableDate) {
        earliestBookableDate = startOfDayZoned(currentDay);
        if (enableScheduleDebug) {
          console.log('[SCHEDULE_PROPOSALS] Earliest bookable date found:', formatDateKey(earliestBookableDate));
        }
      }

      const executionEndDay = advanceWorkingDays(
        currentDay,
        executionDays,
        availability,
        blockedDates,
        blockedRanges,
        timeZone,
        useMultiResource ? perMemberBlocked : undefined,
        useMultiResource ? resourcePolicy : undefined,
        selectedSubset ?? undefined
      );
      // Count working days (excluding only weekends) for throughput calculation
      // Blocked days still count as throughput time - they delay but don't reduce throughput
      const throughputDays = countWorkingDaysBetween(
        currentDay,
        executionEndDay,
        availability
      );

      if (!earliestProposal && throughputDays <= executionDays * 2) {
        const executionEndUtc = fromZonedTime(executionEndDay, timeZone);
        const bufferEndZoned = calculateBufferEnd(
          executionEndDay,
          durations.buffer,
          executionMode,
          availability,
          blockedDates,
          blockedRanges,
          timeZone
        );
        const bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
        earliestProposal = {
          start: fromZonedTime(currentDay, timeZone).toISOString(),
          end: bufferEndUtc.toISOString(),
          executionEnd: executionEndUtc.toISOString(),
        };
      }

      if (throughputDays <= executionDays * 1.2) {
        if (shortestThroughput === null || throughputDays < shortestThroughput) {
          shortestThroughput = throughputDays;
          const executionEndUtc = fromZonedTime(executionEndDay, timeZone);
          const bufferEndZoned = calculateBufferEnd(
            executionEndDay,
            durations.buffer,
            executionMode,
            availability,
            blockedDates,
            blockedRanges,
            timeZone
          );
          const bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
          const startUtc = fromZonedTime(currentDay, timeZone);
          if (enableScheduleDebug) {
            const dayOfWeekNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const zonedDayOfWeek = dayOfWeekNames[currentDay.getUTCDay()];
            const utcDayOfWeek = dayOfWeekNames[startUtc.getUTCDay()];
            console.log('[SCHEDULE_PROPOSALS] New shortest window found:', {
              startDateZoned: formatDateKey(currentDay),
              zonedDayOfWeek,
              startDateUtc: startUtc.toISOString(),
              utcDayOfWeek,
              executionEndDateZoned: formatDateKey(executionEndDay),
              throughputDays,
              executionDays,
              timeZone,
            });
          }
          shortestProposal = {
            start: startUtc.toISOString(),
            end: bufferEndUtc.toISOString(),
            executionEnd: executionEndUtc.toISOString(),
          };
        }
      }

      if (earliestProposal && shortestProposal) {
        break;
      }
    }
  }

  const fallbackDate = earliestBookableDate || startOfDayZoned(prepEnd);

  return {
    mode: executionMode,
    earliestBookableDate: fromZonedTime(fallbackDate, timeZone).toISOString(),
    earliestProposal,
    shortestThroughputProposal: shortestProposal,
    _debug: {
      ..._debugInfo,
      earliestBookableDateRaw: fallbackDate.toISOString(),
      usedFallback: !earliestBookableDate,
    },
  };
};

/**
 * Build schedule proposals by loading project and professional data from the database.
 * This is a convenience wrapper around buildProjectScheduleProposalsWithData.
 */
export const buildProjectScheduleProposals = async (
  projectId: string,
  subprojectIndex?: number,
  durationOverride?: DurationOverride
): Promise<ScheduleProposals | null> => {
  const { project, professional } = await loadProjectAndProfessional(projectId);
  if (!project || !professional) {
    return null;
  }

  return buildProjectScheduleProposalsWithData(project, professional, subprojectIndex, durationOverride);
};

type ScheduleContext = {
  project: Awaited<ReturnType<typeof loadProjectAndProfessional>>["project"] & {};
  professional: Awaited<ReturnType<typeof loadProjectAndProfessional>>["professional"] & {};
  durations: NonNullable<ReturnType<typeof getProjectDurations>>;
  availability: ReturnType<typeof resolveAvailability>;
  timeZone: string;
  isHoliday: (date: Date) => boolean;
  resourcePolicy: ReturnType<typeof getResourcePolicy>;
  useMultiResource: boolean;
  orderedResourceIds: ReturnType<typeof getOrderedResourceIds>;
  prepEnd: Date;
  prepEndDay: Date;
};

type AssembleResult =
  | { ok: true; ctx: ScheduleContext }
  | { ok: false; reason: string };

const assembleScheduleContext = async (
  projectId: string,
  subprojectIndex?: number
): Promise<AssembleResult> => {
  const { project, professional } = await loadProjectAndProfessional(projectId);
  if (!project) return { ok: false, reason: "Project not found" };
  if (!professional) return { ok: false, reason: "Professional not found" };

  const durations = getProjectDurations(project, subprojectIndex);
  if (!durations || !durations.execution?.value) {
    return { ok: false, reason: "Missing execution duration" };
  }

  const availability = resolveAvailability(professional.companyAvailability);
  const timeZone = professional.businessInfo?.timezone || "UTC";
  const { isHoliday } = buildHolidayChecker(professional, timeZone);
  const resourcePolicy = getResourcePolicy(project);
  const useMultiResource = isMultiResourceMode(project);
  const orderedResourceIds = getOrderedResourceIds(project.resources);
  const prepEnd = calculatePrepEnd(durations.preparation, availability, timeZone, isHoliday);
  const prepEndDay = startOfDayZoned(prepEnd);

  return {
    ok: true,
    ctx: {
      project,
      professional,
      durations,
      availability,
      timeZone,
      isHoliday,
      resourcePolicy,
      useMultiResource,
      orderedResourceIds,
      prepEnd,
      prepEndDay,
    },
  };
};

export const validateProjectScheduleSelection = async ({
  projectId,
  subprojectIndex,
  startDate,
  startTime,
  customerBlocks,
  excludeBookingId,
}: {
  projectId: string;
  subprojectIndex?: number;
  startDate?: string;
  startTime?: string;
  customerBlocks?: CustomerBlocks;
  excludeBookingId?: string;
}) => {
  if (!startDate) {
    return { valid: true };
  }

  const assembled = await assembleScheduleContext(projectId, subprojectIndex);
  if (!assembled.ok) {
    return { valid: false, reason: assembled.reason };
  }
  const {
    project,
    professional,
    durations,
    availability,
    timeZone,
    resourcePolicy,
    useMultiResource,
    orderedResourceIds,
    prepEnd,
  } = assembled.ctx;

  if (orderedResourceIds.length === 0) {
    return { valid: false, reason: "Project has no resources available" };
  }

  const baseBlockedData = await buildBlockedData(
    project,
    professional,
    timeZone,
    customerBlocks,
    excludeBookingId
  );
  const { blockedDates, blockedRanges } = baseBlockedData;

  let perMemberBlocked: PerMemberBlockedData | undefined;
  if (useMultiResource) {
    perMemberBlocked = await buildPerMemberBlockedData(
      project,
      professional,
      timeZone,
      customerBlocks,
      excludeBookingId
    );
  }

  const dateParts = startDate.split("-").map(Number);
  if (dateParts.length < 3) {
    return { valid: false, reason: "Invalid start date" };
  }
  const [year, month, day] = dateParts;
  let selectedZoned = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

  if (durations.execution.unit === "hours") {
    if (!startTime) {
      return { valid: false, reason: "Start time required for hours mode" };
    }
    const minutes = parseTimeToMinutes(startTime);
    if (minutes === null) {
      return { valid: false, reason: "Invalid start time" };
    }
    selectedZoned = buildZonedTime(selectedZoned, minutes);
    if (selectedZoned < prepEnd) {
      return { valid: false, reason: "Selected time is before prep window" };
    }

    // Pass multi-resource params to getAvailableSlotsForDate
    const slots = getAvailableSlotsForDate(
      selectedZoned,
      durations.execution.value,
      availability,
      blockedDates,
      blockedRanges,
      timeZone,
      prepEnd,
      durations.buffer,
      perMemberBlocked,
      useMultiResource ? resourcePolicy : undefined,
      useMultiResource ? orderedResourceIds : undefined
    );

    const matchingSlot = slots.find((slot) => slot.startTime === startTime);
    if (!matchingSlot) {
      if (useMultiResource) {
        return { valid: false, reason: "Selected time does not meet team availability requirements" };
      }
      return { valid: false, reason: "Selected time is not available" };
    }
    return { valid: true };
  }

  // Days mode
  if (startOfDayZoned(selectedZoned) < startOfDayZoned(prepEnd)) {
    return { valid: false, reason: "Selected date is before prep window" };
  }

  const executionDays = Math.max(1, Math.ceil(durations.execution.value));

  // For multi-resource days mode, use window-based overlap check, but still
  // enforce that the selected start day has at least minResources available.
  if (useMultiResource && perMemberBlocked && resourcePolicy) {
    // Still require it to be a working day
    if (!isWorkingDay(availability, selectedZoned)) {
      return { valid: false, reason: "Selected date is not a working day" };
    }

    // Start day must satisfy minimum team availability.
    const availableOnStartDay = countAvailableResourcesForDay(
      perMemberBlocked,
      availability,
      selectedZoned,
      timeZone
    );
    if (availableOnStartDay < resourcePolicy.minResources) {
      return { valid: false, reason: "Selected date does not have enough team members available" };
    }

    const selectedSubset = findFirstEligibleSubsetForDays(
      perMemberBlocked,
      availability,
      selectedZoned,
      executionDays,
      resourcePolicy,
      orderedResourceIds,
      timeZone
    );

    if (!selectedSubset) {
      const requiredOverlap = getRequiredOverlapPercentage(resourcePolicy);
      const bestOverlap = computeBestOverlapPercentageForDays(
        perMemberBlocked,
        availability,
        selectedZoned,
        executionDays,
        resourcePolicy,
        orderedResourceIds,
        timeZone
      );
      if (bestOverlap > 0) {
        return {
          valid: false,
          reason: `Team availability (${Math.round(bestOverlap)}%) is below required ${requiredOverlap}%`
        };
      }
      return {
        valid: false,
        reason: "Selected date does not have enough team members available"
      };
    }
  } else {
    // Single-resource or no policy: use strict per-day check
    const dayIsBlocked = isDayBlockedWithPolicy(
      availability,
      selectedZoned,
      blockedDates,
      blockedRanges,
      timeZone,
      perMemberBlocked,
      undefined
    );

    if (dayIsBlocked) {
      return { valid: false, reason: "Selected date is blocked" };
    }
  }

  return { valid: true };
};

/**
 * Returns the start times the validator would accept for a given date.
 * Uses the same data assembly and `getAvailableSlotsForDate` that
 * `validateProjectScheduleSelection` uses, so the picker and the validator
 * agree.
 */
export const getProjectAvailableSlotsForDate = async ({
  projectId,
  subprojectIndex,
  startDate,
  customerBlocks,
}: {
  projectId: string;
  subprojectIndex?: number;
  startDate: string;
  customerBlocks?: CustomerBlocks;
}): Promise<{ slots: string[]; mode: "hours" | "days" } | null> => {
  if (!startDate) return null;

  const dateParts = startDate.split("-").map(Number);
  if (dateParts.length < 3) return null;
  const [year, month, day] = dateParts;
  const zonedDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (
    Number.isNaN(zonedDate.getTime()) ||
    zonedDate.getUTCFullYear() !== year ||
    zonedDate.getUTCMonth() + 1 !== month ||
    zonedDate.getUTCDate() !== day
  ) {
    return null;
  }

  const assembled = await assembleScheduleContext(projectId, subprojectIndex);
  if (!assembled.ok) return null;
  const {
    project,
    professional,
    durations,
    availability,
    timeZone,
    resourcePolicy,
    useMultiResource,
    orderedResourceIds,
    prepEnd,
    prepEndDay,
  } = assembled.ctx;

  if (durations.execution.unit !== "hours") {
    return { slots: [], mode: "days" };
  }

  if (orderedResourceIds.length === 0) {
    return { slots: [], mode: durations.execution.unit };
  }

  const queryDay = startOfDayZoned(zonedDate);
  if (queryDay.getTime() < prepEndDay.getTime()) {
    return { slots: [], mode: "hours" };
  }

  const baseBlockedData = await buildBlockedData(
    project,
    professional,
    timeZone,
    customerBlocks
  );
  const { blockedDates, blockedRanges } = baseBlockedData;

  let perMemberBlocked: PerMemberBlockedData | undefined;
  if (useMultiResource) {
    perMemberBlocked = await buildPerMemberBlockedData(
      project,
      professional,
      timeZone,
      customerBlocks
    );
  }

  const rawSlots = getAvailableSlotsForDate(
    zonedDate,
    durations.execution.value,
    availability,
    blockedDates,
    blockedRanges,
    timeZone,
    prepEnd,
    durations.buffer,
    perMemberBlocked,
    useMultiResource ? resourcePolicy : undefined,
    useMultiResource ? orderedResourceIds : undefined
  );

  return {
    slots: rawSlots.map((s) => s.startTime),
    mode: "hours",
  };
};

export const buildProjectScheduleWindow = async ({
  projectId,
  subprojectIndex,
  startDate,
  startTime,
  customerBlocks,
  durationOverride,
  excludeBookingId,
}: {
  projectId: string;
  subprojectIndex?: number;
  startDate?: string;
  startTime?: string;
  customerBlocks?: CustomerBlocks;
  durationOverride?: DurationOverride;
  excludeBookingId?: string;
}) => {
  if (!startDate) {
    return null;
  }

  const { project, professional } = await loadProjectAndProfessional(projectId);
  if (!project || !professional) {
    return null;
  }

  const durations = getProjectDurations(project, subprojectIndex, durationOverride);
  if (!durations || !durations.execution?.value) {
    return null;
  }

  const availability = resolveAvailability(
    professional.companyAvailability
  );
  const timeZone = professional.businessInfo?.timezone || "UTC";
  const { isHoliday } = buildHolidayChecker(professional, timeZone);
  const baseBlockedData = await buildBlockedData(
    project,
    professional,
    timeZone,
    customerBlocks,
    excludeBookingId
  );
  const { blockedDates, blockedRanges } = baseBlockedData;
  const bufferBlockedData = customerBlocks
    ? await buildBlockedData(project, professional, timeZone, undefined, excludeBookingId)
    : baseBlockedData;

  const resourcePolicy = getResourcePolicy(project);
  const useMultiResource = isMultiResourceMode(project);
  const orderedResourceIds = getOrderedResourceIds(project.resources);

  if (orderedResourceIds.length === 0) {
    return null;
  }

  let perMemberBlocked: PerMemberBlockedData | undefined;
  if (useMultiResource) {
    perMemberBlocked = await buildPerMemberBlockedData(
      project,
      professional,
      timeZone,
      customerBlocks,
      excludeBookingId
    );

    // Debug logging for resource blocked dates
    console.log('[SCHEDULE_WINDOW] Resource Policy:', {
      minResources: resourcePolicy.minResources,
      totalResources: resourcePolicy.totalResources,
      minOverlapPercentage: resourcePolicy.minOverlapPercentage,
      timeZone,
    });
    console.log('[SCHEDULE_WINDOW] Per-Resource Blocked Data:');
    perMemberBlocked.forEach((memberData, memberId) => {
      const blockedDatesList = Array.from(memberData.blockedDates).sort();
      const blockedRangesList = memberData.blockedRanges.map(r => ({
        start: r.start.toISOString(),
        end: r.end.toISOString(),
        reason: r.reason,
      }));
      console.log(`  Resource ${memberId.slice(-6)}:`, {
        blockedDates: blockedDatesList,
        blockedRangesCount: blockedRangesList.length,
        blockedRanges: blockedRangesList.slice(0, 5), // Show first 5 ranges
      });
    });
  }

  const prepEnd = calculatePrepEnd(
    durations.preparation,
    availability,
    timeZone,
    isHoliday
  );

  const dateParts = startDate.split("-").map(Number);
  if (dateParts.length < 3) {
    return null;
  }
  const [year, month, day] = dateParts;
  let selectedZoned = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

  if (durations.execution.unit === "hours") {
    if (!startTime) {
      return null;
    }
    const minutes = parseTimeToMinutes(startTime);
    if (minutes === null) {
      return null;
    }
    selectedZoned = buildZonedTime(selectedZoned, minutes);
    if (selectedZoned < prepEnd) {
      return null;
    }

    const executionEndZoned = new Date(
      selectedZoned.getTime() + durations.execution.value * 60 * 60000
    );
    const bufferStartZoned = getBufferStartZoned(
      executionEndZoned,
      durations.execution.unit,
      durations.buffer
    );
    const bufferEndZoned = calculateBufferEnd(
      executionEndZoned,
      durations.buffer,
      durations.execution.unit,
      availability,
      bufferBlockedData.blockedDates,
      bufferBlockedData.blockedRanges,
      timeZone
    );

    const hasBuffer = durations.buffer?.value && durations.buffer.value > 0;
    const bufferStartUtc =
      hasBuffer && bufferStartZoned && bufferEndZoned > bufferStartZoned
        ? fromZonedTime(bufferStartZoned, timeZone)
        : undefined;
    const bufferEndUtc =
      hasBuffer && bufferStartZoned && bufferEndZoned > bufferStartZoned
        ? fromZonedTime(bufferEndZoned, timeZone)
        : undefined;

    let selectedSubset: string[] | null = null;
    if (useMultiResource && perMemberBlocked) {
      selectedSubset = findFirstEligibleSubsetForHours(
        perMemberBlocked,
        availability,
        fromZonedTime(selectedZoned, timeZone),
        fromZonedTime(executionEndZoned, timeZone),
        resourcePolicy,
        orderedResourceIds,
        timeZone,
        bufferStartUtc,
        bufferEndUtc
      );
      if (!selectedSubset) {
        return null;
      }
    }

    // Convert execution end once and reuse to avoid any precision differences
    const executionEndUtc = fromZonedTime(executionEndZoned, timeZone);
    const executionStartDay = startOfDayZoned(selectedZoned);
    const executionEndDay = startOfDayZoned(
      toZonedTime(executionEndUtc, timeZone)
    );
    const throughputDays = countWorkingDaysBetween(
      executionStartDay,
      executionEndDay,
      availability
    );

    const assignedTeamMembers = selectedSubset
      ? validateAndDedupeResourceIds(selectedSubset)
      : validateAndDedupeResourceIds(project.resources);

    return {
      scheduledStartDate: fromZonedTime(selectedZoned, timeZone),
      scheduledExecutionEndDate: executionEndUtc,
      // When no buffer, buffer dates equal execution end (0 buffer duration)
      scheduledBufferStartDate: hasBuffer && bufferStartZoned
        ? fromZonedTime(bufferStartZoned, timeZone)
        : executionEndUtc,
      scheduledBufferEndDate: hasBuffer
        ? fromZonedTime(bufferEndZoned, timeZone)
        : executionEndUtc,
      scheduledBufferUnit: durations.buffer?.unit,
      scheduledStartTime: formatMinutesToTime(minutes),
      scheduledEndTime: formatMinutesToTime(
        minutes + Math.round(durations.execution.value * 60)
      ),
      assignedTeamMembers,
      throughputDays,
    };
  }

  const prepStartDay = startOfDayZoned(prepEnd);
  selectedZoned = startOfDayZoned(selectedZoned);
  if (selectedZoned < prepStartDay) {
    return null;
  }

  const executionDays = Math.max(1, Math.ceil(durations.execution.value));
  let selectedSubset: string[] | null = null;

  console.log('[SCHEDULE_WINDOW] Calculating window for:', {
    startDate,
    startDateZoned: formatDateKey(selectedZoned),
    executionDays,
    useMultiResource,
  });

  // For multi-resource days mode, use window-based overlap check, but still
  // enforce that the selected start day has at least minResources available.
  if (useMultiResource && perMemberBlocked && resourcePolicy) {
    // Still require it to be a working day
    if (!isWorkingDay(availability, selectedZoned)) {
      console.log('[SCHEDULE_WINDOW] Start date is not a working day');
      return null;
    }

    // Start day must satisfy minimum team availability.
    const availableOnStartDay = countAvailableResourcesForDay(
      perMemberBlocked,
      availability,
      selectedZoned,
      timeZone
    );
    if (availableOnStartDay < resourcePolicy.minResources) {
      console.log('[SCHEDULE_WINDOW] Start date has insufficient available resources:', {
        availableOnStartDay,
        required: resourcePolicy.minResources,
      });
      return null;
    }

    // Log per-day resource availability for the execution window
    console.log('[SCHEDULE_WINDOW] Checking overlap for execution window:');
    let checkCursor = selectedZoned;
    for (let i = 0; i < executionDays + 3; i++) { // Check a few extra days
      const dateKey = formatDateKey(checkCursor);
      const availableResources: string[] = [];
      const blockedResources: string[] = [];
      perMemberBlocked.forEach((memberData, memberId) => {
        const isBlocked = isMemberDayBlocked(memberData, availability, checkCursor, timeZone);
        if (isBlocked) {
          blockedResources.push(memberId.slice(-6));
        } else {
          availableResources.push(memberId.slice(-6));
        }
      });
      console.log(`  ${dateKey}: available=${availableResources.length} [${availableResources.join(',')}], blocked=${blockedResources.length} [${blockedResources.join(',')}]`);
      checkCursor = addDaysZoned(checkCursor, 1);
    }

    selectedSubset = findFirstEligibleSubsetForDays(
      perMemberBlocked,
      availability,
      selectedZoned,
      executionDays,
      resourcePolicy,
      orderedResourceIds,
      timeZone
    );
    if (!selectedSubset) {
      console.log('[SCHEDULE_WINDOW] No eligible subset found - date rejected');
      return null;
    }
    console.log('[SCHEDULE_WINDOW] Selected subset:', selectedSubset.map(id => id.slice(-6)));
  } else {
    // Single-resource or no policy: use strict per-day check
    if (
      isDayBlockedWithPolicy(
        availability,
        selectedZoned,
        blockedDates,
        blockedRanges,
        timeZone,
        perMemberBlocked,
        undefined
      )
    ) {
      return null;
    }
  }
  const executionEndDay = advanceWorkingDays(
    selectedZoned,
    executionDays,
    availability,
    blockedDates,
    blockedRanges,
    timeZone,
    useMultiResource ? perMemberBlocked : undefined,
    useMultiResource ? resourcePolicy : undefined,
    selectedSubset ?? undefined
  );

  console.log('[SCHEDULE_WINDOW] Execution window result:', {
    startDateZoned: formatDateKey(selectedZoned),
    executionEndDateZoned: formatDateKey(executionEndDay),
    executionDays,
  });
  const throughputDays = countWorkingDaysBetween(
    selectedZoned,
    executionEndDay,
    availability
  );

  const executionHours = getWorkingHoursForDate(availability, executionEndDay);
  const executionEndMinutes =
    executionHours.endMinutes ??
    parseTimeToMinutes(DEFAULT_AVAILABILITY.monday.endTime) ??
    1020;
  const executionEndZoned = buildZonedTime(executionEndDay, executionEndMinutes);
  const bufferStartZoned = getBufferStartZoned(
    executionEndZoned,
    durations.execution.unit,
    durations.buffer
  );
  const bufferEndZoned = calculateBufferEnd(
    executionEndZoned,
    durations.buffer,
    durations.execution.unit,
    availability,
    bufferBlockedData.blockedDates,
    bufferBlockedData.blockedRanges,
    timeZone
  );

  const hasBuffer = durations.buffer?.value && durations.buffer.value > 0;
  // Convert execution end once and reuse to avoid any precision differences
  const executionEndUtc = fromZonedTime(executionEndZoned, timeZone);

  const assignedTeamMembers = selectedSubset
    ? validateAndDedupeResourceIds(selectedSubset)
    : validateAndDedupeResourceIds(project.resources);

  return {
    scheduledStartDate: fromZonedTime(selectedZoned, timeZone),
    scheduledExecutionEndDate: executionEndUtc,
    // When no buffer, buffer dates equal execution end (0 buffer duration)
    scheduledBufferStartDate: hasBuffer && bufferStartZoned
      ? fromZonedTime(bufferStartZoned, timeZone)
      : executionEndUtc,
    scheduledBufferEndDate: hasBuffer
      ? fromZonedTime(bufferEndZoned, timeZone)
      : executionEndUtc,
    scheduledBufferUnit: durations.buffer?.unit,
    assignedTeamMembers,
    throughputDays,
  };
};

export const getUnbookableStartDates = async ({
  projectId,
  from,
  to,
  subprojectIndex,
  excludeBookingId,
}: {
  projectId: string;
  from: Date;
  to: Date;
  subprojectIndex?: number;
  excludeBookingId?: string;
}): Promise<string[]> => {
  const { project, professional } = await loadProjectAndProfessional(projectId);
  if (!project || !professional) {
    return [];
  }

  let resolvedSubprojectIndex = subprojectIndex;
  if (
    typeof resolvedSubprojectIndex !== "number" &&
    !(project as any).executionDuration?.value &&
    Array.isArray((project as any).subprojects)
  ) {
    const daysSubIdx = (project as any).subprojects.findIndex(
      (sp: any) => sp?.executionDuration?.unit === "days" && Number(sp?.executionDuration?.value) > 0
    );
    if (daysSubIdx >= 0) resolvedSubprojectIndex = daysSubIdx;
  }

  const durations = getProjectDurations(project, resolvedSubprojectIndex);
  if (!durations || !durations.execution?.value) {
    return [];
  }

  if (durations.execution.unit !== "days") {
    return [];
  }

  const resourcePolicy = getResourcePolicy(project);
  const useMultiResource = isMultiResourceMode(project);
  const orderedResourceIds = getOrderedResourceIds(project.resources);

  if (!useMultiResource || orderedResourceIds.length === 0) {
    return [];
  }

  const availability = resolveAvailability(professional.companyAvailability);
  const timeZone = professional.businessInfo?.timezone || "UTC";
  const { isHoliday } = buildHolidayChecker(professional, timeZone);

  const perMemberBlocked = await buildPerMemberBlockedData(
    project,
    professional,
    timeZone,
    undefined,
    excludeBookingId
  );

  const prepEnd = calculatePrepEnd(
    durations.preparation,
    availability,
    timeZone,
    isHoliday
  );
  const prepStartDay = startOfDayZoned(prepEnd);

  const executionDays = Math.max(1, Math.ceil(durations.execution.value));

  const fromZoned = startOfDayZoned(toZonedTime(from, timeZone));
  const toZoned = startOfDayZoned(toZonedTime(to, timeZone));

  const unbookable: string[] = [];
  let cursor = fromZoned;
  const maxIterations = 366 * 2;
  let iterations = 0;

  while (cursor <= toZoned && iterations < maxIterations) {
    iterations++;

    if (!isWorkingDay(availability, cursor)) {
      cursor = addDaysZoned(cursor, 1);
      continue;
    }

    let bookable = true;

    if (cursor < prepStartDay) {
      bookable = false;
    } else {
      const availableOnStartDay = countAvailableResourcesForDay(
        perMemberBlocked,
        availability,
        cursor,
        timeZone
      );
      if (availableOnStartDay < resourcePolicy.minResources) {
        bookable = false;
      } else {
        const selectedSubset = findFirstEligibleSubsetForDays(
          perMemberBlocked,
          availability,
          cursor,
          executionDays,
          resourcePolicy,
          orderedResourceIds,
          timeZone
        );
        if (!selectedSubset) {
          bookable = false;
        }
      }
    }

    if (!bookable) {
      unbookable.push(formatDateKey(cursor));
    }

    cursor = addDaysZoned(cursor, 1);
  }

  return unbookable;
};
