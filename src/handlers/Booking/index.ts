import { Request, Response, NextFunction } from "express";
import Booking, { IBooking, BookingStatus } from "../../models/booking";
import Payment from "../../models/payment";
import User from "../../models/user";
import Project from "../../models/project";
import mongoose from "mongoose";
import {
  buildProjectScheduleWindow,
  validateProjectScheduleSelection,
} from "../../utils/scheduleEngine";
import { presignS3Url, uploadToS3, generateFileName } from "../../utils/s3Upload";
import { resolveSubprojectIndex } from "../../utils/bookingHelpers";
import { sendBookingCancelledEmail, sendCancellationRequestRaisedEmail } from "../../utils/emailService";
import { getProfessionalDisplayName } from "../../utils/displayName";
import CancellationRequest, { ACTIVE_CANCELLATION_STATUSES, CANCELLATION_REASON_CATEGORIES, CANCELLATION_REASON_LABELS, CancellationReasonCategory } from "../../models/cancellationRequest";
import { addBusinessDays, REFUND_RESPONSE_BUSINESS_DAYS } from "../../utils/businessDays";

const presignMaybeS3Url = async (url?: string | null) => {
  if (!url) return url;
  const signed = await presignS3Url(url);
  return signed ?? url;
};

const normalizeRfqAnswers = (answers: any[] | undefined) => {
  if (!Array.isArray(answers)) {
    return [];
  }

  return answers.filter((answer) => {
    if (answer == null) return false;
    const q = answer.question || "";
    const a = typeof answer.answer === "string" ? answer.answer.trim() : String(answer.answer ?? "").trim();
    return q && a;
  }).map((answer) => {
    const normalizedAnswer: Record<string, any> = {
      questionId: answer?.questionId,
      question: answer?.question || "",
      answer: typeof answer?.answer === "string" ? answer.answer : String(answer?.answer ?? ""),
    };

    const rawFieldType = typeof answer?.fieldType === "string" ? answer.fieldType : undefined;
    const rawType = typeof answer?.type === "string" ? answer.type : undefined;
    const resolvedType = rawFieldType || rawType;

    if (resolvedType === "attachment" || resolvedType === "file") {
      normalizedAnswer.fieldType = "file";
    } else if (resolvedType === "text") {
      normalizedAnswer.fieldType = "text";
    } else if (resolvedType === "number") {
      normalizedAnswer.fieldType = "number";
    } else if (resolvedType === "date") {
      normalizedAnswer.fieldType = "date";
    } else if (resolvedType === "dropdown" || resolvedType === "checkbox") {
      normalizedAnswer.fieldType = resolvedType;
    }

    return normalizedAnswer;
  });
};

const presignBookingFiles = async (bookingDoc: any) => {
  const booking = bookingDoc?.toObject ? bookingDoc.toObject() : { ...bookingDoc };

  if (Array.isArray(booking?.rfqData?.attachments) && booking.rfqData.attachments.length > 0) {
    booking.rfqData.attachments = await Promise.all(
      booking.rfqData.attachments.map((url: string) => presignMaybeS3Url(url))
    );
  }

  if (Array.isArray(booking?.rfqData?.answers) && booking.rfqData.answers.length > 0) {
    booking.rfqData.answers = await Promise.all(
      booking.rfqData.answers.map(async (answer: any) => {
        const val = typeof answer?.answer === 'string' ? answer.answer : '';
        const isFileType = answer?.fieldType === 'file' || answer?.type === 'file' || answer?.type === 'attachment';
        if (isFileType) {
          return { ...answer, answer: await presignMaybeS3Url(val) };
        }
        return answer;
      })
    );
  }

  if (Array.isArray(booking?.postBookingData) && booking.postBookingData.length > 0) {
    booking.postBookingData = await Promise.all(
      booking.postBookingData.map(async (answer: any) => ({
        ...answer,
        answer: await presignMaybeS3Url(answer?.answer),
      }))
    );
  }

  if (Array.isArray(booking?.customerReview?.images) && booking.customerReview.images.length > 0) {
    booking.customerReview.images = await Promise.all(
      booking.customerReview.images.map((url: string) => presignMaybeS3Url(url))
    );
  }

  if (Array.isArray(booking?.completionAttestation?.attachments) && booking.completionAttestation.attachments.length > 0) {
    booking.completionAttestation.attachments = await Promise.all(
      booking.completionAttestation.attachments.map((url: string) => presignMaybeS3Url(url))
    );
  }

  return booking;
};

