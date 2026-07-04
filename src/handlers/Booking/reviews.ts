import { Request, Response, NextFunction } from "express";
import Booking from "../../models/booking";
import User from "../../models/user";
import Project from "../../models/project";
import Conversation from "../../models/conversation";
import ChatMessage from "../../models/chatMessage";
import mongoose from "mongoose";
import { moderateText } from "../../utils/contentModeration";
import { uploadToS3, generateFileName, validateImageFileBuffer, deleteFromS3, presignS3Url } from "../../utils/s3Upload";
import { params } from "../../utils/requestParams";

const MAX_COMMENT_LENGTH = 1000;

const presignReviewImages = async (reviews: any[]): Promise<any[]> => {
  return Promise.all(
    reviews.map(async (review) => {
      const images = review.customerReview?.images;
      if (!Array.isArray(images) || images.length === 0) return review;
      const signed = await Promise.all(
        images.map(async (url: string) => {
          const result = await presignS3Url(url);
          return result ?? url;
        })
      );
      return { ...review, customerReview: { ...review.customerReview, images: signed } };
    })
  );
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Customer submits a review for the professional (3 categories + text + optional images)
export const submitCustomerReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id?.toString();
    const { bookingId } = params(req.params);

    // Parse ratings (may be strings when sent via FormData)
    const communicationLevel = typeof req.body.communicationLevel === "string" ? parseInt(req.body.communicationLevel, 10) : req.body.communicationLevel;
    const valueOfDelivery = typeof req.body.valueOfDelivery === "string" ? parseInt(req.body.valueOfDelivery, 10) : req.body.valueOfDelivery;
    const qualityOfService = typeof req.body.qualityOfService === "string" ? parseInt(req.body.qualityOfService, 10) : req.body.qualityOfService;
    const { comment } = req.body;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    // Validate ratings
    for (const [label, val] of Object.entries({ communicationLevel, valueOfDelivery, qualityOfService })) {
      if (!val || typeof val !== "number" || val < 1 || val > 5 || !Number.isInteger(val)) {
        return res.status(400).json({ success: false, msg: `${label} must be an integer between 1 and 5` });
      }
    }

    // Validate comment length
    const trimmedComment = typeof comment === "string" ? comment.trim() : undefined;
    if (trimmedComment && trimmedComment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ success: false, msg: `Comment must be ${MAX_COMMENT_LENGTH} characters or less` });
    }

    // Profanity filter
    if (trimmedComment) {
      const moderation = moderateText(trimmedComment);
      if (!moderation.passed) {
        return res.status(400).json({ success: false, msg: "Your review contains inappropriate language. Please revise." });
      }
    }

    // Validate images (max 2, images only)
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length > 2) {
      return res.status(400).json({ success: false, msg: "Maximum 2 images allowed" });
    }
    for (const file of files) {
      const validation = await validateImageFileBuffer(file);
      if (!validation.valid) {
        return res.status(400).json({ success: false, msg: validation.error });
      }
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (booking.customer.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Only the customer can submit a review" });
    }

    if (booking.status !== "completed") {
      return res.status(400).json({ success: false, msg: "Can only review completed bookings" });
    }

    if (booking.customerReview?.communicationLevel) {
      return res.status(400).json({ success: false, msg: "You have already reviewed this booking" });
    }

    // Upload images to S3 (with cleanup on failure)
    const imageUrls: string[] = [];
    const uploadedKeys: string[] = [];
    try {
      for (const file of files) {
        const fileName = generateFileName(file.originalname, userId!, "reviews");
        const result = await uploadToS3(file, fileName);
        imageUrls.push(result.url);
        uploadedKeys.push(result.key);
      }
    } catch (uploadError) {
      // Clean up any already-uploaded files
      for (const key of uploadedKeys) {
        try { await deleteFromS3(key); } catch (cleanupErr) {
          console.error("Failed to clean up orphaned S3 object:", key, cleanupErr);
        }
      }
      console.error("Review image upload failed:", uploadError);
      return res.status(500).json({ success: false, msg: "Failed to upload review images" });
    }

    booking.customerReview = {
      communicationLevel,
      valueOfDelivery,
      qualityOfService,
      comment: trimmedComment || undefined,
      images: imageUrls.length > 0 ? imageUrls : undefined,
      reviewedAt: new Date(),
    };

    await booking.save();

    // Send review notification as system message in chat
    try {
      const professionalId = booking.professional?.toString();
      if (professionalId && userId) {
        const customer = await User.findById(userId).select("name").lean();
        const avgRating = Math.round(((communicationLevel + valueOfDelivery + qualityOfService) / 3) * 10) / 10;

        // Find or create conversation
        let conversation = await Conversation.findOne({
          customerId: new mongoose.Types.ObjectId(userId),
          professionalId: new mongoose.Types.ObjectId(professionalId),
        });

        if (!conversation) {
          conversation = await Conversation.create({
            customerId: new mongoose.Types.ObjectId(userId),
            professionalId: new mongoose.Types.ObjectId(professionalId),
            initiatedBy: new mongoose.Types.ObjectId(userId),
          });
        }

        // senderId uses the customer who triggered the review; senderRole "system"
        // marks this as a platform-generated message so the UI renders it differently.
        await ChatMessage.create({
          conversationId: conversation._id,
          senderId: new mongoose.Types.ObjectId(userId),
          senderRole: "system",
          messageType: "review_notification",
          text: `${customer?.name || "Customer"} left a review - ${avgRating.toFixed(1)} avg`,
          reviewMeta: {
            bookingId: bookingId,
            avgRating,
            communicationLevel,
            valueOfDelivery,
            qualityOfService,
            comment: trimmedComment,
            customerName: customer?.name || "Customer",
          },
          readBy: [{ userId: new mongoose.Types.ObjectId(userId), readAt: new Date() }],
        });

        // Update conversation with notification preview and bump unread count
        await Conversation.findByIdAndUpdate(conversation._id, {
          $set: {
            lastMessageAt: new Date(),
            lastMessagePreview: `New review - ${avgRating.toFixed(1)} avg`,
            lastMessageSenderId: new mongoose.Types.ObjectId(userId),
            customerUnreadCount: 0,
          },
          $inc: { professionalUnreadCount: 1 },
        });
      }
    } catch (notifError) {
      console.error("Failed to send review notification in chat:", notifError);
    }

    return res.status(200).json({
      success: true,
      msg: "Review submitted successfully",
      customerReview: booking.customerReview,
    });
  } catch (error) {
    console.error("Submit customer review error:", error);
    next(error);
  }
};

