import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking, { BookingStatus } from '../../models/booking';
import Project from '../../models/project';
import User from '../../models/user';

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
  if (booking.bookingType !== 'project' || !booking.project) return [];
  const projectId = booking.project?._id?.toString?.() || booking.project?.toString?.();
  const project = await Project.findById(projectId).select('resources');
  const rawIds: any[] = Array.isArray(project?.resources) ? (project!.resources as any[]) : [];
  const validIds: string[] = [];
  const seen = new Set<string>();
  for (const id of rawIds) {
    if (id == null) continue;
    const idStr = typeof id === 'string' ? id : String(id);
    if (!mongoose.isValidObjectId(idStr)) continue;
    if (seen.has(idStr)) continue;
    seen.add(idStr);
    validIds.push(idStr);
  }
  if (validIds.length === 0) return [];
  const users = await User.find({ _id: { $in: validIds } }).select('name email username');

  // Fetch other active bookings for these resources
  const validObjectIds = validIds.map(id => new mongoose.Types.ObjectId(id));

  const otherBookings = await Booking.find({
    _id: { $ne: booking._id },
    status: { $nin: ['completed', 'cancelled', 'refunded'] },
    $or: [
      { assignedTeamMembers: { $in: validObjectIds } },
      { professional: { $in: validObjectIds } }
    ],
    scheduledStartDate: { $exists: true, $ne: null }
  }).populate('project', 'title');

  const bookedSlotsMap = new Map<string, any[]>();
  for (const other of otherBookings) {
    const otherProjTitle = (other.project as any)?.title || 'Direct Booking';
    const planEntries = Array.isArray(other.resourcePlan) ? other.resourcePlan : [];
    const assignedIds = Array.isArray(other.assignedTeamMembers)
      ? other.assignedTeamMembers.map((id: any) => id.toString())
      : [];
    const profId = other.professional?.toString();
    
    const relevantResourceIds: string[] = [];
    const addUnique = (id: string) => {
      if (id && !relevantResourceIds.includes(id)) {
        relevantResourceIds.push(id);
      }
    };
    assignedIds.forEach(id => addUnique(id));
    if (profId) addUnique(profId);
    
    planEntries.forEach((entry: any) => {
      const rid = (entry.resourceId?._id || entry.resourceId)?.toString();
      if (rid) addUnique(rid);
    });
    
    for (const rid of relevantResourceIds) {
      if (!validIds.includes(rid)) continue;
      
      const planEntry = planEntries.find((entry: any) => {
        const entryRid = (entry.resourceId?._id || entry.resourceId)?.toString();
        return entryRid === rid;
      });
      
      let start = other.scheduledStartDate;
      let end = other.scheduledExecutionEndDate || other.scheduledBufferEndDate || other.scheduledStartDate;
      
      if (planEntry) {
        start = planEntry.startDate;
        end = planEntry.endDate;
      }
      
      if (!start || !end) continue;
      
      const list = bookedSlotsMap.get(rid) || [];
      list.push({
        bookingId: other._id.toString(),
        bookingNumber: other.bookingNumber || 'BK-' + other._id.toString().slice(-6),
        projectTitle: otherProjTitle,
        startDate: start,
        endDate: end
      });
      bookedSlotsMap.set(rid, list);
    }
  }

  return users.map((u: any) => ({
    _id: u._id.toString(),
    name: u.name,
    email: u.email,
    username: u.username,
    bookedSlots: bookedSlotsMap.get(u._id.toString()) || []
  }));
};

const buildPlanningPayload = async (booking: any) => {
  const candidateResources = await resolveCandidateResources(booking);
  return {
    bookingId: booking._id.toString(),
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
    candidateResources,
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
      .populate('assignedTeamMembers', 'name email');

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

    const existingPlan: any[] = Array.isArray(booking.resourcePlan) ? booking.resourcePlan : [];
    const existingById: Record<string, any> = {};
    for (const entry of existingPlan) {
      const rid = (entry?.resourceId?._id || entry?.resourceId)?.toString?.();
      if (rid) existingById[rid] = entry;
    }

    const normalizedPlan: { resourceId: mongoose.Types.ObjectId; startDate: Date; endDate: Date }[] = [];
    const seenResource = new Set<string>();

    for (const item of incomingPlan) {
      const resourceId = item?.resourceId != null ? String(item.resourceId) : '';
      if (!mongoose.isValidObjectId(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_RESOURCE', message: 'Invalid resource in plan' } });
      }
      if (!candidateIds.has(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'UNKNOWN_RESOURCE', message: 'Resource is not part of this project' } });
      }
      if (seenResource.has(resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'DUPLICATE_RESOURCE', message: 'A resource can only appear once in the plan' } });
      }
      seenResource.add(resourceId);

      const rawStart = parseDate(item?.startDate);
      const rawEnd = parseDate(item?.endDate);
      if (!rawStart || !rawEnd) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'Each resource needs a valid start and end date' } });
      }
      const startDate = startOfDayUTC(rawStart);
      const endDate = startOfDayUTC(rawEnd);

      if (startDate < bookingStart) {
        return res.status(400).json({ success: false, error: { code: 'BEFORE_START', message: 'A resource cannot start before the booking start date' } });
      }
      if (endDate < startDate) {
        return res.status(400).json({ success: false, error: { code: 'END_BEFORE_START', message: 'A resource end date cannot be before its start date' } });
      }

      if (isInProgress) {
        const existing = existingById[resourceId];
        const isUsed = existing && startOfDayUTC(existing.startDate) <= today;
        if (isUsed && existing && startOfDayUTC(existing.startDate).getTime() !== startDate.getTime()) {
          return res.status(400).json({ success: false, error: { code: 'START_LOCKED', message: 'A resource already in use cannot have its start date changed' } });
        }
        if (isUsed && endDate < today) {
          return res.status(400).json({ success: false, error: { code: 'PAST_LOCKED', message: 'A resource already in use cannot end before today' } });
        }
        if (!existing && startDate < today) {
          return res.status(400).json({ success: false, error: { code: 'PAST_ADD', message: 'New resources can only start from today onward' } });
        }
      }

      normalizedPlan.push({
        resourceId: new mongoose.Types.ObjectId(resourceId),
        startDate,
        endDate,
      });
    }

    if (isInProgress) {
      for (const rid of Object.keys(existingById)) {
        const existing = existingById[rid];
        const stillPresent = seenResource.has(rid);
        const isUsed = startOfDayUTC(existing.startDate) <= today;
        if (!stillPresent && isUsed) {
          return res.status(400).json({ success: false, error: { code: 'DELETE_USED', message: 'A resource already in use cannot be removed, only shortened' } });
        }
      }
    }

    let maxEnd = normalizedPlan[0].endDate;
    for (const entry of normalizedPlan) {
      if (entry.endDate > maxEnd) maxEnd = entry.endDate;
    }
    if (maxEnd <= bookingStart) {
      maxEnd = new Date(bookingStart.getTime() + 24 * 60 * 60 * 1000);
    }

    const previousExecutionEnd = booking.scheduledExecutionEndDate
      ? startOfDayUTC(booking.scheduledExecutionEndDate)
      : null;

    booking.resourcePlan = normalizedPlan as any;
    booking.assignedTeamMembers = normalizedPlan.map((p) => p.resourceId) as any;
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