// Create a new booking (RFQ submission)
export const createBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id; // From auth middleware
    const {
      bookingType, // 'professional' or 'project'
      professionalId,
      projectId,
      rfqData, // Service type, description, answers, budget, etc.
      preferredStartDate,
      preferredStartTime,
      selectedSubprojectIndex,
      urgency,
      customerBlocks,
      estimatedUsage,
      selectedExtraOptions,
      paymentAtCheckout,
    } = req.body;
    const paymentAtCheckoutRequested =
      paymentAtCheckout === true ||
      paymentAtCheckout === 1 ||
      paymentAtCheckout === "1" ||
      paymentAtCheckout === "true";

    // Validate required fields
    if (!bookingType || (bookingType !== 'professional' && bookingType !== 'project')) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking type. Must be 'professional' or 'project'"
      });
    }

    if (bookingType === 'professional' && !professionalId) {
      return res.status(400).json({
        success: false,
        msg: "Professional ID is required for professional bookings"
      });
    }

    if (bookingType === 'project' && !projectId) {
      return res.status(400).json({
        success: false,
        msg: "Project ID is required for project bookings"
      });
    }

    if (bookingType === "professional" && paymentAtCheckoutRequested) {
      return res.status(400).json({
        success: false,
        msg: "paymentAtCheckout is not allowed for professional bookings",
      });
    }

    if (!rfqData || !rfqData.serviceType || !rfqData.description) {
      return res.status(400).json({
        success: false,
        msg: "RFQ data with service type and description is required"
      });
    }

    // Get customer details with location
    const customer = await User.findById(userId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        msg: "Customer not found"
      });
    }

    if (customer.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "Only customers can create bookings"
      });
    }

    // Validate customer has location set
    if (!customer.location || !customer.location.coordinates || customer.location.coordinates.length !== 2) {
      return res.status(400).json({
        success: false,
        msg: "Customer location is required. Please update your profile with your address."
      });
    }

    // Create booking payload (base fields)
    const bookingData: any = {
      customer: userId,
      bookingType,
      status: 'rfq',
      location: {
        type: 'Point',
        coordinates: customer.location.coordinates,
        address: customer.location.address,
        city: customer.location.city,
        country: customer.location.country,
        postalCode: customer.location.postalCode
      },
      rfqData: {
        serviceType: rfqData.serviceType,
        description: rfqData.description,
        answers: normalizeRfqAnswers(rfqData.answers),
        preferredStartDate: preferredStartDate || rfqData.preferredStartDate,
        urgency: urgency || rfqData.urgency || 'medium',
        budget: rfqData.budget,
        attachments: rfqData.attachments || []
      }
    };

    if (customerBlocks) {
      bookingData.customerBlocks = customerBlocks;
    }

    // Validate professional or project exists
    if (bookingType === 'professional') {
      const professional = await User.findById(professionalId);
      if (!professional || professional.role !== 'professional') {
        return res.status(404).json({
          success: false,
          msg: "Professional not found"
        });
      }

      if (professional.professionalStatus !== 'approved') {
        return res.status(400).json({
          success: false,
          msg: "Professional is not approved to accept bookings"
        });
      }

      bookingData.professional = professionalId;
    } else {
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({
          success: false,
          msg: "Project not found"
        });
      }

      if (project.status !== 'published') {
        return res.status(400).json({
          success: false,
          msg: "Project is not available for booking"
        });
      }

      bookingData.project = projectId;
      bookingData.professional = project.professionalId;

      let fallbackTeamMembers: mongoose.Types.ObjectId[] | null = null;
      let normalizedProjectResourceIds: string[] = [];
      // Validate and normalize resource IDs, filtering out invalid entries and duplicates
      if (project.resources && Array.isArray(project.resources) && project.resources.length > 0) {
        const seenIds = new Set<string>();
        const validTeamMembers: mongoose.Types.ObjectId[] = [];

        for (const id of project.resources) {
          // Skip null/undefined values
          if (id == null) continue;

          // Convert to string for validation and deduplication
          const idStr = typeof id === 'string' ? id : String(id);

          // Validate the ID format
          if (!mongoose.isValidObjectId(idStr)) continue;

          // Skip duplicates
          if (seenIds.has(idStr)) continue;

          seenIds.add(idStr);
          normalizedProjectResourceIds.push(idStr);
          validTeamMembers.push(new mongoose.Types.ObjectId(idStr));
        }

        if (validTeamMembers.length > 0) {
          fallbackTeamMembers = validTeamMembers;
        }
      }

      if (
        !Array.isArray(project.resources) ||
        project.resources.length === 0 ||
        normalizedProjectResourceIds.length === 0
      ) {
        return res.status(400).json({
          success: false,
          msg: "Project has no valid team resources configured",
        });
      }

      const rawStartDate =
        preferredStartDate || rfqData?.preferredStartDate || undefined;
      const rawStartTime =
        preferredStartTime || rfqData?.preferredStartTime || undefined;
      const normalizedStartDate =
        typeof rawStartDate === "string"
          ? /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate)
            ? rawStartDate
            : (() => {
                const parsed = new Date(rawStartDate);
                if (Number.isNaN(parsed.getTime())) return rawStartDate;
                return parsed.toISOString().slice(0, 10);
              })()
          : undefined;

      const subprojectIndex = resolveSubprojectIndex(
        project.subprojects,
        selectedSubprojectIndex
      );

      if (
        typeof subprojectIndex !== 'number' &&
        Array.isArray(project.subprojects) &&
        project.subprojects.length > 1
      ) {
        return res.status(400).json({
          success: false,
          msg: 'Please select a subproject/package before booking',
        });
      }

      const isRfqSubproject =
        typeof subprojectIndex === "number" &&
        Array.isArray(project.subprojects) &&
        subprojectIndex >= 0 &&
        subprojectIndex < project.subprojects.length &&
        (project.subprojects[subprojectIndex] as any)?.pricing?.type === "rfq";

      if (!isRfqSubproject) {
        const validation = await validateProjectScheduleSelection({
          projectId,
          subprojectIndex,
          startDate: normalizedStartDate,
          startTime: typeof rawStartTime === "string" ? rawStartTime : undefined,
          customerBlocks,
        });

        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            msg: validation.reason || "Selected schedule is not available",
          });
        }
      }

      if (normalizedStartDate && !isRfqSubproject) {
        const window = await buildProjectScheduleWindow({
          projectId,
          subprojectIndex,
          startDate: normalizedStartDate,
          startTime: typeof rawStartTime === "string" ? rawStartTime : undefined,
          customerBlocks,
        });

        if (!window) {
          return res.status(400).json({
            success: false,
            msg: "Unable to schedule the selected window",
          });
        }

        bookingData.scheduledStartDate = window.scheduledStartDate;
        if (window.scheduledExecutionEndDate) {
          bookingData.scheduledExecutionEndDate = window.scheduledExecutionEndDate;
        }
        if (window.scheduledBufferStartDate) {
          bookingData.scheduledBufferStartDate = window.scheduledBufferStartDate;
        }
        if (window.scheduledBufferEndDate) {
          bookingData.scheduledBufferEndDate = window.scheduledBufferEndDate;
        }
        if (window.scheduledBufferUnit) {
          bookingData.scheduledBufferUnit = window.scheduledBufferUnit;
        }
        if (window.scheduledStartTime) {
          bookingData.scheduledStartTime = window.scheduledStartTime;
        }
        if (window.scheduledEndTime) {
          bookingData.scheduledEndTime = window.scheduledEndTime;
        }
        if (window.assignedTeamMembers && window.assignedTeamMembers.length > 0) {
          bookingData.assignedTeamMembers = window.assignedTeamMembers;
        }
      }

      if (!bookingData.assignedTeamMembers && fallbackTeamMembers) {
        bookingData.assignedTeamMembers = fallbackTeamMembers;
      }

      if (
        !isRfqSubproject &&
        (!Array.isArray(bookingData.assignedTeamMembers) ||
        bookingData.assignedTeamMembers.length === 0)
      ) {
        return res.status(400).json({
          success: false,
          msg: "Unable to create booking because no team resources are available",
        });
      }

      if (typeof subprojectIndex === "number") {
        bookingData.selectedSubprojectIndex = subprojectIndex;
      }

      if (
        typeof subprojectIndex === "number" &&
        Array.isArray(project.subprojects) &&
        subprojectIndex >= 0 &&
        subprojectIndex < project.subprojects.length
      ) {
        const selectedSubproject = project.subprojects[subprojectIndex] as any;
        const warrantyValue = Number(selectedSubproject?.warrantyPeriod?.value || 0);
        const warrantyUnit = selectedSubproject?.warrantyPeriod?.unit;
        if (
          Number.isFinite(warrantyValue) &&
          warrantyValue >= 0 &&
          (warrantyUnit === "months" || warrantyUnit === "years")
        ) {
          bookingData.warrantyCoverage = {
            duration: {
              value: warrantyValue,
              unit: warrantyUnit,
            },
            source: "project_subproject",
          };
        }
      }

      const wantsPaymentAtCheckout = paymentAtCheckoutRequested;
      if (wantsPaymentAtCheckout) {
        if (
          typeof subprojectIndex !== "number" ||
          !Array.isArray(project.subprojects) ||
          subprojectIndex < 0 ||
          subprojectIndex >= project.subprojects.length
        ) {
          return res.status(400).json({
            success: false,
            msg: "A valid package selection is required for checkout payment",
          });
        }

        const selectedSubproject = project.subprojects[subprojectIndex] as any;
        const pricingType = selectedSubproject?.pricing?.type;
        const baseUnitAmount = Number(selectedSubproject?.pricing?.amount);

        if (pricingType === "rfq") {
          return res.status(400).json({
            success: false,
            msg: "RFQ packages cannot be paid at checkout",
          });
        }

        if (!Number.isFinite(baseUnitAmount) || baseUnitAmount < 0) {
          return res.status(400).json({
            success: false,
            msg: "Selected package does not have a valid checkout price",
          });
        }

        let computedCheckoutAmount = baseUnitAmount;
        const usageQuantityRaw =
          typeof estimatedUsage === "number"
            ? estimatedUsage
            : typeof estimatedUsage === "string"
              ? Number.parseFloat(estimatedUsage)
              : Number.NaN;
        const normalizedUsageQuantity =
          pricingType === "unit" && Number.isFinite(usageQuantityRaw)
            ? usageQuantityRaw
            : 1;
        if (pricingType === "unit") {
          if (!Number.isFinite(normalizedUsageQuantity) || normalizedUsageQuantity <= 0) {
            return res.status(400).json({
              success: false,
              msg: "Estimated usage is required for unit-priced checkout payments",
            });
          }

          computedCheckoutAmount = baseUnitAmount * normalizedUsageQuantity;
        }

        const normalizedExtraOptionIndexes = Array.isArray(selectedExtraOptions)
          ? Array.from(
              new Set(
                selectedExtraOptions
                  .map((value: unknown) =>
                    typeof value === "number"
                      ? value
                      : typeof value === "string"
                        ? Number.parseInt(value, 10)
                        : Number.NaN
                  )
                  .filter(
                    (index: number) =>
                      Number.isInteger(index) &&
                      index >= 0 &&
                      Array.isArray(project.extraOptions) &&
                      index < project.extraOptions.length
                  )
              )
            )
          : [];

        let extraOptionsTotal = 0;
        const selectedOptionsPrices: Array<{
          index: number;
          name: string;
          unitPrice: number;
          quantity: number;
          totalPrice: number;
        }> = [];
        for (const optionIndex of normalizedExtraOptionIndexes) {
          const option = project.extraOptions?.[optionIndex];
          if (option && typeof option.price === "number") {
            extraOptionsTotal += option.price;
            selectedOptionsPrices.push({
              index: optionIndex,
              name: option.name || `Option ${optionIndex}`,
              unitPrice: option.price,
              quantity: 1,
              totalPrice: option.price,
            });
            computedCheckoutAmount += option.price;
          }
        }

        const basePackageSubtotal = Math.round(
          (baseUnitAmount * normalizedUsageQuantity + Number.EPSILON) * 100
        ) / 100;
        const discountsTotal = 0;
        const taxesTotal = 0;
        const roundedCheckoutAmount =
          Math.round((computedCheckoutAmount + Number.EPSILON) * 100) / 100;
        if (!(roundedCheckoutAmount > 0)) {
          return res.status(400).json({
            success: false,
            msg: "Checkout payment requires a positive total amount",
          });
        }

        if (normalizedExtraOptionIndexes.length > 0) {
          bookingData.selectedExtraOptions = normalizedExtraOptionIndexes.map((idx: number) => {
            const opt = project.extraOptions[idx];
            return { extraOptionId: (opt as any)._id.toString(), bookedPrice: opt.price };
          });
        }

        bookingData.quote = {
          amount: roundedCheckoutAmount,
          currency: "EUR",
          description: `Auto-generated checkout quote for ${project.title}`,
          breakdown: [
            {
              item: `checkout_snapshot:selected_package_index:${subprojectIndex}`,
              quantity: 1,
              unitPrice: 0,
              totalPrice: 0,
            },
            {
              item: `checkout_snapshot:selected_package_type:${pricingType}`,
              quantity: 1,
              unitPrice: 0,
              totalPrice: 0,
            },
            {
              item: "Package Base",
              quantity: normalizedUsageQuantity,
              unitPrice: baseUnitAmount,
              totalPrice: basePackageSubtotal,
            },
            ...selectedOptionsPrices.map((option) => ({
              item: `Extra Option #${option.index}: ${option.name}`,
              quantity: option.quantity,
              unitPrice: option.unitPrice,
              totalPrice: option.totalPrice,
            })),
            {
              item: "checkout_snapshot:selected_options_total",
              quantity: selectedOptionsPrices.length,
              unitPrice: selectedOptionsPrices.length > 0 ? extraOptionsTotal : 0,
              totalPrice: extraOptionsTotal,
            },
            {
              item: "checkout_snapshot:discounts_total",
              quantity: 1,
              unitPrice: discountsTotal,
              totalPrice: discountsTotal,
            },
            {
              item: "checkout_snapshot:taxes_total",
              quantity: 1,
              unitPrice: taxesTotal,
              totalPrice: taxesTotal,
            },
            {
              item: "checkout_snapshot:computed_total",
              quantity: 1,
              unitPrice: roundedCheckoutAmount,
              totalPrice: roundedCheckoutAmount,
            },
          ],
          submittedAt: new Date(),
        };
        bookingData.status = "quote_accepted";
      }
    }

    let booking: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        booking = await Booking.create(bookingData);
        break;
      } catch (err: any) {
        if (err.code === 11000 && (err.keyPattern?.bookingNumber || err.keyPattern?.quotationNumber) && attempt < 2) {
          continue;
        }
        throw err;
      }
    }

    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' },
      { path: 'project', select: 'title description pricing' }
    ]);

    return res.status(201).json({
      success: true,
      msg:
        booking.status === "quote_accepted"
          ? "Booking created. Proceed to payment."
          : "Booking request created successfully",
      booking
    });

  } catch (error: any) {
    console.error('Create booking error:', error);

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({
        success: false,
        msg: messages.join(', ')
      });
    }

    next(error);
  }
};

