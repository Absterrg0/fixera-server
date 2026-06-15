import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking, { BookingStatus } from '../../models/booking';
import Project from '../../models/project';
import User from '../../models/user';
import { buildBookingBlockedRanges } from '../../utils/bookingBlocks';

const PLANNING_ACTIVE_STATUSES: BookingStatus[] = ['booked', 'rescheduling_requested', 'in_progress', 'professional_completed'];

const startOfDayUTC = (value: Date): Date => {
  const d = new Date(value);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const parseUTCDate = (dateStr: string): Date => {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const getDaysBetween = (start: Date, end: Date): string[] => {
  const dates: string[] = [];
  const curr = new Date(startOfDayUTC(start));
  const last = new Date(startOfDayUTC(end));
  while (curr <= last) {
    dates.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }
  return dates;
};

const getContiguousRanges = (dateStrings: string[]): Array<{ startDate: string; endDate: string }> => {
  if (dateStrings.length === 0) return [];
  const sorted = [...dateStrings].sort();
  const ranges: Array<{ startDate: string; endDate: string }> = [];
  
  let currentStart = sorted[0];
  let currentEnd = sorted[0];
  
  for (let i = 1; i < sorted.length; i++) {
    const dateA = parseUTCDate(currentEnd);
    const dateB = parseUTCDate(sorted[i]);
    const diffTime = Math.abs(dateB.getTime() - dateA.getTime());
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 1) {
      currentEnd = sorted[i];
    } else {
      ranges.push({ startDate: currentStart, endDate: currentEnd });
      currentStart = sorted[i];
      currentEnd = sorted[i];
    }
  }
  ranges.push({ startDate: currentStart, endDate: currentEnd });
  return ranges;
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

const isDaysModeForBooking = (booking: any, project: any): boolean => {
  if (!project) return false;
  const subprojects = project.subprojects;
  const selectedIndex = booking.selectedSubprojectIndex;
  let unit: 'hours' | 'days' | undefined;
  if (subprojects && subprojects.length > 0) {
    const sub =
      typeof selectedIndex === 'number'
        ? subprojects[selectedIndex]
        : subprojects.length === 1
        ? subprojects[0]
        : undefined;
    unit = sub?.executionDuration?.unit;
  }
  if (!unit) unit = project.executionDuration?.unit;
  if (unit) return unit === 'days';
  return project.timeMode === 'days';
};

const getUnavailableDatesForUser = async (userId: string, currentBookingId: string): Promise<string[]> => {
  const user = await User.findById(userId).select('blockedDates blockedRanges');
  if (!user) return [];

  const dateSet = new Set<string>();

  // 1. Add blockedDates
  if (Array.isArray(user.blockedDates)) {
    for (const entry of user.blockedDates) {
      if (entry.date) {
        dateSet.add(new Date(entry.date).toISOString().slice(0, 10));
      }
    }
  }

  // 2. Add blockedRanges
  if (Array.isArray(user.blockedRanges)) {
    for (const range of user.blockedRanges) {
      if (range.startDate && range.endDate) {
        const days = getDaysBetween(range.startDate, range.endDate);
        for (const day of days) {
          dateSet.add(day);
        }
      }
    }
  }

  // 3. Add booking blocked ranges / resource plans from other bookings
  const otherBookings = await Booking.find({
    _id: { $ne: new mongoose.Types.ObjectId(currentBookingId) },
    status: { $nin: ["completed", "cancelled", "refunded"] },
    $or: [
      { professional: new mongoose.Types.ObjectId(userId) },
      { assignedTeamMembers: new mongoose.Types.ObjectId(userId) },
      { 'resourcePlan.resourceId': new mongoose.Types.ObjectId(userId) }
    ]
  }).select('resourcePlan');

  const bookingsWithPlan = new Set<string>();
  const bookingsWithoutPlan = new Set<string>();

  for (const b of otherBookings) {
    const bId = b._id.toString();
    const hasResourcePlanForUser = Array.isArray(b.resourcePlan) && b.resourcePlan.some((p: any) => 
      (p.resourceId?._id || p.resourceId)?.toString() === userId.toString()
    );
    if (hasResourcePlanForUser) {
      bookingsWithPlan.add(bId);
      const plan = b.resourcePlan || [];
      for (const p of plan) {
        if ((p.resourceId?._id || p.resourceId)?.toString() === userId.toString()) {
          if (p.startDate && p.endDate) {
            const days = getDaysBetween(new Date(p.startDate), new Date(p.endDate));
            for (const day of days) {
              dateSet.add(day);
            }
          }
        }
      }
    } else {
      bookingsWithoutPlan.add(bId);
    }
  }

  const bookingRanges = await buildBookingBlockedRanges(userId);
  for (const range of bookingRanges) {
    if (range.bookingId === currentBookingId) continue;
    if (range.bookingId && bookingsWithoutPlan.has(range.bookingId)) {
      if (range.startDate && range.endDate) {
        const days = getDaysBetween(new Date(range.startDate), new Date(range.endDate));
        for (const day of days) {
          dateSet.add(day);
        }
      }
    }
  }

  return Array.from(dateSet);
};

const resolveCandidateResources = async (booking: any) => {
  const professionalId = await resolveProfessionalId(booking);
  if (!professionalId) return [];

  const projectId = booking.project?._id || booking.project;
  if (!projectId) return [];
  const project = await Project.findById(projectId).select('resources');
  if (!project || !Array.isArray(project.resources) || project.resources.length === 0) {
    return [];
  }
  const projectResourceIds = new Set(project.resources.map(id => id.toString()));

  const [professionalUser, employees] = await Promise.all([
    User.findById(professionalId).select('name email username'),
    User.find({
      role: 'employee',
      'employee.companyId': professionalId,
      'employee.isActive': true
    }).select('name email username')
  ]);

  const candidates: any[] = [];
  if (professionalUser && projectResourceIds.has(professionalUser._id.toString())) {
    candidates.push({
      _id: professionalUser._id.toString(),
      name: professionalUser.name,
      email: professionalUser.email,
      username: professionalUser.username,
    });
  }
  for (const emp of employees) {
    if (projectResourceIds.has(emp._id.toString())) {
      candidates.push({
        _id: emp._id.toString(),
        name: emp.name,
        email: emp.email,
        username: emp.username,
      });
    }
  }
  return candidates;
};

const buildPlanningPayload = async (booking: any) => {
  const candidateResources = await resolveCandidateResources(booking);
  const candidateResourcesWithAvailability = await Promise.all(
    candidateResources.map(async (c) => {
      const unavailableDates = await getUnavailableDatesForUser(c._id, booking._id.toString());
      return {
        ...c,
        unavailableDates,
      };
    })
  );

  return {
    bookingId: booking._id.toString(),
    bookingNumber: booking.bookingNumber,
    customerName: booking.customer?.name || '',
    status: booking.status,
    scheduledStartDate: booking.scheduledStartDate,
    scheduledExecutionEndDate: booking.scheduledExecutionEndDate,
    scheduledBufferStartDate: booking.scheduledBufferStartDate,
    scheduledBufferEndDate: booking.scheduledBufferEndDate,
    assignedTeamMembers: Array.isArray(booking.assignedTeamMembers)
      ? booking.assignedTeamMembers.map((m: any) => ({
          _id: (m?._id || m)?.toString?.(),
          name: m?.name,
          email: m?.email,
        }))
      : [],
    resourcePlan: Array.isArray(booking.resourcePlan)
      ? booking.resourcePlan.map((p: any) => ({
          resourceId: (p?.resourceId?._id || p?.resourceId)?.toString?.(),
          startDate: p?.startDate,
          endDate: p?.endDate,
        }))
      : [],
    candidateResources: candidateResourcesWithAvailability,
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
      .populate('professional', '_id name email')
      .populate('assignedTeamMembers', 'name email')
      .populate('customer', 'name email');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    const project = await Project.findById(booking.project);
    if (!project || !isDaysModeForBooking(booking, project)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_MODE', message: 'Planning is only available for days-mode projects' } });
    }

    const professionalId = await resolveProfessionalId(booking);
    if (!professionalId || professionalId !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can manage planning' } });
    }

    if (!PLANNING_ACTIVE_STATUSES.includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Planning is only available before completion' } });
    }

    if (load) {
      const payload = await buildPlanningPayload(booking);
      return res.json({ success: true, data: payload });
    }

    if (!Array.isArray(incomingPlan) || incomingPlan.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'EMPTY_PLAN', message: 'At least one resource is required in the plan' } });
    }

    const candidateResources = await resolveCandidateResources(booking);
    const candidateIds = new Set(candidateResources.map((c) => c._id));
    if (candidateIds.size === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_PROJECT_RESOURCES', message: 'This project has no resources available to plan' } });
    }

    const bookingStart = booking.scheduledStartDate ? startOfDayUTC(booking.scheduledStartDate) : null;
    if (!bookingStart) {
      return res.status(400).json({ success: false, error: { code: 'NO_START', message: 'Booking has no scheduled start date' } });
    }

    const today = startOfDayUTC(new Date());
    const isInProgress = booking.status === 'in_progress' || booking.status === 'professional_completed';

    const mergedResourceDays = new Map<string, Set<string>>();

    // 1. If in progress, populate with existing planned days that are in the past (< today)
    if (isInProgress) {
      const existingPlan: any[] = Array.isArray(booking.resourcePlan) ? booking.resourcePlan : [];
      for (const entry of existingPlan) {
        const rid = (entry?.resourceId?._id || entry?.resourceId)?.toString?.();
        if (!rid) continue;
        
        const start = startOfDayUTC(entry.startDate);
        const end = startOfDayUTC(entry.endDate);
        
        if (start < today) {
          const lastPastDate = end < today ? end : new Date(today.getTime() - 24 * 60 * 60 * 1000);
          const days = getDaysBetween(start, lastPastDate);
          if (!mergedResourceDays.has(rid)) {
            mergedResourceDays.set(rid, new Set());
          }
          const set = mergedResourceDays.get(rid)!;
          for (const d of days) {
            set.add(d);
          }
        }
      }
    }

    // Pre-cache unavailable dates for all candidates
    const unavailableDatesCache = new Map<string, Set<string>>();
    await Promise.all(
      Array.from(candidateIds).map(async (rid) => {
        const dates = await getUnavailableDatesForUser(rid, booking._id.toString());
        unavailableDatesCache.set(rid, new Set(dates));
      })
    );

    // 2. Add incoming planned days (filtering out any < today if in progress)
    for (const item of incomingPlan) {
      const resourceId = item?.resourceId != null ? String(item.resourceId) : '';
      if (!mongoose.isValidObjectId(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_RESOURCE', message: 'Invalid resource in plan' } });
      }
      if (!candidateIds.has(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'UNKNOWN_RESOURCE', message: 'Resource is not part of this project' } });
      }
      
      if (typeof item?.startDate !== 'string' || typeof item?.endDate !== 'string') {
        return res.status(400).json({ success: false, error: { code: 'INVALID_DATE_FORMAT', message: 'Dates must be in YYYY-MM-DD format strings' } });
      }

      const yyyymmddRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!yyyymmddRegex.test(item.startDate) || !yyyymmddRegex.test(item.endDate)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_DATE_FORMAT', message: 'Dates must be in YYYY-MM-DD format strings' } });
      }

      const rawStart = parseUTCDate(item.startDate);
      const rawEnd = parseUTCDate(item.endDate);
      if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'Each resource needs a valid start and end date' } });
      }
      
      const start = startOfDayUTC(rawStart);
      const end = startOfDayUTC(rawEnd);
      
      if (start < bookingStart) {
        return res.status(400).json({ success: false, error: { code: 'BEFORE_START', message: 'A resource cannot start before the booking start date' } });
      }
      if (end < start) {
        return res.status(400).json({ success: false, error: { code: 'END_BEFORE_START', message: 'A resource end date cannot be before its start date' } });
      }
      
      const days = getDaysBetween(start, end);
      
      if (!mergedResourceDays.has(resourceId)) {
        mergedResourceDays.set(resourceId, new Set());
      }
      const set = mergedResourceDays.get(resourceId)!;
      
      const unavailableSet = unavailableDatesCache.get(resourceId) || new Set<string>();

      for (const d of days) {
        const dayDate = startOfDayUTC(new Date(d));
        if (isInProgress && dayDate < today) {
          // Skip/ignore any incoming day in the past if in progress
          continue;
        }
        if (unavailableSet.has(d)) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'RESOURCE_UNAVAILABLE',
              message: `Resource is unavailable on ${d}`
            }
          });
        }
        set.add(d);
      }
    }

    // 3. Convert mergedResourceDays to contiguous ranges
    const normalizedPlan: { resourceId: mongoose.Types.ObjectId; startDate: Date; endDate: Date }[] = [];
    for (const [rid, daySet] of mergedResourceDays.entries()) {
      if (daySet.size === 0) continue;
      const ranges = getContiguousRanges(Array.from(daySet));
      for (const range of ranges) {
        normalizedPlan.push({
          resourceId: new mongoose.Types.ObjectId(rid),
          startDate: parseUTCDate(range.startDate),
          endDate: parseUTCDate(range.endDate),
        });
      }
    }

    if (normalizedPlan.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'EMPTY_PLAN', message: 'At least one resource day must be planned' } });
    }

    let maxEnd = normalizedPlan[0].endDate;
    for (const entry of normalizedPlan) {
      if (entry.endDate > maxEnd) maxEnd = entry.endDate;
    }

    // Check if the plan only consists of same-day allocations (each entry has startDate === endDate)
    const isSameDayPlan = normalizedPlan.every(p => p.startDate.getTime() === p.endDate.getTime());

    if (maxEnd <= bookingStart && !isSameDayPlan) {
      maxEnd = new Date(bookingStart.getTime() + 24 * 60 * 60 * 1000);
    }

    const previousExecutionEnd = booking.scheduledExecutionEndDate
      ? startOfDayUTC(booking.scheduledExecutionEndDate)
      : null;

    booking.resourcePlan = normalizedPlan as any;
    const uniqueResourceIds = Array.from(new Set(normalizedPlan.map((p) => p.resourceId.toString())));
    booking.assignedTeamMembers = uniqueResourceIds.map((id) => new mongoose.Types.ObjectId(id)) as any;
    booking.scheduledExecutionEndDate = maxEnd;

    if (booking.scheduledBufferStartDate || booking.scheduledBufferEndDate) {
      const shiftMs = previousExecutionEnd ? maxEnd.getTime() - previousExecutionEnd.getTime() : 0;
      if (booking.scheduledBufferStartDate) {
        booking.scheduledBufferStartDate = new Date(startOfDayUTC(booking.scheduledBufferStartDate).getTime() + shiftMs);
      } else {
        booking.scheduledBufferStartDate = maxEnd;
      }
      if (booking.scheduledBufferEndDate) {
        booking.scheduledBufferEndDate = new Date(startOfDayUTC(booking.scheduledBufferEndDate).getTime() + shiftMs);
      }
      if (booking.scheduledBufferStartDate < maxEnd) {
        booking.scheduledBufferStartDate = maxEnd;
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
      note: `Planning updated: ${normalizedPlan.length} resource(s), end ${maxEnd.toISOString().slice(0, 10)}`,
    } as any);

    await booking.save();

    await booking.populate('assignedTeamMembers', 'name email');
    const payload = await buildPlanningPayload(booking);

    return res.json({ success: true, data: payload });
  } catch (error: any) {
    console.error('Error updating booking planning:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to update planning' } });
  }
};
