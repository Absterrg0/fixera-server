/**
 * Quotation Handlers
 * Handles RFQ response, quotation wizard submission, editing, customer response,
 * direct quotation creation, and version history.
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking, { IQuoteVersion, IQuotationMilestone, IBookingMilestone } from '../../models/booking';
import User from '../../models/user';
import Conversation from '../../models/conversation';
import ChatMessage from '../../models/chatMessage';
import PlatformSettings from '../../models/platformSettings';
import { addWorkingDays } from '../../utils/workingDays';
import { getNextSequence } from '../../utils/counterSequence';
import { createPaymentIntent } from '../Stripe/payment';
import {
  sendRfqAcceptedEmail,
  sendRfqRejectedEmail,
  sendQuotationReceivedEmail,
  sendQuotationUpdatedEmail,
  sendQuotationAcceptedEmail,
  sendQuotationRejectedEmail,
  sendDirectQuotationEmail,
} from '../../utils/emailService';
import { getProfessionalDisplayName } from '../../utils/displayName';
import { params } from '../../utils/requestParams';

const getSafeCommissionPercent = async (): Promise<number> => {
  try {
    const platformSettings = await PlatformSettings.getCurrentConfig();
    return platformSettings?.commissionPercent || 0;
  } catch (error) {
    console.error('Failed to load platform settings for quotation commission:', error);
    return 0;
  }
};

const formatQuotationValidDate = (validUntil: string): string => {
  const raw = String(validUntil || '').trim();
  const directDateMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directDateMatch) {
    return directDateMatch[1];
  }

  const validDate = new Date(raw);
  if (isNaN(validDate.getTime())) {
    return raw;
  }

  const year = validDate.getFullYear();
  const month = String(validDate.getMonth() + 1).padStart(2, '0');
  const day = String(validDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const sendQuotationChatMessage = async (
  booking: any,
  version: number,
  scope: string,
  totalAmount: number,
  currency: string,
  validUntil: string,
  isUpdate: boolean,
) => {
  try {
    const professionalId = booking.professional?._id || booking.professional;
    const customerId = booking.customer?._id || booking.customer;

    const conversation = await Conversation.findOne({
      professionalId: new mongoose.Types.ObjectId(professionalId.toString()),
      customerId: new mongoose.Types.ObjectId(customerId.toString()),
      status: 'active',
    });

    if (!conversation) return;

    const label = isUpdate ? 'Updated Quotation' : 'New Quotation';
    const validDateStr = formatQuotationValidDate(validUntil);
    const text = `${label}: ${booking.quotationNumber || ''} (v${version})\n\nScope: ${scope}\nAmount: ${currency} ${totalAmount.toFixed(2)}\nValid until: ${validDateStr}\n\nView and respond to this quotation in your bookings dashboard.`;

    await ChatMessage.create({
      conversationId: conversation._id,
      senderId: new mongoose.Types.ObjectId(professionalId.toString()),
      senderRole: 'professional',
      messageType: 'quotation_notification',
      text,
      quotationMeta: {
        bookingId: booking._id.toString(),
        quotationNumber: booking.quotationNumber || '',
        version,
        scope,
        totalAmount,
        currency,
        validUntil: validDateStr,
        status: 'quoted',
      },
    });

    conversation.lastMessageAt = new Date();
    await conversation.save();
  } catch (e) {
    console.error('Failed to send quotation chat message:', e);
  }
};

const getNextQuotationNumber = async (): Promise<string> => {
  const year = new Date().getFullYear();
  return getNextSequence(`quotationNumber-${year}`, `QT-${year}`);
};

const resolveLinkedSubprojectIndex = (
  linkedProject: any,
  requestedIndex: unknown
): number | undefined => {
  const subprojects = Array.isArray(linkedProject?.subprojects)
    ? linkedProject.subprojects
    : [];

  const parsedRequestedIndex =
    typeof requestedIndex === 'number'
      ? requestedIndex
      : typeof requestedIndex === 'string'
      ? Number.parseInt(requestedIndex, 10)
      : Number.NaN;

  if (
    Number.isInteger(parsedRequestedIndex) &&
    parsedRequestedIndex >= 0 &&
    parsedRequestedIndex < subprojects.length
  ) {
    return parsedRequestedIndex;
  }

  if (subprojects.length === 1) {
    return 0;
  }

  const rfqIndexes = subprojects.reduce((indexes: number[], subproject: any, index: number) => {
    if (subproject?.pricing?.type === 'rfq') {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (rfqIndexes.length === 1) {
    return rfqIndexes[0];
  }

  return undefined;
};

/**
 * Professional accept/reject RFQ
 * Accept sets rfqDeadline = addWorkingDays(now, 4), status → rfq_accepted
 */