// Upload RFQ attachment (max 10MB, images/PDFs/docs)
export const uploadRFQAttachment = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, msg: 'No file uploaded' });
    }

    if (file.size > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, msg: 'File must be less than 10MB' });
    }

    const fileName = generateFileName(file.originalname, userId.toString(), 'rfq-attachments');
    const result = await uploadToS3(file, fileName);

    return res.json({
      success: true,
      data: {
        url: result.url,
        key: result.key,
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
      },
    });
  } catch (error) {
    console.error('RFQ attachment upload error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to upload attachment' });
  }
};

// Get bookings for current user (customer or professional)
export const getMyBookings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { status, page, limit, service, search, addressFilter, customerNameFilter } = req.query;
    const parsedPage = Math.max(1, Math.floor(Number(page) || 1));
    const parsedLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    const query: any = {};
    let professionalProjectIds: any[] | null = null;

    // Build query based on user role
    if (user.role === 'customer') {
      query.customer = userId;
    } else if (user.role === 'professional') {
      const projectIds = await Project.find({
        professionalId: userId,
      }).select("_id");
      professionalProjectIds = projectIds.map((project) => project._id);
      query.$or = [
        { professional: userId },
        { project: { $in: professionalProjectIds } },
      ];
    } else {
      return res.status(403).json({
        success: false,
        msg: "Only customers and professionals can view bookings"
      });
    }

    // Filter by status if provided (supports comma-separated for multiple statuses)
    if (status && typeof status === 'string') {
      if (status.includes(',')) {
        query.status = { $in: status.split(',').map(s => s.trim()) };
      } else {
        query.status = status;
      }
    }

    // Filter by service type — match project.service OR rfqData.serviceType.
    // Combined via $and so the role-based $or above is preserved.
    if (service && typeof service === 'string') {
      const matchingProjectIds = await Project.find({ service }).select("_id");
      const serviceOr: any[] = [{ 'rfqData.serviceType': service }];
      if (matchingProjectIds.length > 0) {
        serviceOr.push({ project: { $in: matchingProjectIds.map(p => p._id) } });
      }
      query.$and = (query.$and || []).concat([{ $or: serviceOr }]);
    }

    if (search && typeof search === 'string') {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const matchingCustomerIds = await User.find({ name: regex }).select("_id");
      const searchOr: any[] = [
        { 'rfqData.serviceType': regex },
        { 'rfqData.description': regex },
        { bookingNumber: regex },
      ];
      if (matchingCustomerIds.length > 0) {
        searchOr.push({ customer: { $in: matchingCustomerIds.map(c => c._id) } });
      }
      query.$and = (query.$and || []).concat([{ $or: searchOr }]);
    }

    if (addressFilter && typeof addressFilter === 'string' && user.role === 'customer') {
      const trimmedAddress = addressFilter.trim();
      if (trimmedAddress.length >= 2) {
        const escaped = trimmedAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        query.$and = (query.$and || []).concat([{
          $or: [
            { 'location.address': regex },
            { 'location.city': regex },
            { 'location.country': regex },
          ],
        }]);
      }
    }

    if (customerNameFilter && typeof customerNameFilter === 'string' && user.role === 'professional') {
      const trimmed = customerNameFilter.trim();
      if (trimmed.length >= 2) {
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        const matchingCustomerIds = await User.find({ role: 'customer', name: regex }).select('_id');
        if (matchingCustomerIds.length > 0) {
          query.$and = (query.$and || []).concat([{
            customer: { $in: matchingCustomerIds.map(c => c._id) },
          }]);
        } else {
          query.$and = (query.$and || []).concat([{ customer: { $in: [] } }]);
        }
      }
    }

    const skip = (parsedPage - 1) * parsedLimit;

    // Compute roleProjectIds for the unfiltered service-dropdown query.
    const roleProjectIds: any[] = user.role === 'customer'
      ? (await Booking.distinct('project', { customer: userId })).filter(Boolean)
      : (professionalProjectIds ?? []);

    const distinctServicesPromise = roleProjectIds.length > 0
      ? Project.distinct('service', { _id: { $in: roleProjectIds } })
      : Promise.resolve([] as string[]);

    const [bookings, total, distinctServices] = await Promise.all([
      Booking.find(query)
        .populate('customer', 'name email phone customerType')
        .populate('professional', 'name email username businessInfo')
        .populate('project', 'title description pricing category service timeMode subprojects executionDuration')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit),
      Booking.countDocuments(query),
      distinctServicesPromise,
    ]);

    return res.status(200).json({
      success: true,
      bookings,
      distinctServices: distinctServices.filter(Boolean).sort(),
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });

  } catch (error: any) {
    console.error('Get bookings error:', error);
    next(error);
  }
};