// Professional submits a review for the customer (overall rating + text)
export const submitProfessionalReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id?.toString();
    const { bookingId } = params(req.params);
    const { rating, comment } = req.body;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ success: false, msg: "Rating must be an integer between 1 and 5" });
    }

    // Validate comment length
    const trimmedComment = typeof comment === "string" ? comment.trim() : undefined;
    if (trimmedComment && trimmedComment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ success: false, msg: `Comment must be ${MAX_COMMENT_LENGTH} characters or less` });
    }

    // Profanity filter
    if (trimmedComment) {
      const moderation = moderateText(trimmedComment);
      if (!moderation.passed) {
        return res.status(400).json({ success: false, msg: "Your review contains inappropriate language. Please revise." });
      }
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Only the professional can submit a review for the customer" });
    }

    if (booking.status !== "completed") {
      return res.status(400).json({ success: false, msg: "Can only review completed bookings" });
    }

    if (booking.professionalReview?.rating) {
      return res.status(400).json({ success: false, msg: "You have already reviewed this customer for this booking" });
    }

    booking.professionalReview = {
      rating,
      comment: trimmedComment || undefined,
      reviewedAt: new Date(),
    };

    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Review submitted successfully",
      professionalReview: booking.professionalReview,
    });
  } catch (error) {
    console.error("Submit professional review error:", error);
    next(error);
  }
};

// Professional replies to a customer's review (text only)
export const replyToCustomerReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id?.toString();
    const { bookingId } = params(req.params);
    const { comment } = req.body;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    if (!comment || typeof comment !== "string" || !comment.trim()) {
      return res.status(400).json({ success: false, msg: "Reply comment is required" });
    }

    if (comment.trim().length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ success: false, msg: `Reply comment must be ${MAX_COMMENT_LENGTH} characters or less` });
    }

    // Profanity filter
    const replyModeration = moderateText(comment.trim());
    if (!replyModeration.passed) {
      return res.status(400).json({ success: false, msg: "Your reply contains inappropriate language. Please revise." });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Only the professional can reply to customer reviews" });
    }

    if (!booking.customerReview?.communicationLevel) {
      return res.status(400).json({ success: false, msg: "No customer review to reply to" });
    }

    if (booking.customerReview.reply?.comment) {
      return res.status(400).json({ success: false, msg: "You have already replied to this review" });
    }

    booking.customerReview.reply = {
      comment: comment.trim(),
      repliedAt: new Date(),
    };

    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Reply submitted successfully",
      reply: booking.customerReview.reply,
    });
  } catch (error) {
    console.error("Reply to customer review error:", error);
    next(error);
  }
};