export const respondToRFQ = async (req: Request, res: Response) => {
  try {
    const { bookingId } = params(req.params);
    const { action, rejectionReason } = req.body;
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!action || !['accepted', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ACTION', message: "Action must be 'accepted' or 'rejected'" } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email')
      .populate('professional', 'name username email businessInfo');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    // Verify professional
    if (booking.professional?._id?.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can respond to this RFQ' } });
    }

    if (booking.status !== 'rfq') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'RFQ can only be responded to when status is rfq' } });
    }

    const now = new Date();
    const customer = booking.customer as any;
    const professional = booking.professional as any;

    if (action === 'accepted') {
      booking.rfqResponse = { action: 'accepted', respondedAt: now };
      booking.rfqDeadline = addWorkingDays(now, 4);
      booking.status = 'rfq_accepted';
      booking.statusHistory.push({
        status: 'rfq_accepted',
        timestamp: now,
        updatedBy: new mongoose.Types.ObjectId(userId),
        note: 'Professional accepted the RFQ'
      });

      await booking.save();

      // Send email to customer
      try {
        await sendRfqAcceptedEmail(customer.email, customer.name, getProfessionalDisplayName(professional), booking._id.toString());
      } catch (e) {
        console.error('Failed to send RFQ accepted email:', e);
      }

      return res.json({
        success: true,
        data: {
          message: 'RFQ accepted. You have 4 working days to submit a quotation.',
          booking,
          rfqDeadline: booking.rfqDeadline,
        }
      });
    }

    // Rejected
    if (!rejectionReason) {
      return res.status(400).json({ success: false, error: { code: 'REASON_REQUIRED', message: 'Rejection reason is required' } });
    }

    booking.rfqResponse = { action: 'rejected', respondedAt: now, rejectionReason };
    booking.status = 'cancelled';
    booking.statusHistory.push({
      status: 'cancelled',
      timestamp: now,
      updatedBy: new mongoose.Types.ObjectId(userId),
      note: `Professional rejected the RFQ: ${rejectionReason}`
    });

    await booking.save();

    try {
      await sendRfqRejectedEmail(customer.email, customer.name, getProfessionalDisplayName(professional), rejectionReason);
    } catch (e) {
      console.error('Failed to send RFQ rejected email:', e);
    }

    return res.json({
      success: true,
      data: { message: 'RFQ rejected', booking }
    });
  } catch (error: any) {
    console.error('Error responding to RFQ:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Professional submits quotation via wizard
 * Pushes new IQuoteVersion, status → quoted
 */
export const submitQuotation = async (req: Request, res: Response) => {
  try {
    const { bookingId } = params(req.params);
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const {
      scope,
      warrantyDuration,
      materialsIncluded,
      materials,
      description,
      totalAmount,
      currency,
      milestones,
      preparationDuration,
      executionDuration,
      bufferDuration,
      validUntil,
      changeNote,
    } = req.body;

    // Validation
    if (!scope || scope.length < 10 || scope.length > 100) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Scope must be between 10 and 100 characters' } });
    }
    if (!description) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Description is required' } });
    }
    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Total amount must be greater than 0' } });
    }
    if (!warrantyDuration?.value || !warrantyDuration?.unit) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Warranty duration is required' } });
    }
    if (typeof materialsIncluded !== 'boolean') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Please specify whether materials are included' } });
    }
    if (!preparationDuration?.value || !preparationDuration?.unit) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Preparation duration is required' } });
    }
    if (!executionDuration?.value || !executionDuration?.unit) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Execution duration is required' } });
    }
    if (!validUntil) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Validity date is required' } });
    }

    // Validate milestones sum if provided
    if (milestones && milestones.length > 0) {
      const milestoneSum = milestones.reduce((sum: number, m: any) => sum + (m.amount || 0), 0);
      if (Math.abs(milestoneSum - totalAmount) > 0.01) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Sum of milestone amounts must equal total amount' } });
      }
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email')
      .populate('professional', 'name username email businessInfo');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.professional?._id?.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can submit a quotation' } });
    }

    if (!['rfq_accepted', 'draft_quote'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Quotation can only be submitted when status is rfq_accepted or draft_quote' } });
    }

    const now = new Date();
    const versionNumber = 1;

    const quoteVersion: any = {
      version: versionNumber,
      scope,
      warrantyDuration,
      materialsIncluded,
      materials: materialsIncluded ? materials : [],
      description,
      totalAmount,
      currency: currency || 'EUR',
      milestones: milestones ? milestones.map((m: any, i: number): IQuotationMilestone => ({
        title: m.title,
        description: m.description,
        amount: m.amount,
        dueCondition: m.dueDate ? 'custom_date' as const : (m.dueCondition || 'on_start'),
        customDueDate: m.dueDate ? new Date(m.dueDate) : m.customDueDate,
        order: i,
        status: 'pending',
      })) : [],
      preparationDuration,
      executionDuration,
      bufferDuration: bufferDuration || undefined,
      validUntil: new Date(validUntil),
      createdAt: now,
      changeNote: changeNote || 'Initial quotation',
    };

    booking.quoteVersions = [quoteVersion];
    booking.currentQuoteVersion = 1;
    booking.status = 'quoted';
    booking.statusHistory.push({
      status: 'quoted',
      timestamp: now,
      updatedBy: new mongoose.Types.ObjectId(userId),
      note: 'Quotation submitted by professional'
    });

    if (!booking.quotationNumber) {
      booking.quotationNumber = await getNextQuotationNumber();
    }
    booking.quoteVersions[0].quotationNumber = `${booking.quotationNumber}-v${versionNumber}`;

    await booking.save();

    const customer = booking.customer as any;
    const professional = booking.professional as any;

    try {
      const commissionPercent = await getSafeCommissionPercent();
      const customerAmount = +(totalAmount * (1 + commissionPercent / 100)).toFixed(2);
      const profDisplayName = getProfessionalDisplayName(professional);
      const isDirect = booking.rfqResponse === undefined || booking.rfqResponse === null;
      if (isDirect) {
        await sendDirectQuotationEmail(customer.email, customer.name, profDisplayName, booking.quotationNumber || '', customerAmount, booking._id.toString());
      } else {
        await sendQuotationReceivedEmail(customer.email, customer.name, profDisplayName, booking.quotationNumber || '', customerAmount, booking._id.toString());
      }
    } catch (e) {
      console.error('Failed to send quotation email:', e);
    }

    await sendQuotationChatMessage(booking, versionNumber, scope, totalAmount, currency || 'EUR', validUntil, false);

    return res.json({
      success: true,
      data: {
        message: 'Quotation submitted successfully',
        booking,
        quotationNumber: booking.quotationNumber,
      }
    });
  } catch (error: any) {
    console.error('Error submitting quotation:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Professional edits quotation (creates new version)
 * Allowed when status is quoted or quote_rejected
 */
export const editQuotation = async (req: Request, res: Response) => {
  try {
    const { bookingId } = params(req.params);
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const {
      scope,
      warrantyDuration,
      materialsIncluded,
      materials,
      description,
      totalAmount,
      currency,
      milestones,
      preparationDuration,
      executionDuration,
      bufferDuration,
      validUntil,
      changeNote,
    } = req.body;

    // Same validations as submitQuotation
    if (!scope || scope.length < 10 || scope.length > 100) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Scope must be between 10 and 100 characters' } });
    }
    if (!description) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Description is required' } });
    }
    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Total amount must be greater than 0' } });
    }
    if (!changeNote) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Change note is required when editing a quotation' } });
    }
    if (typeof materialsIncluded !== 'boolean') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Please specify whether materials are included' } });
    }

    if (milestones && milestones.length > 0) {
      const milestoneSum = milestones.reduce((sum: number, m: any) => sum + (m.amount || 0), 0);
      if (Math.abs(milestoneSum - totalAmount) > 0.01) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Sum of milestone amounts must equal total amount' } });
      }
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email')
      .populate('professional', 'name username email businessInfo');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.professional?._id?.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can edit the quotation' } });
    }

    if (!['quoted', 'quote_rejected'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Quotation can only be edited when status is quoted or quote_rejected' } });
    }

    const now = new Date();
    const newVersionNumber = (booking.quoteVersions?.length || 0) + 1;

    const quoteVersion: any = {
      version: newVersionNumber,
      quotationNumber: `${booking.quotationNumber}-v${newVersionNumber}`,
      scope,
      warrantyDuration,
      materialsIncluded,
      materials: materialsIncluded ? materials : [],
      description,
      totalAmount,
      currency: currency || 'EUR',
      milestones: milestones ? milestones.map((m: any, i: number): IQuotationMilestone => ({
        title: m.title,
        description: m.description,
        amount: m.amount,
        dueCondition: m.dueDate ? 'custom_date' as const : (m.dueCondition || 'on_start'),
        customDueDate: m.dueDate ? new Date(m.dueDate) : m.customDueDate,
        order: i,
        status: 'pending',
      })) : [],
      preparationDuration,
      executionDuration,
      bufferDuration: bufferDuration || undefined,
      validUntil: new Date(validUntil),
      createdAt: now,
      changeNote,
    };

    booking.quoteVersions.push(quoteVersion);
    booking.currentQuoteVersion = newVersionNumber;
    booking.status = 'quoted';
    booking.customerRejectionReason = undefined;
    booking.statusHistory.push({
      status: 'quoted',
      timestamp: now,
      updatedBy: new mongoose.Types.ObjectId(userId),
      note: `Quotation updated (v${newVersionNumber}): ${changeNote}`
    });

    await booking.save();

    const customer = booking.customer as any;
    const professional = booking.professional as any;

    try {
      await sendQuotationUpdatedEmail(customer.email, customer.name, getProfessionalDisplayName(professional), booking.quotationNumber || '', newVersionNumber, booking._id.toString());
    } catch (e) {
      console.error('Failed to send quotation updated email:', e);
    }

    await sendQuotationChatMessage(booking, newVersionNumber, scope, totalAmount, currency || 'EUR', validUntil, true);

    return res.json({
      success: true,
      data: {
        message: `Quotation updated to version ${newVersionNumber}`,
        booking,
        version: newVersionNumber,
      }
    });
  } catch (error: any) {
    console.error('Error editing quotation:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Customer accepts or rejects a quotation
 * Accept → copies milestones, status → quote_accepted, creates payment intent
 * Reject → requires reason, status → quote_rejected
 */
export const customerRespondToQuotation = async (req: Request, res: Response) => {
  try {
    const { bookingId } = params(req.params);
    const { action, rejectionReason } = req.body;
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!action || !['accepted', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ACTION', message: "Action must be 'accepted' or 'rejected'" } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email')
      .populate('professional', 'name username email businessInfo');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.customer._id.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer can respond to quotations' } });
    }

    if (booking.status !== 'quoted') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Can only respond to quotations when status is quoted' } });
    }

    const now = new Date();
    const currentVersion = booking.quoteVersions?.find(v => v.version === booking.currentQuoteVersion);
    const customer = booking.customer as any;
    const professional = booking.professional as any;

    if (action === 'rejected') {
      if (!rejectionReason) {
        return res.status(400).json({ success: false, error: { code: 'REASON_REQUIRED', message: 'Rejection reason is required' } });
      }

      booking.status = 'quote_rejected';
      booking.customerRejectionReason = rejectionReason;
      booking.statusHistory.push({
        status: 'quote_rejected',
        timestamp: now,
        updatedBy: new mongoose.Types.ObjectId(userId),
        note: `Customer rejected quotation: ${rejectionReason}`
      });

      await booking.save();

      try {
        await sendQuotationRejectedEmail(professional.email, getProfessionalDisplayName(professional), customer.name, booking.quotationNumber || '', rejectionReason);
      } catch (e) {
        console.error('Failed to send quotation rejected email:', e);
      }

      return res.json({
        success: true,
        data: { message: 'Quotation rejected', booking }
      });
    }

    // Accept
    // Copy milestones from current version to booking milestonePayments
    if (currentVersion?.milestones && currentVersion.milestones.length > 0) {
      booking.milestonePayments = currentVersion.milestones.map(m => ({
        title: m.title,
        amount: m.amount,
        description: m.description,
        dueCondition: m.dueCondition,
        customDueDate: m.customDueDate,
        order: m.order,
        status: 'pending' as const,
        workStatus: 'pending',
      }));
    }

    // Also populate legacy quote field for backward compat with payment system
    const baseAmount = currentVersion?.totalAmount || 0
    booking.quote = {
      amount: baseAmount,
      currency: currentVersion?.currency || 'EUR',
      description: currentVersion?.description,
      validUntil: currentVersion?.validUntil,
      submittedAt: currentVersion?.createdAt || now,
      submittedBy: booking.professional!._id,
    };

    booking.status = 'quote_accepted';
    booking.statusHistory.push({
      status: 'quote_accepted',
      timestamp: now,
      updatedBy: new mongoose.Types.ObjectId(userId),
      note: 'Customer accepted quotation'
    });

    await booking.save();

    try {
      await sendQuotationAcceptedEmail(professional.email, getProfessionalDisplayName(professional), customer.name, booking.quotationNumber || '', booking._id.toString());
    } catch (e) {
      console.error('Failed to send quotation accepted email:', e);
    }

    return res.json({
      success: true,
      data: {
        message: 'Quotation accepted. Please complete the booking wizard to select your start date and proceed to payment.',
        booking,
        requiresBookingWizard: true,
      }
    });
  } catch (error: any) {
    console.error('Error responding to quotation:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Professional creates a direct quotation (entry point 1.2)
 * Creates a new booking in draft_quote status
 */
export const createDirectQuotation = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id?.toString();
    const { customerId, projectId, selectedSubprojectIndex } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid customer ID is required' } });
    }

    const [professional, customer] = await Promise.all([
      User.findById(userId),
      User.findById(customerId),
    ]);

    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only professionals can create direct quotations' } });
    }

    if (!customer || customer.role !== 'customer') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_CUSTOMER', message: 'Customer not found' } });
    }

    if (!customer.location || !customer.location.coordinates || customer.location.coordinates.length !== 2) {
      return res.status(400).json({ success: false, error: { code: 'NO_LOCATION', message: 'Customer does not have a location set' } });
    }

    let linkedProject: any = null;
    if (projectId) {
      if (!mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid project ID format' } });
      }
    }
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      const { default: Project } = await import('../../models/project');
      linkedProject = await Project.findById(projectId).select('title subprojects professionalId status');
      if (!linkedProject) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_PROJECT', message: 'Project not found' } });
      }
      if (linkedProject.professionalId?.toString() !== userId) {
        return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'You can only link to your own projects' } });
      }
      if (linkedProject.status !== 'published') {
        return res.status(400).json({ success: false, error: { code: 'PROJECT_NOT_PUBLISHED', message: 'Project must be published to link a quotation' } });
      }

      if (typeof selectedSubprojectIndex !== 'undefined') {
        const parsedIdx = typeof selectedSubprojectIndex === 'number'
          ? selectedSubprojectIndex
          : typeof selectedSubprojectIndex === 'string'
          ? Number.parseInt(selectedSubprojectIndex, 10)
          : Number.NaN;

        if (
          !Number.isInteger(parsedIdx) ||
          parsedIdx < 0 ||
          !Array.isArray(linkedProject.subprojects) ||
          parsedIdx >= linkedProject.subprojects.length
        ) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_SUBPROJECT', message: 'Invalid subproject index' } });
        }
      }
    }

    const resolvedSubprojectIndex = linkedProject
      ? resolveLinkedSubprojectIndex(linkedProject, selectedSubprojectIndex)
      : undefined;

    const bookingData: any = {
      customer: customerId,
      professional: userId,
      bookingType: linkedProject ? 'project' : 'professional',
      status: 'draft_quote',
      ...(linkedProject && { project: linkedProject._id }),
      ...(typeof resolvedSubprojectIndex === 'number'
        ? { selectedSubprojectIndex: resolvedSubprojectIndex }
        : {}),
      location: {
        type: 'Point',
        coordinates: customer.location.coordinates,
        address: customer.location.address,
        city: customer.location.city,
        country: customer.location.country,
        postalCode: customer.location.postalCode,
      },
      rfqData: {
        serviceType: linkedProject?.title || 'Direct Quotation',
        description: linkedProject
          ? `Direct quotation for project: ${linkedProject.title}`
          : `Direct quotation from ${professional.username || professional.name}`,
        answers: [],
      },
      statusHistory: [{
        status: 'draft_quote',
        timestamp: new Date(),
        updatedBy: new mongoose.Types.ObjectId(userId),
        note: linkedProject
          ? `Professional-initiated quotation linked to project: ${linkedProject.title}`
          : 'Professional-initiated direct quotation',
      }],
    };

    const booking = await Booking.create(bookingData);

    return res.status(201).json({
      success: true,
      data: {
        message: 'Direct quotation draft created',
        bookingId: booking._id.toString(),
        booking,
      }
    });
  } catch (error: any) {
    console.error('Error creating direct quotation:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Get list of customers with active conversations for this professional
 */
export const getActiveCustomers = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const conversations = await Conversation.find({
      professionalId: new mongoose.Types.ObjectId(userId),
      status: 'active',
    })
      .populate('customerId', 'name email phone customerType location')
      .sort({ lastMessageAt: -1 });

    const customers = conversations
      .map((conv: any) => conv.customerId)
      .filter(Boolean)
      // Deduplicate by _id
      .filter((customer: any, index: number, arr: any[]) =>
        arr.findIndex((c: any) => c._id.toString() === customer._id.toString()) === index
      );

    return res.json({
      success: true,
      data: { customers }
    });
  } catch (error: any) {
    console.error('Error getting active customers:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Get active projects for this professional (for linking direct quotes)
 */
export const getActiveProjects = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const { default: Project } = await import('../../models/project');
    const projects = await Project.find({
      professionalId: new mongoose.Types.ObjectId(userId),
      status: 'published',
    })
      .select('title category service subprojects')
      .sort({ createdAt: -1 })
      .limit(50);

    return res.json({ success: true, data: { projects } });
  } catch (error: any) {
    console.error('Error getting active projects:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Get all quote versions for a booking
 */
export const getQuotationVersions = async (req: Request, res: Response) => {
  try {
    const { bookingId } = params(req.params);
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const booking = await Booking.findById(bookingId).select('quoteVersions currentQuoteVersion quotationNumber customer professional');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    // Authorization: customer or professional
    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authorized to view this quotation' } });
    }

    return res.json({
      success: true,
      data: {
        quotationNumber: booking.quotationNumber,
        currentVersion: booking.currentQuoteVersion,
        versions: booking.quoteVersions || [],
      }
    });
  } catch (error: any) {
    console.error('Error getting quotation versions:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Professional updates milestone work status
 */
export const updateMilestoneWorkStatus = async (req: Request, res: Response) => {
  try {
    const { bookingId, index } = params(req.params);
    const { action } = req.body;
    const milestoneIndex = parseInt(index, 10);
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (isNaN(milestoneIndex) || milestoneIndex < 0) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INDEX', message: 'Invalid milestone index' } });
    }

    if (!action || !['start', 'complete'].includes(action)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ACTION', message: "Action must be 'start' or 'complete'" } });
    }

    const booking = await Booking.findById(bookingId)
      .select('professional status actualStartDate milestonePayments statusHistory bookingType project')
      .populate('project', 'professionalId');
    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    const isAuthorized = booking.bookingType === 'project'
      ? (booking.project as any)?.professionalId?.toString() === userId
      : booking.professional?.toString() === userId;
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can update milestone progress' } });
    }

    if (!['booked', 'in_progress'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Milestone progress can only be updated when booking is booked or in progress' } });
    }

    if (!booking.milestonePayments || milestoneIndex >= booking.milestonePayments.length) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_MILESTONE', message: 'Milestone not found' } });
    }

    const milestone = booking.milestonePayments[milestoneIndex];
    const previousMilestones = booking.milestonePayments.slice(0, milestoneIndex);
    const now = new Date();

    if (milestone.workStatus === 'completed') {
      return res.status(400).json({ success: false, error: { code: 'MILESTONE_ALREADY_COMPLETED', message: 'Completed milestones cannot be modified' } });
    }

    if (action === 'start') {
      const hasIncompletePrevious = previousMilestones.some((item) => item.workStatus !== 'completed');
      if (hasIncompletePrevious) {
        return res.status(400).json({ success: false, error: { code: 'PREVIOUS_INCOMPLETE', message: 'Previous milestones must be completed first' } });
      }

      milestone.workStatus = 'in_progress';
      milestone.startedAt = milestone.startedAt || now;

      if (booking.status === 'booked') {
        booking.status = 'in_progress';
        booking.actualStartDate = booking.actualStartDate || now;
        booking.statusHistory.push({
          status: 'in_progress',
          timestamp: now,
          updatedBy: new mongoose.Types.ObjectId(userId),
          note: `Milestone started: ${milestone.title}`,
        });
      }
    }

    if (action === 'complete') {
      if (milestone.workStatus !== 'in_progress') {
        return res.status(400).json({ success: false, error: { code: 'MILESTONE_NOT_STARTED', message: 'Start the milestone before marking it complete' } });
      }

      milestone.workStatus = 'completed';
      milestone.startedAt = milestone.startedAt || now;
      milestone.completedAt = milestone.completedAt || now;

      const allCompleted = booking.milestonePayments.every((m) => m.workStatus === 'completed');
      if (allCompleted && booking.status === 'in_progress') {
        booking.status = 'professional_completed';
        booking.professionalCompletedAt = now;
        booking.statusHistory.push({
          status: 'professional_completed',
          timestamp: now,
          updatedBy: new mongoose.Types.ObjectId(userId),
          note: 'All milestones completed',
        });
      }
    }

    await booking.save();

    return res.json({
      success: true,
      data: {
        message: action === 'start' ? 'Milestone started successfully' : 'Milestone completed successfully',
        milestone: booking.milestonePayments[milestoneIndex],
        booking,
      }
    });
  } catch (error: any) {
    console.error('Error updating milestone work status:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to update milestone progress' } });
  }
};

/**
 * Get milestone payment status for a booking
 */
export const getMilestonePaymentStatus = async (req: Request, res: Response) => {
  try {
    const { bookingId } = params(req.params);
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const booking = await Booking.findById(bookingId).select('milestonePayments customer professional status');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authorized' } });
    }

    const milestones = booking.milestonePayments || [];
    const totalAmount = milestones.reduce((sum, m) => sum + m.amount, 0);
    const paidAmount = milestones.filter(m => m.status === 'paid').reduce((sum, m) => sum + m.amount, 0);
    const workCompletedAmount = milestones
      .filter((m: IBookingMilestone) => m.workStatus === 'completed')
      .reduce((sum, m) => sum + m.amount, 0);

    return res.json({
      success: true,
      data: {
        milestones,
        totalAmount,
        paidAmount,
        remainingAmount: totalAmount - paidAmount,
        progress: totalAmount > 0 ? Math.round((paidAmount / totalAmount) * 100) : 0,
        workProgress: totalAmount > 0 ? Math.round((workCompletedAmount / totalAmount) * 100) : 0,
      }
    });
  } catch (error: any) {
    console.error('Error getting milestone status:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};

/**
 * Create payment intent for a specific milestone
 */
export const createMilestonePaymentIntent = async (req: Request, res: Response) => {
  try {
    const { bookingId, index } = params(req.params);
    const milestoneIndex = parseInt(index, 10);
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (isNaN(milestoneIndex) || milestoneIndex < 0) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INDEX', message: 'Invalid milestone index' } });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.customer.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer can pay milestones' } });
    }

    if (!booking.milestonePayments || milestoneIndex >= booking.milestonePayments.length) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_MILESTONE', message: 'Milestone not found' } });
    }

    const milestone = booking.milestonePayments[milestoneIndex];

    if (milestone.status === 'paid') {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_PAID', message: 'This milestone is already paid' } });
    }

    const paymentResult = await createPaymentIntent(booking._id.toString(), userId, 0, milestoneIndex);

    if (!paymentResult.success) {
      return res.status(400).json({ success: false, error: paymentResult.error });
    }

    // Store payment intent on milestone only after successful payment
    booking.milestonePayments[milestoneIndex].stripePaymentIntentId = paymentResult.paymentIntentId;
    booking.milestonePayments[milestoneIndex].stripeClientSecret = paymentResult.clientSecret;
    await booking.save();

    return res.json({
      success: true,
      data: {
        clientSecret: paymentResult.clientSecret,
        milestone: booking.milestonePayments[milestoneIndex],
      }
    });
  } catch (error: any) {
    console.error('Error creating milestone payment intent:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process request' } });
  }
};