// Get single booking by ID
export const getBookingById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const userIdString = userId ? userId.toString() : '';
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId as string)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking ID"
      });
    }

    const isAdmin = req.user?.role === 'admin';
    const isViewerCustomer = !isAdmin && req.user?.role === 'customer';

    const professionalFields = isAdmin
      ? 'name email phone username businessInfo hourlyRate stripe role createdAt'
      : isViewerCustomer
        ? '_id name username businessInfo.companyName businessInfo.description businessInfo.website businessInfo.city businessInfo.country businessInfo.timezone'
        : 'name email username businessInfo';

    const bookingQuery = Booking.findById(bookingId)
      .populate('customer', isAdmin
        ? 'name email phone customerType location vatNumber totalSpent'
        : 'name email phone customerType location')
      .populate('professional', professionalFields)
      .populate(
        'project',
        `title description pricing category service team timeMode rfqQuestions postBookingQuestions professionalId extraOptions termsConditions subprojects minResources minOverlapPercentage executionDuration${isAdmin ? ' resources' : ''}`
      )
      .populate('assignedTeamMembers', 'name email');

    const booking = await bookingQuery;

    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization - customer, professional, project owner, or admin can view
    const isCustomer = booking.customer._id.toString() === userIdString;
    const isProfessional = booking.professional?._id.toString() === userIdString;
    // For project bookings, also check if user owns the project
    const isProjectOwner = booking.bookingType === 'project' && booking.project
      && (booking.project as any).professionalId?.toString() === userIdString;

    if (!isAdmin && !isCustomer && !isProfessional && !isProjectOwner) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to view this booking"
      });
    }

    const bookingWithSignedFiles = await presignBookingFiles(booking);

    return res.status(200).json({
      success: true,
      booking: bookingWithSignedFiles,
      viewerRole: isAdmin ? 'admin' : isCustomer ? 'customer' : 'professional',
    });

  } catch (error: any) {
    console.error('Get booking error:', error);
    next(error);
  }
};