// Get all reviews for a professional (public endpoint)
export const getProfessionalReviews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = params(req.params);
    const { page = "1", limit = "10", search, rating, projectId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(professionalId)) {
      return res.status(400).json({ success: false, msg: "Invalid professional ID" });
    }

    const professional = await User.findById(professionalId).select("name username role businessInfo.description businessInfo.city businessInfo.country businessInfo.website profileImage serviceCategories hourlyRate createdAt location professionalStatus");
    if (!professional || professional.role !== "professional" || professional.professionalStatus !== "approved") {
      return res.status(404).json({ success: false, msg: "Professional not found" });
    }

    const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 50);
    const skip = (pageNum - 1) * limitNum;

    const query: any = {
      professional: new mongoose.Types.ObjectId(professionalId),
      status: "completed",
      "customerReview.communicationLevel": { $exists: true },
      "customerReview.isHidden": { $ne: true },
    };

    // Filter by project
    if (projectId && mongoose.Types.ObjectId.isValid(projectId as string)) {
      query.project = new mongoose.Types.ObjectId(projectId as string);
    }

    // Star rating filter
    if (rating) {
      const ratingNum = parseInt(rating as string, 10);
      if (ratingNum >= 1 && ratingNum <= 5) {
        query.$expr = {
          $and: [
            {
              $gte: [
                {
                  $round: [{
                    $divide: [
                      { $add: ["$customerReview.communicationLevel", "$customerReview.valueOfDelivery", "$customerReview.qualityOfService"] },
                      3
                    ]
                  }, 0]
                },
                ratingNum
              ]
            },
            {
              $lt: [
                {
                  $round: [{
                    $divide: [
                      { $add: ["$customerReview.communicationLevel", "$customerReview.valueOfDelivery", "$customerReview.qualityOfService"] },
                      3
                    ]
                  }, 0]
                },
                ratingNum + 1
              ]
            }
          ]
        };
      }
    }

    // Search filter (matches comment text)
    if (search && typeof search === "string" && search.trim()) {
      query["customerReview.comment"] = { $regex: escapeRegex(search.trim()), $options: "i" };
    }

    // Base query for overall stats (unfiltered by search/rating/project)
    const statsQuery = {
      professional: new mongoose.Types.ObjectId(professionalId),
      status: "completed",
      "customerReview.communicationLevel": { $exists: true },
      "customerReview.isHidden": { $ne: true },
    };

    const [reviews, totalCount, ratingStats, distinctProjects] = await Promise.all([
      Booking.find(query)
        .select("customerReview customer project createdAt")
        .populate("customer", "name profileImage")
        .populate("project", "title")
        .sort({ "customerReview.reviewedAt": -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Booking.countDocuments(query),
      Booking.aggregate([
        { $match: statsQuery },
        {
          $group: {
            _id: null,
            avgCommunication: { $avg: "$customerReview.communicationLevel" },
            avgValueOfDelivery: { $avg: "$customerReview.valueOfDelivery" },
            avgQualityOfService: { $avg: "$customerReview.qualityOfService" },
            totalReviews: { $sum: 1 },
          },
        },
      ]),
      // Stable list of all projects with reviews for this professional (for filter dropdown)
      Booking.aggregate([
        { $match: statsQuery },
        { $group: { _id: "$project" } },
        { $lookup: { from: "projects", localField: "_id", foreignField: "_id", as: "proj" } },
        { $unwind: "$proj" },
        { $project: { _id: "$proj._id", title: "$proj.title" } },
        { $sort: { title: 1 } },
      ]),
    ]);

    const stats = ratingStats[0] || {
      avgCommunication: 0,
      avgValueOfDelivery: 0,
      avgQualityOfService: 0,
      totalReviews: 0,
    };

    const overallAvg = stats.totalReviews > 0
      ? (stats.avgCommunication + stats.avgValueOfDelivery + stats.avgQualityOfService) / 3
      : 0;

    const presignedReviews = await presignReviewImages(reviews);

    return res.status(200).json({
      success: true,
      data: {
        professional,
        reviews: presignedReviews,
        projects: distinctProjects,
        ratingsSummary: {
          overallAverage: Math.round(overallAvg * 10) / 10,
          avgCommunication: Math.round((stats.avgCommunication || 0) * 10) / 10,
          avgValueOfDelivery: Math.round((stats.avgValueOfDelivery || 0) * 10) / 10,
          avgQualityOfService: Math.round((stats.avgQualityOfService || 0) * 10) / 10,
          totalReviews: stats.totalReviews,
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("Get professional reviews error:", error);
    next(error);
  }
};

// Get all reviews for a specific project (public endpoint)
export const getProjectReviews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = params(req.params);
    const { page = "1", limit = "10", search, rating } = req.query;

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, msg: "Invalid project ID" });
    }

    const project = await Project.findById(projectId).select("title professionalId status");
    if (!project || project.status !== "published") {
      return res.status(404).json({ success: false, msg: "Project not found" });
    }

    const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 50);
    const skip = (pageNum - 1) * limitNum;

    const query: any = {
      project: new mongoose.Types.ObjectId(projectId),
      status: "completed",
      "customerReview.communicationLevel": { $exists: true },
      "customerReview.isHidden": { $ne: true },
    };

    // Star rating filter (matches the rounded overall average)
    if (rating) {
      const ratingNum = parseInt(rating as string, 10);
      if (ratingNum >= 1 && ratingNum <= 5) {
        query.$expr = {
          $and: [
            {
              $gte: [
                {
                  $round: [{
                    $divide: [
                      { $add: ["$customerReview.communicationLevel", "$customerReview.valueOfDelivery", "$customerReview.qualityOfService"] },
                      3
                    ]
                  }, 0]
                },
                ratingNum
              ]
            },
            {
              $lt: [
                {
                  $round: [{
                    $divide: [
                      { $add: ["$customerReview.communicationLevel", "$customerReview.valueOfDelivery", "$customerReview.qualityOfService"] },
                      3
                    ]
                  }, 0]
                },
                ratingNum + 1
              ]
            }
          ]
        };
      }
    }

    // Search filter (matches comment text)
    if (search && typeof search === "string" && search.trim()) {
      query["customerReview.comment"] = { $regex: escapeRegex(search.trim()), $options: "i" };
    }

    const activeStatuses = ['rfq', 'rfq_accepted', 'draft_quote', 'quoted', 'quote_accepted', 'payment_pending', 'booked', 'in_progress'];

    const [reviews, totalCount, ratingStats, ordersInQueue] = await Promise.all([
      Booking.find(query)
        .select("customerReview customer createdAt")
        .populate("customer", "name profileImage")
        .sort({ "customerReview.reviewedAt": -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Booking.countDocuments(query),
      Booking.aggregate([
        {
          $match: {
            project: new mongoose.Types.ObjectId(projectId),
            status: "completed",
            "customerReview.communicationLevel": { $exists: true },
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
      ]),
      Booking.countDocuments({
        project: new mongoose.Types.ObjectId(projectId),
        status: { $in: activeStatuses },
      }),
    ]);

    const stats = ratingStats[0] || {
      avgCommunication: 0,
      avgValueOfDelivery: 0,
      avgQualityOfService: 0,
      totalReviews: 0,
    };

    const overallAvg = stats.totalReviews > 0
      ? (stats.avgCommunication + stats.avgValueOfDelivery + stats.avgQualityOfService) / 3
      : 0;

    const presignedReviews = await presignReviewImages(reviews);

    return res.status(200).json({
      success: true,
      data: {
        project: { _id: project._id, title: project.title },
        reviews: presignedReviews,
        ratingsSummary: {
          overallAverage: Math.round(overallAvg * 10) / 10,
          avgCommunication: Math.round((stats.avgCommunication || 0) * 10) / 10,
          avgValueOfDelivery: Math.round((stats.avgValueOfDelivery || 0) * 10) / 10,
          avgQualityOfService: Math.round((stats.avgQualityOfService || 0) * 10) / 10,
          totalReviews: stats.totalReviews,
        },
        ordersInQueue,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("Get project reviews error:", error);
    next(error);
  }
};
