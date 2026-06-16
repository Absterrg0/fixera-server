import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking, { BookingStatus } from '../../models/booking';
import Project from '../../models/project';
import User from '../../models/user';
import { buildPerResourceBlockedDays } from '../../utils/scheduleEngine';

const PLANNING_ACTIVE_STATUSES: BookingStatus[] = ['booked', 'rescheduling_requested', 'in_progress', 'professional_completed'];

const WINDOW_MARGIN_DAYS = 14;

const startOfDayUTC = (value: Date): Date => {
  const d = new Date(value);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const formatDayKey = (value: Date): string => {
  const d = startOfDayUTC(value);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDayKey = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const [y, m, day] = value.split('-').map(Number);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return null;
  return d;
};

const addDays = (value: Date, days: number): Date => {
  const d = startOfDayUTC(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

const resolveProfessionalId = async (booking: any): Promise<string | undefined> => {
  if (booking.professional) {
    return booking.professional?._id?.toString?.() || booking.professional?.toString?.();
  }
  if (!booking.project) return undefined;
  const projectId = booking.project?._id?.toString?.() || booking.project?.toString?.();
  const project = await Project.findById(projectId).select('professionalId');
  return project?.professionalId?.toString?.() || (project?.professionalId as any);
};

const resolveCandidateResources = async (booking: any) => {
  const professionalId = await resolveProfessionalId(booking);
  if (!professionalId || !mongoose.isValidObjectId(professionalId)) return [];

  const resources: { _id: string; name: string }[] = [];
  const seen = new Set<string>();

  const professional = await User.findById(professionalId).select('name email username');
  if (professional) {
    const id = professional._id.toString();
    seen.add(id);
    resources.push({
      _id: id,
      name: (professional as any).name || (professional as any).username || (professional as any).email || id,
    });
  }

  const employees = await User.find({
    role: 'employee',
    'employee.companyId': professionalId,
    'employee.isActive': true,
  }).select('name email username');

  for (const emp of employees) {
    const id = emp._id.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    resources.push({
      _id: id,
      name: (emp as any).name || (emp as any).username || (emp as any).email || id,
    });
  }

  return resources;
};

const resolveExecutionDays = (project: any, booking: any): number => {
  let execution = project?.executionDuration;
  const subIndex = booking?.selectedSubprojectIndex;
  if (
    typeof subIndex === 'number' &&
    Array.isArray(project?.subprojects) &&
    project.subprojects[subIndex]?.executionDuration
  ) {
    execution = project.subprojects[subIndex].executionDuration;
  }
  if (!execution) return 1;
  const value =
    typeof execution.value === 'number' && execution.value > 0
      ? execution.value
      : execution.range?.max || execution.range?.min || 1;
  return Math.max(1, Math.ceil(value));
};

const resolveTimeZone = (professional: any): string => {
  return professional?.businessInfo?.timezone || 'UTC';
};

const getPlannedDayKeys = (booking: any): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  const plan: any[] = Array.isArray(booking.resourcePlan) ? booking.resourcePlan : [];
  for (const entry of plan) {
    const rid = (entry?.resourceId?._id || entry?.resourceId)?.toString?.();
    if (!rid) continue;
    const set = map.get(rid) || new Set<string>();
    const days: any[] = Array.isArray(entry?.days) ? entry.days : [];
    for (const day of days) {
      const d = new Date(day);
      if (Number.isNaN(d.getTime())) continue;
      set.add(formatDayKey(d));
    }
    map.set(rid, set);
  }
  return map;
};

const buildWindow = (booking: any, project: any) => {
  const today = startOfDayUTC(new Date());
  const rawStart = booking.scheduledStartDate ? startOfDayUTC(booking.scheduledStartDate) : null;
  const isInProgress = booking.status === 'in_progress' || booking.status === 'professional_completed';

  const startDate = rawStart || today;
  const windowFrom = isInProgress && today > startDate ? startDate : startDate;

  const executionDays = resolveExecutionDays(project, booking);
  const plannedEnd = booking.scheduledExecutionEndDate ? startOfDayUTC(booking.scheduledExecutionEndDate) : null;
  const execEnd = addDays(startDate, executionDays);
  let windowTo = execEnd;
  if (plannedEnd && plannedEnd > windowTo) windowTo = plannedEnd;
  if (windowTo < startDate) windowTo = startDate;
  windowTo = addDays(windowTo, WINDOW_MARGIN_DAYS);

  return { startDate, windowFrom, windowTo, isInProgress };
};

const buildPlanningPayload = async (booking: any, professional: any, project: any) => {
  const candidateResources = await resolveCandidateResources(booking);
  const resourceIds = candidateResources.map((r) => r._id);
  const { startDate, windowFrom, windowTo, isInProgress } = buildWindow(booking, project);
  const timeZone = resolveTimeZone(professional);

  let blockedByResource: Map<string, Set<string>> = new Map();
  if (resourceIds.length > 0) {
    blockedByResource = await buildPerResourceBlockedDays(
      project,
      professional,
      resourceIds,
      windowFrom,
      windowTo,
      timeZone,
      booking._id.toString(),
      booking.customerBlocks
    );
  }

  const plannedByResource = getPlannedDayKeys(booking);

  const customer = booking.customer && (booking.customer.name || booking.customer.email)
    ? booking.customer
    : null;
  const customerName = customer
    ? (customer.name || customer.username || customer.email || 'Customer')
    : 'Customer';

  return {
    bookingId: booking._id.toString(),
    bookingNumber: booking.bookingNumber || '',
    customerName,
    status: booking.status,
    startDate: formatDayKey(startDate),
    windowFrom: formatDayKey(windowFrom),
    windowTo: formatDayKey(windowTo),
    today: formatDayKey(startOfDayUTC(new Date())),
    isInProgress,
    resources: candidateResources.map((r) => ({
      _id: r._id,
      name: r.name,
      blockedDays: Array.from(blockedByResource.get(r._id) || new Set<string>()).sort(),
      plannedDays: Array.from(plannedByResource.get(r._id) || new Set<string>()).sort(),
    })),
  };
};

export const updateBookingPlanning = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const load = (req.body as any)?.load === true;
    const incomingPlan = (req.body as any)?.resourcePlan;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid booking ID' } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('professional', '_id name email username businessInfo companyAvailability availability companyBlockedDates companyBlockedRanges')
      .populate('customer', '_id name email username');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    const professionalId = await resolveProfessionalId(booking);
    if (!professionalId || professionalId !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can manage planning' } });
    }

    if (!PLANNING_ACTIVE_STATUSES.includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Planning is only available before completion' } });
    }

    if (booking.bookingType !== 'project' || !booking.project) {
      return res.status(400).json({ success: false, error: { code: 'NOT_PROJECT', message: 'Planning is only available for project bookings' } });
    }

    const projectId = booking.project?._id?.toString?.() || booking.project?.toString?.();
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    }

    let professional: any = (booking.professional && (booking.professional as any).businessInfo !== undefined)
      ? booking.professional
      : null;
    if (!professional) {
      professional = await User.findById(professionalId).select(
        'name email username businessInfo companyAvailability availability companyBlockedDates companyBlockedRanges'
      );
    }

    if (load) {
      const payload = await buildPlanningPayload(booking, professional, project);
      return res.json({ success: true, data: payload });
    }

    if (!Array.isArray(incomingPlan)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PLAN', message: 'A resource plan is required' } });
    }

    const candidateResources = await resolveCandidateResources(booking);
    const candidateIds = new Set(candidateResources.map((c) => c._id));
    if (candidateIds.size === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_RESOURCES', message: 'This booking has no resources available to plan' } });
    }

    const { startDate, windowFrom, windowTo, isInProgress } = buildWindow(booking, project);
    const today = startOfDayUTC(new Date());
    const timeZone = resolveTimeZone(professional);

    const resourceIds = candidateResources.map((r) => r._id);
    const blockedByResource = await buildPerResourceBlockedDays(
      project,
      professional,
      resourceIds,
      windowFrom,
      windowTo,
      timeZone,
      booking._id.toString(),
      booking.customerBlocks
    );

    const existingPlanned = getPlannedDayKeys(booking);

    const normalizedPlan: { resourceId: mongoose.Types.ObjectId; days: Date[] }[] = [];
    const seenResource = new Set<string>();
    let maxDay: Date | null = null;

    for (const item of incomingPlan) {
      const resourceId = item?.resourceId != null ? String(item.resourceId) : '';
      if (!mongoose.isValidObjectId(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_RESOURCE', message: 'Invalid resource in plan' } });
      }
      if (!candidateIds.has(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'UNKNOWN_RESOURCE', message: 'Resource is not part of this booking' } });
      }
      if (seenResource.has(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'DUPLICATE_RESOURCE', message: 'A resource can only appear once in the plan' } });
      }
      seenResource.add(resourceId);

      const rawDays: any[] = Array.isArray(item?.days) ? item.days : [];
      const blocked = blockedByResource.get(resourceId) || new Set<string>();
      const previous = existingPlanned.get(resourceId) || new Set<string>();
      const dayKeys = new Set<string>();

      for (const raw of rawDays) {
        const parsed = parseDayKey(raw);
        if (!parsed) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'Each planned day must be a valid YYYY-MM-DD date' } });
        }
        const key = formatDayKey(parsed);
        if (parsed < windowFrom || parsed > windowTo) {
          return res.status(400).json({ success: false, error: { code: 'OUT_OF_WINDOW', message: 'A planned day is outside the allowed window' } });
        }
        if (blocked.has(key)) {
          return res.status(400).json({ success: false, error: { code: 'BLOCKED_DAY', message: 'A planned day is unavailable for that resource' } });
        }
        dayKeys.add(key);
      }

      if (isInProgress) {
        const allKeys = new Set<string>([...dayKeys, ...previous]);
        for (const key of allKeys) {
          const d = parseDayKey(key);
          if (!d || d >= today) continue;
          const wasPlanned = previous.has(key);
          const isPlanned = dayKeys.has(key);
          if (wasPlanned !== isPlanned) {
            return res.status(400).json({ success: false, error: { code: 'PAST_LOCKED', message: 'Days before today cannot be changed while work is in progress' } });
          }
        }
      }

      const days = Array.from(dayKeys)
        .sort()
        .map((key) => parseDayKey(key)!)
        .filter(Boolean);

      for (const d of days) {
        if (!maxDay || d > maxDay) maxDay = d;
      }

      normalizedPlan.push({
        resourceId: new mongoose.Types.ObjectId(resourceId),
        days,
      });
    }

    if (isInProgress) {
      for (const [rid, previous] of existingPlanned.entries()) {
        if (seenResource.has(rid)) continue;
        for (const key of previous) {
          const d = parseDayKey(key);
          if (d && d < today) {
            return res.status(400).json({ success: false, error: { code: 'PAST_LOCKED', message: 'Days before today cannot be removed while work is in progress' } });
          }
        }
      }
    }

    const planWithDays = normalizedPlan.filter((p) => p.days.length > 0);

    const previousExecutionEnd = booking.scheduledExecutionEndDate
      ? startOfDayUTC(booking.scheduledExecutionEndDate)
      : null;

    let newExecutionEnd = maxDay || (previousExecutionEnd && previousExecutionEnd > startDate ? previousExecutionEnd : addDays(startDate, 1));
    if (newExecutionEnd <= startDate) {
      newExecutionEnd = addDays(startDate, 1);
    }

    booking.resourcePlan = planWithDays as any;
    booking.assignedTeamMembers = planWithDays.map((p) => p.resourceId) as any;
    booking.scheduledExecutionEndDate = newExecutionEnd;

    if (booking.scheduledBufferStartDate || booking.scheduledBufferEndDate) {
      const shiftMs = previousExecutionEnd ? newExecutionEnd.getTime() - previousExecutionEnd.getTime() : 0;
      if (booking.scheduledBufferStartDate) {
        booking.scheduledBufferStartDate = new Date(startOfDayUTC(booking.scheduledBufferStartDate).getTime() + shiftMs);
      } else {
        booking.scheduledBufferStartDate = newExecutionEnd;
      }
      if (booking.scheduledBufferEndDate) {
        booking.scheduledBufferEndDate = new Date(startOfDayUTC(booking.scheduledBufferEndDate).getTime() + shiftMs);
      }
      if (booking.scheduledBufferStartDate < newExecutionEnd) {
        booking.scheduledBufferStartDate = newExecutionEnd;
      }
      if (booking.scheduledBufferEndDate && booking.scheduledBufferEndDate < booking.scheduledBufferStartDate) {
        booking.scheduledBufferEndDate = booking.scheduledBufferStartDate;
      }
    }

    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push({
      status: booking.status,
      timestamp: new Date(),
      updatedBy: (req as any).user._id,
      note: `Planning updated: ${planWithDays.length} resource(s), end ${formatDayKey(newExecutionEnd)}`,
    } as any);

    await booking.save({ validateModifiedOnly: true });

    const payload = await buildPlanningPayload(booking, professional, project);

    return res.json({ success: true, data: payload });
  } catch (error: any) {
    console.error('Error updating booking planning:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to update planning' } });
  }
};