export const submitPostBookingAnswers = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?._id;
    const userIdString = userId ? userId.toString() : '';
    const { bookingId } = req.params;
    const { answers } = req.body as {
      answers?: Array<{ questionId?: string; question?: string; answer?: string }>;
    };

    if (!mongoose.Types.ObjectId.isValid(bookingId as string)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking ID",
      });
    }

    if (!Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        msg: "Answers are required",
      });
    }

    const booking = await Booking.findById(bookingId).populate(
      "project",
      "postBookingQuestions"
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found",
      });
    }

    if (booking.customer.toString() !== userIdString) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to submit answers for this booking",
      });
    }

    if ((booking.postBookingData?.length || 0) > 0) {
      return res.status(400).json({
        success: false,
        msg: "Post-booking answers already submitted",
      });
    }

    const project = booking.project as any;
    const postBookingQuestions = project?.postBookingQuestions || [];
    if (postBookingQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "No post-booking questions available for this booking",
      });
    }

    const normalizedAnswers = answers.map((answer) => {
      const rawAnswer = answer.answer;
      const trimmedAnswer = (typeof rawAnswer === "string" ? rawAnswer : String(rawAnswer ?? "")).trim();
      const rawQuestionId = answer.questionId;
      const clientQuestionId = typeof rawQuestionId === "string" ? rawQuestionId : String(rawQuestionId ?? "");
      const rawQuestion = answer.question;
      const clientQuestion = typeof rawQuestion === "string" ? rawQuestion : String(rawQuestion ?? "");
      const matchedQuestion = postBookingQuestions.find((q: any) => {
        const qId = q._id?.toString() || q.id;
        if (qId && clientQuestionId === qId) return true;
        if (q?.question && clientQuestion === q.question) return true;
        return false;
      });
      return {
        questionId: matchedQuestion?._id?.toString() || matchedQuestion?.id || clientQuestionId,
        question: matchedQuestion?.question || clientQuestion,
        answer: trimmedAnswer,
      };
    });

    const unresolvedAnswers = normalizedAnswers.filter(
      (a) => a.answer && (!a.questionId || !a.question)
    );
    if (unresolvedAnswers.length > 0) {
      return res.status(400).json({
        success: false,
        msg: `Could not resolve ${unresolvedAnswers.length} answer(s) to a valid question`,
      });
    }

    const hasMissingRequired = postBookingQuestions.some((question: any) => {
      if (!question?.isRequired) {
        return false;
      }

      const questionId = question._id?.toString() || question.id;
      const matched = normalizedAnswers.find((a) => {
        if (questionId && a.questionId === questionId) {
          return true;
        }
        if (question?.question && a.question === question.question) {
          return true;
        }
        return false;
      });

      return !matched || !matched.answer;
    });

    if (hasMissingRequired) {
      return res.status(400).json({
        success: false,
        msg: "Please answer all required questions",
      });
    }

    booking.postBookingData = normalizedAnswers.filter(
      (a) => a.answer && a.question && a.questionId
    ) as any;

    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Post-booking answers submitted successfully",
      postBookingData: booking.postBookingData,
    });
  } catch (error: any) {
    console.error("Submit post-booking answers error:", error);
    next(error);
  }
};

