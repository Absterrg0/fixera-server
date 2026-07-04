import { Request, Response, NextFunction } from "express";
import Booking from "../../models/booking";
import mongoose from "mongoose";
import { params } from "../../utils/requestParams";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const buildReviewModerationQuery = ({
  hidden,
  search,
}: {
  hidden?: boolean;
  search?: string;
}) => {
  const query: Record<string, any> = {
    status: "completed",
    "customerReview.communicationLevel": { $exists: true },
  };

  if (typeof hidden === "boolean") {
    query["customerReview.isHidden"] = hidden ? true : { $ne: true };
  }

  if (search) {
    const safeSearch = escapeRegex(search);
    query.$or = [
      { "customerReview.comment": { $regex: safeSearch, $options: "i" } },
      { bookingNumber: { $regex: safeSearch, $options: "i" } },
    ];
  }

  return query;
};

const getReviewStats = async () => {
  const [totalReviews, hiddenReviews] = await Promise.all([
    Booking.countDocuments(buildReviewModerationQuery({})),
    Booking.countDocuments(buildReviewModerationQuery({ hidden: true })),
  ]);

  return {
    total: totalReviews,
    hidden: hiddenReviews,
    visible: Math.max(totalReviews - hiddenReviews, 0),
  };
};

type ReviewModerationStatus = "visible" | "hidden" | "all";

const parseReviewModerationStatus = (value: unknown): ReviewModerationStatus | null => {
  if (value === "hidden" || value === "visible" || value === "all") {
    return value;
  }

  return null;
};

const statusToHiddenFilter = (status: ReviewModerationStatus): boolean | undefined => {
  if (status === "hidden") return true;
  if (status === "visible") return false;
  return undefined;
};

const fetchReviewList = async ({
  status,
  search,
  page,
  limit,
}: {
  status: ReviewModerationStatus;
  search: unknown;
  page: unknown;
  limit: unknown;
}) => {
  const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);
  const skip = (pageNum - 1) * limitNum;
  const hiddenFilter = statusToHiddenFilter(status);
  const searchTerm = typeof search === "string" ? search.trim() : "";
  const query = buildReviewModerationQuery({
    hidden: hiddenFilter,
    search: searchTerm || undefined,
  });
  const sortField = hiddenFilter === true ? "customerReview.hiddenAt" : "customerReview.reviewedAt";

  const [reviews, totalCount, stats] = await Promise.all([
    Booking.find(query)
      .select("bookingNumber customerReview customer professional project createdAt")
      .populate("customer", "name profileImage")
      .populate("professional", "name businessInfo profileImage")
      .populate("project", "title")
      .sort({ [sortField]: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Booking.countDocuments(query),
    getReviewStats(),
  ]);

  return {
    reviews,
    stats,
    filters: {
      status,
      search: searchTerm,
    },
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: totalCount,
      totalPages: Math.max(Math.ceil(totalCount / limitNum), 1),
    },
  };
};

// Hide a customer review (admin only)
export const hideReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = req.user?._id;
    const { bookingId } = params(req.params);

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (!booking.customerReview?.communicationLevel) {
      return res.status(400).json({ success: false, msg: "No customer review on this booking" });
    }

    if (booking.customerReview.isHidden) {
      return res.status(400).json({ success: false, msg: "Review is already hidden" });
    }

    booking.customerReview.isHidden = true;
    booking.customerReview.hiddenBy = adminId;
    booking.customerReview.hiddenAt = new Date();
    await booking.save();

    return res.status(200).json({ success: true, msg: "Review hidden successfully" });
  } catch (error) {
    console.error("Hide review error:", error);
    next(error);
  }
};

// Unhide a customer review (admin only)
export const unhideReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = req.user?._id;
    const { bookingId } = params(req.params);

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (!booking.customerReview?.isHidden) {
      return res.status(400).json({ success: false, msg: "Review is not hidden" });
    }

    // Use atomic $set/$unset to properly remove fields and record audit trail
    await Booking.updateOne(
      { _id: bookingId },
      {
        $set: {
          "customerReview.isHidden": false,
          "customerReview.unhiddenBy": adminId,
          "customerReview.unhiddenAt": new Date(),
        },
        $unset: {
          "customerReview.hiddenBy": "",
          "customerReview.hiddenAt": "",
        },
      }
    );

    return res.status(200).json({ success: true, msg: "Review unhidden successfully" });
  } catch (error) {
    console.error("Unhide review error:", error);
    next(error);
  }
};

// Get all moderatable customer reviews (admin only)
export const getAdminReviews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = "1", limit = "20", status = "visible", search } = req.query;
    const normalizedStatus = parseReviewModerationStatus(status);
    if (!normalizedStatus) {
      return res.status(400).json({ success: false, msg: "Invalid review status filter" });
    }

    const data = await fetchReviewList({
      status: normalizedStatus,
      search,
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Get admin reviews error:", error);
    next(error);
  }
};

// Get all hidden reviews (admin only)
export const getHiddenReviews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = "1", limit = "20", search, status = "hidden" } = req.query;
    const normalizedStatus = parseReviewModerationStatus(status);
    if (!normalizedStatus) {
      return res.status(400).json({ success: false, msg: "Invalid review status filter" });
    }
    if (normalizedStatus !== "hidden") {
      return res.status(400).json({ success: false, msg: "Hidden reviews endpoint only supports status=hidden" });
    }

    const data = await fetchReviewList({
      status: normalizedStatus,
      search,
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      data: {
        reviews: data.reviews,
        stats: data.stats,
        pagination: data.pagination,
      },
    });
  } catch (error) {
    console.error("Get hidden reviews error:", error);
    next(error);
  }
};