// Submit quote (Professional only)
export const submitQuote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const {
      amount,
      currency,
      description,
      breakdown,
      validUntil,
      termsAndConditions,
      estimatedDuration
    } = req.body;

    // Validate
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        msg: "Valid quote amount is required"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check if user is the professional for this booking
    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({
        success: false,
        msg: "Only the assigned professional can submit a quote"
      });
    }

    // Check booking status
    if (booking.status !== 'rfq') {
      return res.status(400).json({
        success: false,
        msg: "Quote can only be submitted for RFQ bookings"
      });
    }

    // Update booking with quote
    booking.quote = {
      amount,
      currency: currency || 'EUR',
      description,
      breakdown,
      validUntil: validUntil ? new Date(validUntil) : undefined,
      termsAndConditions,
      estimatedDuration,
      submittedAt: new Date(),
      submittedBy: new mongoose.Types.ObjectId(userId)
    };

    await (booking as any).updateStatus('quoted', userId, 'Quote submitted by professional');

    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' }
    ]);

    return res.status(200).json({
      success: true,
      msg: "Quote submitted successfully",
      booking
    });

  } catch (error: any) {
    console.error('Submit quote error:', error);
    next(error);
  }
};

// Accept/Reject quote (Customer only)
export const respondToQuote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const { action } = req.body; // 'accept' or 'reject'

    if (!action || (action !== 'accept' && action !== 'reject')) {
      return res.status(400).json({
        success: false,
        msg: "Invalid action. Must be 'accept' or 'reject'"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check if user is the customer
    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        msg: "Only the customer can respond to quotes"
      });
    }

    // Check booking status
    if (booking.status !== 'quoted') {
      return res.status(400).json({
        success: false,
        msg: "Can only respond to bookings with submitted quotes"
      });
    }

    const newStatus: BookingStatus = action === 'accept' ? 'quote_accepted' : 'quote_rejected';
    const note = action === 'accept' ? 'Quote accepted by customer' : 'Quote rejected by customer';

    await (booking as any).updateStatus(newStatus, userId, note);

    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' }
    ]);

    return res.status(200).json({
      success: true,
      msg: `Quote ${action}ed successfully`,
      booking
    });

  } catch (error: any) {
    console.error('Respond to quote error:', error);
    next(error);
  }
};

// Update booking status
export const updateBookingStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const { status, note } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        msg: "Status is required"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization
    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to update this booking"
      });
    }

    await (booking as any).updateStatus(status, userId, note);

    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' }
    ]);

    return res.status(200).json({
      success: true,
      msg: "Booking status updated successfully",
      booking
    });

  } catch (error: any) {
    console.error('Update booking status error:', error);
    next(error);
  }
};

// Cancel booking — creates a pending CancellationRequest. Admin must approve to actually cancel + refund.
export const cancelBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const { reason, evidence, reasonCategory } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const normalizedCategory =
      typeof reasonCategory === 'string' && (CANCELLATION_REASON_CATEGORIES as readonly string[]).includes(reasonCategory)
        ? (reasonCategory as CancellationReasonCategory)
        : undefined;

    const explanation = typeof reason === 'string' ? reason.trim() : '';
    if (explanation.length > 1000) {
      return res.status(400).json({
        success: false,
        msg: "Cancellation explanation must be 1000 characters or fewer"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to request cancellation for this booking"
      });
    }

    // Customers must select a reason from the predefined list; professionals may
    // still submit a free-text reason (their UI has no category dropdown).
    if (isCustomer && !normalizedCategory) {
      return res.status(400).json({
        success: false,
        msg: "Please select a cancellation reason"
      });
    }
    if (!normalizedCategory && !explanation) {
      return res.status(400).json({
        success: false,
        msg: "A cancellation reason is required"
      });
    }
    const trimmedReason = explanation || (normalizedCategory ? CANCELLATION_REASON_LABELS[normalizedCategory] : '');

    if (['completed', 'cancelled', 'refunded'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        msg: `Cannot request cancellation for booking with status '${booking.status}'`
      });
    }

    const existingPending = await CancellationRequest.findOne({
      booking: booking._id,
      status: { $in: ACTIVE_CANCELLATION_STATUSES },
    });
    if (existingPending) {
      return res.status(409).json({
        success: false,
        msg: "A cancellation request is already pending admin review for this booking"
      });
    }

    const requestedRole: 'customer' | 'professional' = isCustomer ? 'customer' : 'professional';
    const sanitizedEvidence = Array.isArray(evidence)
      ? evidence.filter((value: unknown): value is string => typeof value === 'string').slice(0, 10)
      : [];
    const shouldMarkNoShow = isCustomer && normalizedCategory === 'no_show' && !booking.noShow?.markedAt;

    let cancellationRequest!: InstanceType<typeof CancellationRequest>;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const [created] = await CancellationRequest.create(
        [{
          booking: booking._id,
          requestedBy: new mongoose.Types.ObjectId(userId),
          requestedRole,
          ...(normalizedCategory ? { reasonCategory: normalizedCategory } : {}),
          reason: trimmedReason,
          evidence: sanitizedEvidence,
          status: 'pending',
          ...(isCustomer ? { responseDeadline: addBusinessDays(new Date(), REFUND_RESPONSE_BUSINESS_DAYS) } : {}),
        }],
        { session }
      );
      cancellationRequest = created;

      if (shouldMarkNoShow) {
        booking.noShow = {
          markedAt: new Date(),
          markedBy: new mongoose.Types.ObjectId(userId),
          reason: trimmedReason,
          source: 'customer_cancellation',
        };
        await booking.save({ session });
      }

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      session.endSession();
    }

    try {
      const [customerUser, professionalUser] = await Promise.all([
        booking.customer ? User.findById(booking.customer).select('email name').lean() : null,
        booking.professional ? User.findById(booking.professional).select('email name businessInfo username').lean() : null,
      ]);
      const requesterName = isCustomer
        ? customerUser?.name || 'Customer'
        : getProfessionalDisplayName(professionalUser);
      const otherPartyEmail = isCustomer ? professionalUser?.email : customerUser?.email;
      const otherPartyName = isCustomer
        ? getProfessionalDisplayName(professionalUser)
        : customerUser?.name || 'Customer';

      await sendCancellationRequestRaisedEmail({
        bookingId: String(booking._id),
        requesterName,
        requesterRole: requestedRole,
        reason: trimmedReason,
        otherPartyEmail: otherPartyEmail || undefined,
        otherPartyName,
      });
    } catch (emailError: any) {
      console.error('Failed to send cancellation-request-raised email:', emailError?.message || emailError);
    }

    return res.status(201).json({
      success: true,
      msg: isCustomer
        ? "Refund request sent to the professional. They have 5 business days to respond before it escalates to Fixera."
        : "Cancellation request submitted for admin review",
      cancellationRequest,
    });
  } catch (error: any) {
    console.error('Cancel booking error:', error);
    next(error);
  }
};

// List disputes raised by or against the current user
export const getMyDisputes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    const objectUserId = new mongoose.Types.ObjectId(userId);
    const bookings = await Booking.find({
      status: { $in: ['dispute', 'completed', 'cancelled', 'refunded'] },
      'dispute.raisedAt': { $exists: true },
      $or: [{ customer: objectUserId }, { professional: objectUserId }],
    })
      .select('bookingNumber status dispute customer professional project payment scheduledStartDate')
      .populate('customer', 'name')
      .populate('professional', 'name')
      .populate('project', 'title')
      .sort({ 'dispute.raisedAt': -1 })
      .limit(100)
      .lean();

    return res.json({ success: true, data: { items: bookings } });
  } catch (error: any) {
    console.error('Get my disputes error:', error);
    next(error);
  }
};

// Get payment history for current customer
export const getMyPayments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { status, page = '1', limit = '20' } = req.query;

    if (!userId) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role !== 'customer') {
      return res.status(403).json({ success: false, msg: "Only customers can view payment history" });
    }

    const query: Record<string, any> = { customer: userId };
    if (status && typeof status === 'string' && status !== 'all') {
      query.status = status;
    }

    const pageNumber = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNumber = Math.min(Math.max(parseInt(limit as string, 10) || 20, 5), 100);
    const skip = (pageNumber - 1) * limitNumber;

    const [payments, totalCount, summaryStats] = await Promise.all([
      Payment.find(query)
        .populate('booking', 'status bookingType bookingNumber')
        .populate('professional', 'name email username businessInfo')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      Payment.countDocuments(query),
      Payment.aggregate([
        { $match: { customer: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            total: { $sum: '$totalWithVat' }
          }
        }
      ])
    ]);

    const summary = {
      totalPaid: 0,
      inEscrow: 0,
      refunded: 0,
    };
    summaryStats.forEach((s: any) => {
      if (s._id === 'completed') summary.totalPaid += s.total || 0;
      if (s._id === 'authorized') summary.inEscrow += s.total || 0;
      if (s._id === 'refunded') summary.refunded += s.total || 0;
      if (s._id === 'partially_refunded') summary.refunded += s.total || 0;
    });

    return res.status(200).json({
      success: true,
      data: {
        payments,
        summary,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNumber)
        }
      }
    });
  } catch (error: any) {
    console.error('Get my payments error:', error);
    next(error);
  }
};

