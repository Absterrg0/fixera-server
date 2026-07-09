import { Request, Response } from 'express';
import Booking from '../../models/booking';
import User from '../../models/user';
import WarrantyClaim from '../../models/warrantyClaim';
import Favorite from '../../models/favorite';
import ServiceView from '../../models/serviceView';
import { buildCsv } from '../../utils/csv';
import { STRIPE_CONFIG } from '../../services/stripe';

const REPORTING_CURRENCY = STRIPE_CONFIG.defaultCurrency || 'EUR';

interface DateRange { from: Date; to: Date; }

const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

const parseRange = (req: Request): DateRange => {
  const now = new Date();
  const fromRaw = req.query.from ? String(req.query.from) : '';
  const toRaw = req.query.to ? String(req.query.to) : '';
  const fromParsed = fromRaw ? new Date(fromRaw) : null;
  const toParsed = toRaw ? new Date(toRaw) : null;
  const from = fromParsed && !isNaN(fromParsed.getTime()) ? fromParsed : startOfMonth(now);
  const to = toParsed && !isNaN(toParsed.getTime()) ? toParsed : now;
  if (from.getTime() > to.getTime()) {
    return { from: to, to: from };
  }
  return { from, to };
};

const parseCountry = (req: Request): string | null => {
  const raw = req.query.country ? String(req.query.country).trim() : '';
  if (!raw || raw.toLowerCase() === 'all') return null;
  return raw;
};

const buildExactCountryRegex = (country: string): RegExp => {
  const escaped = country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
};

const buildBookingCountryMatch = (country: string | null) => {
  if (!country) return {};
  return { 'location.country': { $regex: buildExactCountryRegex(country) } };
};

const buildUserCountryMatch = (country: string | null) => {
  if (!country) return {};
  const rx = buildExactCountryRegex(country);
  return {
    $or: [
      { 'location.country': rx },
      { 'companyAddress.country': rx },
      { 'businessInfo.country': rx },
    ],
  };
};

const normalizeCityExpr = {
  $let: {
    vars: {
      raw: { $ifNull: ['$location.city', null] },
    },
    in: {
      $cond: [
        { $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }] },
        '__unknown__',
        { $toLower: { $trim: { input: '$$raw' } } },
      ],
    },
  },
};

const normalizeUserCityExpr = {
  $let: {
    vars: {
      candidates: {
        $filter: {
          input: [
            { $trim: { input: { $ifNull: ['$location.city', ''] } } },
            { $trim: { input: { $ifNull: ['$companyAddress.city', ''] } } },
            { $trim: { input: { $ifNull: ['$businessInfo.city', ''] } } },
          ],
          as: 'c',
          cond: { $and: [{ $ne: ['$$c', null] }, { $ne: ['$$c', ''] }] },
        },
      },
    },
    in: {
      $let: {
        vars: { raw: { $arrayElemAt: ['$$candidates', 0] } },
        in: {
          $cond: [
            { $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }] },
            '__unknown__',
            { $toLower: '$$raw' },
          ],
        },
      },
    },
  },
};

const formatCity = (key: string): string => (key === '__unknown__' ? 'Unknown' : key);

const safeRate = (numer: number, denom: number): number => (denom > 0 ? (numer / denom) * 100 : 0);
const round1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const money2 = (n: number | null | undefined) => Math.round(((n as number) || 0) * 100) / 100;

const PAID_STATUSES = ['booked', 'in_progress', 'professional_completed', 'completed'];

const quotedExpr = { $or: [{ $ifNull: ['$quote.submittedAt', false] }, { $gt: [{ $size: { $ifNull: ['$quoteVersions', []] } }, 0] }] };
const firstQuoteAtExpr = { $ifNull: [{ $arrayElemAt: ['$quoteVersions.createdAt', 0] }, '$quote.submittedAt'] };
const reviewAvgExpr = {
  $avg: [
    { $ifNull: ['$customerReview.communicationLevel', null] },
    { $ifNull: ['$customerReview.valueOfDelivery', null] },
    { $ifNull: ['$customerReview.qualityOfService', null] },
  ],
};

const bookingMetricsProjection = (currencyField: string) => ({
  status: 1,
  createdAt: 1,
  paymentAmount: '$payment.amount',
  platformCommission: '$payment.platformCommission',
  paymentCurrency: currencyField,
  paymentStatus: '$payment.status',
  refundAmount: {
    $ifNull: [
      '$payment.refundAmount',
      { $ifNull: ['$cancellation.refundAmount', { $ifNull: ['$payment.totalWithVat', { $ifNull: ['$payment.amount', 0] }] }] },
    ],
  },
  rescheduleRequestAt: '$rescheduleRequest.requestedAt',
  noShowAt: '$noShow.markedAt',
  disputeAt: '$dispute.raisedAt',
  reviewedAt: '$customerReview.reviewedAt',
  reviewAvg: reviewAvgExpr,
  isRfq: { $eq: ['$bookingType', 'professional'] },
  quoted: { $cond: [{ $eq: ['$bookingType', 'professional'] }, quotedExpr, false] },
  firstQuoteAt: { $cond: [{ $eq: ['$bookingType', 'professional'] }, firstQuoteAtExpr, null] },
  scheduledStartDate: 1,
  actualStartDate: 1,
  scheduledExecutionEndDate: 1,
  actualEndDate: 1,
});

const bookingMetricsAccumulators = {
  totalBookings: { $sum: 1 },
  totalRfqs: { $sum: { $cond: ['$isRfq', 1, 0] } },
  completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
  quotedCount: { $sum: { $cond: ['$quoted', 1, 0] } },
  bookingsCount: { $sum: { $cond: [{ $in: ['$status', PAID_STATUSES] }, 1, 0] } },
  disputeCount: { $sum: { $cond: [{ $ifNull: ['$disputeAt', false] }, 1, 0] } },
  noShowCount: { $sum: { $cond: [{ $ifNull: ['$noShowAt', false] }, 1, 0] } },
  refundCount: { $sum: { $cond: [{ $in: ['$paymentStatus', ['refunded', 'partially_refunded']] }, 1, 0] } },
  refundAmount: { $sum: { $cond: [{ $and: [{ $in: ['$paymentStatus', ['refunded', 'partially_refunded']] }, { $eq: [{ $ifNull: ['$paymentCurrency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, '$refundAmount', 0] } },
  reschedulingCount: { $sum: { $cond: [{ $ifNull: ['$rescheduleRequestAt', false] }, 1, 0] } },
  reviewCount: { $sum: { $cond: [{ $ifNull: ['$reviewedAt', false] }, 1, 0] } },
  avgReviewScore: { $avg: { $cond: [{ $ifNull: ['$reviewedAt', false] }, '$reviewAvg', null] } },
  grossRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$paymentCurrency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$paymentAmount', 0] }, 0] } },
  platformRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$paymentCurrency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$platformCommission', 0] }, 0] } },
  avgTtfqHours: { $avg: { $cond: ['$quoted', { $divide: [{ $subtract: ['$firstQuoteAt', '$createdAt'] }, 1000 * 60 * 60] }, null] } },
  startOverdueEligible: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['completed', 'professional_completed', 'in_progress']] }, { $ifNull: ['$scheduledStartDate', false] }] }, 1, 0] } },
  startOverdueCount: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['completed', 'professional_completed', 'in_progress']] }, { $ifNull: ['$actualStartDate', false] }, { $ifNull: ['$scheduledStartDate', false] }, { $gt: [{ $subtract: ['$actualStartDate', '$scheduledStartDate'] }, 0] }] }, 1, 0] } },
  startOverdueDaysSum: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['completed', 'professional_completed', 'in_progress']] }, { $ifNull: ['$actualStartDate', false] }, { $ifNull: ['$scheduledStartDate', false] }, { $gt: [{ $subtract: ['$actualStartDate', '$scheduledStartDate'] }, 0] }] }, { $divide: [{ $subtract: ['$actualStartDate', '$scheduledStartDate'] }, 1000 * 60 * 60 * 24] }, 0] } },
  completionOverdueEligible: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['completed', 'professional_completed', 'in_progress']] }, { $ifNull: ['$scheduledExecutionEndDate', false] }] }, 1, 0] } },
  completionOverdueCount: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['completed', 'professional_completed', 'in_progress']] }, { $ifNull: ['$actualEndDate', false] }, { $ifNull: ['$scheduledExecutionEndDate', false] }, { $gt: [{ $subtract: ['$actualEndDate', '$scheduledExecutionEndDate'] }, 0] }] }, 1, 0] } },
  completionOverdueDaysSum: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['completed', 'professional_completed', 'in_progress']] }, { $ifNull: ['$actualEndDate', false] }, { $ifNull: ['$scheduledExecutionEndDate', false] }, { $gt: [{ $subtract: ['$actualEndDate', '$scheduledExecutionEndDate'] }, 0] }] }, { $divide: [{ $subtract: ['$actualEndDate', '$scheduledExecutionEndDate'] }, 1000 * 60 * 60 * 24] }, 0] } },
};

type GroupAgg = Record<string, number | null | undefined>;

interface DerivedBookingMetrics {
  totalBookings: number;
  completedBookings: number;
  totalRfqs: number;
  quotedCount: number;
  bookingsCount: number;
  disputeCount: number;
  noShowCount: number;
  refundCount: number;
  reschedulingCount: number;
  reviewCount: number;
  grossRevenue: number;
  platformRevenue: number;
  refundAmount: number;
  avgTtfqHours: number | null;
  avgReviewScore: number | null;
  quoteResponseRate: number | null;
  quotationConversionRate: number | null;
  disputeRate: number | null;
  noShowRate: number | null;
  refundRate: number | null;
  reschedulingRate: number | null;
  startOverdueRate: number | null;
  avgStartOverdueDays: number | null;
  completionOverdueRate: number | null;
  avgCompletionOverdueDays: number | null;
  views?: number;
  bookingRate?: number | null;
}

const deriveBookingRates = (g: GroupAgg, views?: number): DerivedBookingMetrics => {
  const totalRfqs = (g.totalRfqs as number) || 0;
  const quotedCount = (g.quotedCount as number) || 0;
  const bookingsCount = (g.bookingsCount as number) || 0;
  const startEligible = (g.startOverdueEligible as number) || 0;
  const startCount = (g.startOverdueCount as number) || 0;
  const completionEligible = (g.completionOverdueEligible as number) || 0;
  const completionCount = (g.completionOverdueCount as number) || 0;
  const out: DerivedBookingMetrics = {
    totalBookings: (g.totalBookings as number) || 0,
    completedBookings: (g.completedBookings as number) || 0,
    totalRfqs,
    quotedCount,
    bookingsCount,
    disputeCount: (g.disputeCount as number) || 0,
    noShowCount: (g.noShowCount as number) || 0,
    refundCount: (g.refundCount as number) || 0,
    reschedulingCount: (g.reschedulingCount as number) || 0,
    reviewCount: (g.reviewCount as number) || 0,
    grossRevenue: money2(g.grossRevenue as number),
    platformRevenue: money2(g.platformRevenue as number),
    refundAmount: money2(g.refundAmount as number),
    avgTtfqHours: round1(g.avgTtfqHours),
    avgReviewScore: round1(g.avgReviewScore),
    quoteResponseRate: round1(safeRate(quotedCount, totalRfqs)),
    quotationConversionRate: round1(safeRate(bookingsCount, quotedCount)),
    disputeRate: round1(safeRate((g.disputeCount as number) || 0, totalRfqs)),
    noShowRate: round1(safeRate((g.noShowCount as number) || 0, totalRfqs)),
    refundRate: round1(safeRate((g.refundCount as number) || 0, totalRfqs)),
    reschedulingRate: round1(safeRate((g.reschedulingCount as number) || 0, totalRfqs)),
    startOverdueRate: round1(safeRate(startCount, startEligible)),
    avgStartOverdueDays: round1(startCount > 0 ? ((g.startOverdueDaysSum as number) || 0) / startCount : null),
    completionOverdueRate: round1(safeRate(completionCount, completionEligible)),
    avgCompletionOverdueDays: round1(completionCount > 0 ? ((g.completionOverdueDaysSum as number) || 0) / completionCount : null),
  };
  if (typeof views === 'number') {
    out.views = views;
    out.bookingRate = round1(safeRate(bookingsCount, views));
  }
  return out;
};

// ---------- countries list ----------

export const getKpiCountries = async (_req: Request, res: Response) => {
  try {
    const [bookingCountries, userLocationCountries, userCompanyAddressCountries, userBusinessInfoCountries] = await Promise.all([
      Booking.distinct('location.country'),
      User.distinct('location.country'),
      User.distinct('companyAddress.country'),
      User.distinct('businessInfo.country'),
    ]);
    const set = new Set<string>();
    for (const c of [...bookingCountries, ...userLocationCountries, ...userCompanyAddressCountries, ...userBusinessInfoCountries]) {
      if (c && typeof c === 'string' && c.trim()) set.add(c.trim());
    }
    return res.json({ success: true, data: { countries: Array.from(set).sort((a, b) => a.localeCompare(b)) } });
  } catch (error) {
    console.error('KPI countries error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to load countries' } });
  }
};

// ---------- summary ----------

export const getKpiSummary = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const country = parseCountry(req);
    const bookingCountryMatch = buildBookingCountryMatch(country);
    const userCountryMatch = buildUserCountryMatch(country);

    const completedRevenueMatch: Record<string, unknown> = {
      status: 'completed',
      ...bookingCountryMatch,
      $or: [
        { 'payment.capturedAt': { $gte: from, $lte: to } },
        {
          $and: [
            { $or: [{ 'payment.capturedAt': { $exists: false } }, { 'payment.capturedAt': null }] },
            { updatedAt: { $gte: from, $lte: to } },
          ],
        },
      ],
    };

    const [
      signUps,
      bookingStats,
      revenueStats,
      disputeCount,
      warrantyCount,
      refundCount,
      refundAmountAgg,
      totalBookingsInRange,
      firstQuoteAvg,
      reviewStats,
      favoritesCount,
      reschedulingCount,
      noShowCount,
      overdueStats,
      warrantyResponseAgg,
      rfqCount,
    ] = await Promise.all([
      User.countDocuments({ role: { $in: ['customer', 'professional'] }, createdAt: { $gte: from, $lte: to }, ...userCountryMatch }),
      Booking.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to }, ...bookingCountryMatch } },
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            quotedCount: { $sum: { $cond: [{ $or: [{ $ifNull: ['$quote.submittedAt', false] }, { $gt: [{ $size: { $ifNull: ['$quoteVersions', []] } }, 0] }] }, 1, 0] } },
            paidBookingsCount: { $sum: { $cond: [{ $in: ['$status', ['booked', 'in_progress', 'professional_completed', 'completed']] }, 1, 0] } },
          },
        },
      ]),
      Booking.aggregate([
        { $match: completedRevenueMatch },
        {
          $group: {
            _id: null,
            grossRevenue: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$payment.currency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }, { $ifNull: ['$payment.amount', 0] }, 0] } },
            platformRevenue: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$payment.currency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }, { $ifNull: ['$payment.platformCommission', 0] }, 0] } },
            revenueBookings: { $sum: 1 },
          },
        },
      ]),
      Booking.countDocuments({ 'dispute.raisedAt': { $gte: from, $lte: to }, ...bookingCountryMatch }),
      WarrantyClaim.aggregate([
        { $match: { openedAt: { $gte: from, $lte: to } } },
        { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
        { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
        ...(country ? [{ $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> }] : []),
        { $count: 'total' },
      ]),
      Booking.countDocuments({ 'payment.status': { $in: ['refunded', 'partially_refunded'] }, 'payment.refundedAt': { $gte: from, $lte: to }, ...bookingCountryMatch }),
      Booking.aggregate([
        {
          $match: {
            'payment.status': { $in: ['refunded', 'partially_refunded'] },
            'payment.refundedAt': { $gte: from, $lte: to },
            ...bookingCountryMatch,
            $expr: { $eq: [{ $ifNull: ['$payment.currency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] },
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $ifNull: [
                  '$payment.refundAmount',
                  { $ifNull: ['$cancellation.refundAmount', { $ifNull: ['$payment.totalWithVat', { $ifNull: ['$payment.amount', 0] }] }] },
                ],
              },
            },
          },
        },
      ]),
      Booking.countDocuments({ createdAt: { $gte: from, $lte: to }, ...bookingCountryMatch }),
      Booking.aggregate([
        {
          $match: {
            createdAt: { $gte: from, $lte: to },
            ...bookingCountryMatch,
            $or: [
              { 'quote.submittedAt': { $type: 'date' } },
              { 'quoteVersions.0.createdAt': { $type: 'date' } },
            ],
          },
        },
        { $project: { createdAt: 1, firstQuoteAt: { $ifNull: [{ $arrayElemAt: ['$quoteVersions.createdAt', 0] }, '$quote.submittedAt'] } } },
        { $project: { ttfqHours: { $divide: [{ $subtract: ['$firstQuoteAt', '$createdAt'] }, 1000 * 60 * 60] } } },
        { $group: { _id: null, avgHours: { $avg: '$ttfqHours' }, count: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: { 'customerReview.reviewedAt': { $gte: from, $lte: to }, ...bookingCountryMatch } },
        {
          $project: {
            avg: {
              $avg: [
                { $ifNull: ['$customerReview.communicationLevel', null] },
                { $ifNull: ['$customerReview.valueOfDelivery', null] },
                { $ifNull: ['$customerReview.qualityOfService', null] },
              ],
            },
          },
        },
        { $group: { _id: null, count: { $sum: 1 }, avgScore: { $avg: '$avg' } } },
      ]),
      (country
        ? Favorite.aggregate([
            { $match: { createdAt: { $gte: from, $lte: to } } },
            { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'u' } },
            { $unwind: { path: '$u', preserveNullAndEmptyArrays: false } },
            {
              $match: {
                $or: [
                  { 'u.location.country': buildExactCountryRegex(country) },
                  { 'u.companyAddress.country': buildExactCountryRegex(country) },
                  { 'u.businessInfo.country': buildExactCountryRegex(country) },
                ],
              },
            },
            { $count: 'total' },
          ]).then((r) => r[0]?.total || 0)
        : Favorite.countDocuments({ createdAt: { $gte: from, $lte: to } })),
      Booking.countDocuments({ 'rescheduleRequest.requestedAt': { $gte: from, $lte: to }, ...bookingCountryMatch }),
      Booking.countDocuments({ 'noShow.markedAt': { $gte: from, $lte: to }, ...bookingCountryMatch }),
      Booking.aggregate([
        { $match: { status: { $in: ['completed', 'professional_completed', 'in_progress'] }, createdAt: { $gte: from, $lte: to }, scheduledStartDate: { $exists: true, $ne: null }, ...bookingCountryMatch } },
        {
          $project: {
            scheduledStartDate: 1,
            actualStartDate: '$actualStartDate',
            scheduledEnd: '$scheduledExecutionEndDate',
            actualEnd: '$actualEndDate',
            startOverdueDays: {
              $cond: [
                { $and: [{ $ifNull: ['$actualStartDate', false] }, { $ifNull: ['$scheduledStartDate', false] }] },
                { $divide: [{ $subtract: ['$actualStartDate', '$scheduledStartDate'] }, 1000 * 60 * 60 * 24] },
                null,
              ],
            },
            completionOverdueDays: {
              $cond: [
                { $and: [{ $ifNull: ['$actualEndDate', false] }, { $ifNull: ['$scheduledExecutionEndDate', false] }] },
                { $divide: [{ $subtract: ['$actualEndDate', '$scheduledExecutionEndDate'] }, 1000 * 60 * 60 * 24] },
                null,
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            startOverdueCount: { $sum: { $cond: [{ $and: [{ $ne: ['$startOverdueDays', null] }, { $gt: ['$startOverdueDays', 0] }] }, 1, 0] } },
            avgStartOverdue: { $avg: { $cond: [{ $and: [{ $ne: ['$startOverdueDays', null] }, { $gt: ['$startOverdueDays', 0] }] }, '$startOverdueDays', null] } },
            completionOverdueCount: { $sum: { $cond: [{ $and: [{ $ne: ['$completionOverdueDays', null] }, { $gt: ['$completionOverdueDays', 0] }] }, 1, 0] } },
            avgCompletionOverdue: { $avg: { $cond: [{ $and: [{ $ne: ['$completionOverdueDays', null] }, { $gt: ['$completionOverdueDays', 0] }] }, '$completionOverdueDays', null] } },
          },
        },
      ]),
      WarrantyClaim.aggregate([
        { $match: { openedAt: { $gte: from, $lte: to }, 'proposal.proposedAt': { $type: 'date' } } },
        ...(country
          ? [
              { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
              { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
              { $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> },
            ]
          : []),
        { $project: { hours: { $divide: [{ $subtract: ['$proposal.proposedAt', '$openedAt'] }, 1000 * 60 * 60] } } },
        { $group: { _id: null, avgHours: { $avg: '$hours' }, count: { $sum: 1 } } },
      ]),
      Booking.countDocuments({ createdAt: { $gte: from, $lte: to }, bookingType: 'professional', ...bookingCountryMatch }),
    ]);

    const totalViews = await ServiceView.countDocuments({ createdAt: { $gte: from, $lte: to }, ...(country ? { country: buildExactCountryRegex(country) } : {}) });

    const bs = bookingStats[0] || {};
    const rs = revenueStats[0] || {};
    const totalBookings = totalBookingsInRange || 0;
    const ttfq = firstQuoteAvg[0] || {};
    const rev = reviewStats[0] || {};
    const ov = overdueStats[0] || {};
    const wr = warrantyResponseAgg[0] || {};
    const refundAmt = refundAmountAgg[0]?.total || 0;
    const warrantyCountValue = warrantyCount[0]?.total || 0;

    const completedBookings = bs.completedBookings || 0;
    const quotedCount = bs.quotedCount || 0;
    const paidBookingsCount = bs.paidBookingsCount || 0;

    return res.json({
      success: true,
      data: {
        range: { from: from.toISOString(), to: to.toISOString() },
        reportingCurrency: REPORTING_CURRENCY,
        country: country || 'all',
        signUps,
        totalBookings,
        completedBookings,
        grossRevenue: Math.round((rs.grossRevenue || 0) * 100) / 100,
        platformRevenue: Math.round((rs.platformRevenue || 0) * 100) / 100,
        disputeRate: round1(safeRate(disputeCount, totalBookings)),
        warrantyClaimRate: round1(safeRate(warrantyCountValue, totalBookings)),
        refundRate: round1(safeRate(refundCount, totalBookings)),
        refundAmount: Math.round(refundAmt * 100) / 100,
        avgTimeToFirstQuoteHours: round1(ttfq.avgHours),
        quotedBookingsCount: ttfq.count || 0,
        views: totalViews,
        noShowRate: round1(safeRate(noShowCount, totalBookings)),
        rfqCount,
        quotationResponseRate: round1(safeRate(quotedCount, rfqCount || totalBookings)),
        quotationConversionRate: round1(safeRate(paidBookingsCount, quotedCount)),
        bookingRate: round1(safeRate(paidBookingsCount, totalViews)),
        reviewsCount: rev.count || 0,
        avgReviewScore: round1(rev.avgScore),
        favoritesCount: favoritesCount || 0,
        avgWarrantyResponseTimeHours: round1(wr.avgHours),
        reschedulingRate: round1(safeRate(reschedulingCount, totalBookings)),
        startOverdueRate: round1(safeRate(ov.startOverdueCount, ov.total)),
        avgStartOverdueDays: round1(ov.avgStartOverdue),
        completionOverdueRate: round1(safeRate(ov.completionOverdueCount, ov.total)),
        avgCompletionOverdueDays: round1(ov.avgCompletionOverdue),
      },
    });
  } catch (error) {
    console.error('KPI summary error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI summary' } });
  }
};

// ---------- by region ----------

export const getKpiByRegion = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const country = parseCountry(req);
    const bookingCountryMatch = buildBookingCountryMatch(country);
    const userCountryMatch = buildUserCountryMatch(country);

    const userRows = await User.aggregate([
      { $match: { role: { $in: ['customer', 'professional'] }, createdAt: { $gte: from, $lte: to }, ...userCountryMatch } },
      { $group: { _id: normalizeUserCityExpr, signUps: { $sum: 1 } } },
    ]);

    const viewRows = await ServiceView.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, ...(country ? { country: buildExactCountryRegex(country) } : {}) } },
      {
        $group: {
          _id: { $cond: [{ $or: [{ $eq: ['$city', null] }, { $eq: [{ $trim: { input: { $ifNull: ['$city', ''] } } }, ''] }] }, '__unknown__', { $toLower: { $trim: { input: '$city' } } }] },
          views: { $sum: 1 },
        },
      },
    ]);

    const bookingRows = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, ...bookingCountryMatch } },
      { $project: { city: normalizeCityExpr, ...bookingMetricsProjection('$payment.currency') } },
      { $group: { _id: '$city', ...bookingMetricsAccumulators } },
    ]);

    const warrantyRows = await WarrantyClaim.aggregate([
      { $match: { openedAt: { $gte: from, $lte: to } } },
      { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
      { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
      ...(country ? [{ $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> }] : []),
      {
        $project: {
          city: {
            $let: {
              vars: { raw: { $ifNull: ['$b.location.city', null] } },
              in: { $cond: [{ $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }] }, '__unknown__', { $toLower: { $trim: { input: '$$raw' } } }] },
            },
          },
          responseHours: { $cond: [{ $ifNull: ['$proposal.proposedAt', false] }, { $divide: [{ $subtract: ['$proposal.proposedAt', '$openedAt'] }, 1000 * 60 * 60] }, null] },
        },
      },
      {
        $group: {
          _id: '$city',
          warrantyCount: { $sum: 1 },
          avgWarrantyResponseHours: { $avg: '$responseHours' },
        },
      },
    ]);

    const favoriteRows = await Favorite.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'u' } },
      { $unwind: { path: '$u', preserveNullAndEmptyArrays: false } },
      ...(country
        ? [{
            $match: {
              $or: [
                { 'u.location.country': buildExactCountryRegex(country) },
                { 'u.companyAddress.country': buildExactCountryRegex(country) },
                { 'u.businessInfo.country': buildExactCountryRegex(country) },
              ],
            } as Record<string, unknown>,
          }]
        : []),
      { $group: { _id: normalizeUserCityExpr, favoritesCount: { $sum: 1 } } },
    ]);

    const byCity = new Map<string, Record<string, unknown>>();
    const ensure = (key: string) => {
      if (!byCity.has(key)) {
        byCity.set(key, { city: formatCity(key), signUps: 0, views: 0, warrantyCount: 0, avgWarrantyResponseHours: null, favoritesCount: 0 });
      }
      return byCity.get(key)!;
    };

    for (const r of userRows) ensure(r._id).signUps = r.signUps;
    for (const r of viewRows) ensure(r._id).views = r.views;
    for (const r of bookingRows) {
      const row = ensure(r._id);
      Object.assign(row, deriveBookingRates(r as GroupAgg, (row.views as number) || 0));
      row.bookedValue = (row as Record<string, number>).grossRevenue;
    }
    for (const r of warrantyRows) {
      const row = ensure(r._id);
      row.warrantyCount = r.warrantyCount;
      row.avgWarrantyResponseHours = round1(r.avgWarrantyResponseHours);
    }
    for (const r of favoriteRows) ensure(r._id).favoritesCount = r.favoritesCount;

    const rows: Array<Record<string, number | string | null>> = Array.from(byCity.values()).map((r) => {
      const obj = r as Record<string, number | string | null>;
      const totalRfqs = (obj.totalRfqs as number) || 0;
      return {
        ...obj,
        views: (obj.views as number) || 0,
        bookingRate: round1(safeRate((obj.bookingsCount as number) || 0, (obj.views as number) || 0)),
        warrantyClaimRate: round1(safeRate((obj.warrantyCount as number) || 0, totalRfqs)),
      };
    });

    rows.sort((a, b) => (Number(b.bookedValue) || 0) - (Number(a.bookedValue) || 0) || (Number(b.totalBookings) || 0) - (Number(a.totalBookings) || 0));

    return res.json({ success: true, data: { range: { from, to }, reportingCurrency: REPORTING_CURRENCY, rows } });
  } catch (error) {
    console.error('KPI by-region error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI by region' } });
  }
};

// ---------- by service ----------

export const getKpiByService = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const country = parseCountry(req);
    const bookingCountryMatch = buildBookingCountryMatch(country);

    const viewRows = await ServiceView.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, ...(country ? { country: buildExactCountryRegex(country) } : {}) } },
      { $group: { _id: '$serviceId', views: { $sum: 1 } } },
    ]);

    const bookingRows = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, ...bookingCountryMatch } },
      { $lookup: { from: 'projects', localField: 'project', foreignField: '_id', as: 'proj' } },
      { $unwind: { path: '$proj', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          serviceRaw: { $trim: { input: { $ifNull: ['$proj.service', { $ifNull: ['$rfqData.serviceType', ''] }] } } },
          ...bookingMetricsProjection('$payment.currency'),
        },
      },
      {
        $group: {
          _id: { $cond: [{ $eq: ['$serviceRaw', ''] }, '__unknown__', { $toLower: '$serviceRaw' }] },
          serviceLabel: { $first: '$serviceRaw' },
          ...bookingMetricsAccumulators,
        },
      },
    ]);

    const warrantyRows = await WarrantyClaim.aggregate([
      { $match: { openedAt: { $gte: from, $lte: to } } },
      { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
      { $unwind: { path: '$b', preserveNullAndEmptyArrays: false } },
      ...(country ? [{ $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> }] : []),
      { $lookup: { from: 'projects', localField: 'b.project', foreignField: '_id', as: 'proj' } },
      { $unwind: { path: '$proj', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          serviceKey: {
            $let: {
              vars: { raw: { $trim: { input: { $ifNull: ['$proj.service', { $ifNull: ['$b.rfqData.serviceType', ''] }] } } } },
              in: { $cond: [{ $eq: ['$$raw', ''] }, '__unknown__', { $toLower: '$$raw' }] },
            },
          },
          responseHours: { $cond: [{ $ifNull: ['$proposal.proposedAt', false] }, { $divide: [{ $subtract: ['$proposal.proposedAt', '$openedAt'] }, 1000 * 60 * 60] }, null] },
        },
      },
      { $group: { _id: '$serviceKey', warrantyCount: { $sum: 1 }, avgWarrantyResponseHours: { $avg: '$responseHours' } } },
    ]);

    const warrantyByService = new Map<string, { warrantyCount: number; avgWarrantyResponseHours: number | null }>();
    for (const r of warrantyRows) warrantyByService.set(String(r._id), { warrantyCount: r.warrantyCount, avgWarrantyResponseHours: round1(r.avgWarrantyResponseHours) });

    const favoriteRows = await Favorite.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, targetType: 'project' } },
      { $lookup: { from: 'projects', localField: 'targetId', foreignField: '_id', as: 'proj' } },
      { $unwind: { path: '$proj', preserveNullAndEmptyArrays: false } },
      ...(country
        ? [
            { $lookup: { from: 'users', localField: 'proj.professionalId', foreignField: '_id', as: 'pro' } },
            { $unwind: { path: '$pro', preserveNullAndEmptyArrays: false } },
            {
              $match: {
                $or: [
                  { 'pro.location.country': buildExactCountryRegex(country) },
                  { 'pro.companyAddress.country': buildExactCountryRegex(country) },
                  { 'pro.businessInfo.country': buildExactCountryRegex(country) },
                ],
              } as Record<string, unknown>,
            },
          ]
        : []),
      {
        $project: {
          serviceKey: {
            $let: {
              vars: { raw: { $trim: { input: { $ifNull: ['$proj.service', ''] } } } },
              in: { $cond: [{ $eq: ['$$raw', ''] }, '__unknown__', { $toLower: '$$raw' }] },
            },
          },
        },
      },
      { $group: { _id: '$serviceKey', favoritesCount: { $sum: 1 } } },
    ]);
    const favByService = new Map<string, number>();
    for (const r of favoriteRows) favByService.set(String(r._id), r.favoritesCount);

    const serviceViews = viewRows
      .map((r) => ({ serviceId: String(r._id || ''), views: r.views }))
      .sort((a, b) => b.views - a.views);

    const serviceBookings = bookingRows
      .map((r) => {
        const w = warrantyByService.get(String(r._id)) || { warrantyCount: 0, avgWarrantyResponseHours: null };
        const base = deriveBookingRates(r as GroupAgg);
        return {
          serviceType: r._id === '__unknown__' ? 'Unknown' : String(r.serviceLabel || r._id || ''),
          ...base,
          completedCount: base.completedBookings,
          warrantyCount: w.warrantyCount,
          avgWarrantyResponseHours: w.avgWarrantyResponseHours,
          warrantyClaimRate: round1(safeRate(w.warrantyCount, base.totalRfqs || 0)),
          favoritesCount: favByService.get(String(r._id)) || 0,
        };
      })
      .sort((a, b) => (b.platformRevenue || 0) - (a.platformRevenue || 0) || b.bookingsCount - a.bookingsCount);

    return res.json({ success: true, data: { range: { from, to }, serviceViews, serviceBookings } });
  } catch (error) {
    console.error('KPI by-service error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI by service' } });
  }
};

// ---------- by subproject ----------

export const getKpiBySubproject = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const country = parseCountry(req);
    const bookingCountryMatch = buildBookingCountryMatch(country);

    const grouped = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, selectedSubprojectIndex: { $exists: true, $ne: null }, ...bookingCountryMatch } },
      { $lookup: { from: 'projects', localField: 'project', foreignField: '_id', as: 'proj' } },
      { $unwind: { path: '$proj', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          projectId: '$project',
          subIdx: '$selectedSubprojectIndex',
          subprojectName: {
            $let: {
              vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } },
              in: { $ifNull: ['$$sp.name', { $concat: ['Subproject #', { $toString: '$selectedSubprojectIndex' }] }] },
            },
          },
          projectTitle: '$proj.title',
          executionDuration: { $let: { vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } }, in: '$$sp.executionDuration' } },
          preparationDuration: { $let: { vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } }, in: '$$sp.preparationDuration' } },
          bufferDuration: { $let: { vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } }, in: '$$sp.bufferDuration' } },
          price: { $let: { vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } }, in: '$$sp.pricing.amount' } },
          ...bookingMetricsProjection('$payment.currency'),
        },
      },
      {
        $group: {
          _id: { project: '$projectTitle', sub: '$subprojectName', projectId: '$projectId', subIdx: '$subIdx' },
          ...bookingMetricsAccumulators,
          execution: { $first: '$executionDuration' },
          preparation: { $first: '$preparationDuration' },
          buffer: { $first: '$bufferDuration' },
          price: { $first: '$price' },
        },
      },
    ]);

    const warrantyRows = await WarrantyClaim.aggregate([
      { $match: { openedAt: { $gte: from, $lte: to } } },
      { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
      { $unwind: { path: '$b', preserveNullAndEmptyArrays: false } },
      { $match: { 'b.selectedSubprojectIndex': { $exists: true, $ne: null } } },
      ...(country ? [{ $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> }] : []),
      {
        $project: {
          projectId: '$b.project',
          subIdx: '$b.selectedSubprojectIndex',
          responseHours: { $cond: [{ $ifNull: ['$proposal.proposedAt', false] }, { $divide: [{ $subtract: ['$proposal.proposedAt', '$openedAt'] }, 1000 * 60 * 60] }, null] },
        },
      },
      { $group: { _id: { projectId: '$projectId', subIdx: '$subIdx' }, warrantyCount: { $sum: 1 }, avgWarrantyResponseHours: { $avg: '$responseHours' } } },
    ]);

    const warrantyBySub = new Map<string, { warrantyCount: number; avgWarrantyResponseHours: number | null }>();
    for (const r of warrantyRows) warrantyBySub.set(`${String(r._id.projectId)}|${String(r._id.subIdx)}`, { warrantyCount: r.warrantyCount, avgWarrantyResponseHours: round1(r.avgWarrantyResponseHours) });

    const rows = grouped
      .map((r) => {
        const w = warrantyBySub.get(`${String(r._id.projectId)}|${String(r._id.subIdx)}`) || { warrantyCount: 0, avgWarrantyResponseHours: null };
        const base = deriveBookingRates(r as GroupAgg);
        return {
          projectTitle: r._id.project,
          subprojectName: r._id.sub,
          ...base,
          completedCount: base.completedBookings,
          warrantyCount: w.warrantyCount,
          avgWarrantyResponseHours: w.avgWarrantyResponseHours,
          warrantyClaimRate: round1(safeRate(w.warrantyCount, base.totalRfqs || 0)),
          executionDuration: r.execution,
          preparationDuration: r.preparation,
          bufferDuration: r.buffer,
          price: r.price,
        };
      })
      .sort((a, b) => (b.bookingsCount || 0) - (a.bookingsCount || 0) || (b.totalRfqs || 0) - (a.totalRfqs || 0));

    return res.json({ success: true, data: { range: { from, to }, rows } });
  } catch (error) {
    console.error('KPI by-subproject error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI by subproject' } });
  }
};

// ---------- by professional ----------

export const getKpiByProfessional = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const country = parseCountry(req);
    const bookingCountryMatch = buildBookingCountryMatch(country);

    const grouped = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, professional: { $ne: null }, ...bookingCountryMatch } },
      { $project: { professional: 1, ...bookingMetricsProjection('$payment.currency') } },
      { $group: { _id: '$professional', ...bookingMetricsAccumulators } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'pro' } },
      { $unwind: { path: '$pro', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          professionalId: '$_id',
          name: { $ifNull: ['$pro.businessInfo.companyName', { $ifNull: ['$pro.name', { $ifNull: ['$pro.username', '$pro.email'] }] }] },
          email: '$pro.email',
          city: { $ifNull: ['$pro.businessInfo.city', '$pro.location.city'] },
          country: { $ifNull: ['$pro.location.country', '$pro.businessInfo.country'] },
          professionalLevel: '$pro.professionalLevel',
          createdProjects: { $size: { $ifNull: ['$pro.projects', []] } },
          suspendedAccount: { $cond: [{ $eq: ['$pro.suspended', true] }, 1, 0] },
          metrics: '$$ROOT',
        },
      },
    ]);

    const warrantyRows = await WarrantyClaim.aggregate([
      { $match: { openedAt: { $gte: from, $lte: to }, professional: { $ne: null } } },
      ...(country
        ? [
            { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
            { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
            { $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> },
          ]
        : []),
      {
        $project: {
          professional: 1,
          responseHours: { $cond: [{ $ifNull: ['$proposal.proposedAt', false] }, { $divide: [{ $subtract: ['$proposal.proposedAt', '$openedAt'] }, 1000 * 60 * 60] }, null] },
        },
      },
      { $group: { _id: '$professional', warrantyCount: { $sum: 1 }, avgWarrantyResponseHours: { $avg: '$responseHours' } } },
    ]);
    const warrantyByPro = new Map<string, { warrantyCount: number; avgWarrantyResponseHours: number | null }>();
    for (const r of warrantyRows) warrantyByPro.set(String(r._id), { warrantyCount: r.warrantyCount, avgWarrantyResponseHours: round1(r.avgWarrantyResponseHours) });

    const favoriteRows = await Favorite.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, targetType: 'professional' } },
      { $group: { _id: '$targetId', favoritesCount: { $sum: 1 } } },
    ]);
    const favByPro = new Map<string, number>();
    for (const r of favoriteRows) favByPro.set(String(r._id), r.favoritesCount);

    const rows = grouped
      .map((r) => {
        const m = r.metrics as GroupAgg;
        const base = deriveBookingRates(m);
        const w = warrantyByPro.get(String(r.professionalId)) || { warrantyCount: 0, avgWarrantyResponseHours: null };
        return {
          professionalId: r.professionalId,
          name: r.name,
          email: r.email,
          city: r.city,
          country: r.country,
          professionalLevel: r.professionalLevel,
          createdProjects: r.createdProjects,
          suspendedAccount: r.suspendedAccount,
          rfqsReceived: base.totalRfqs,
          ...base,
          completedCount: base.completedBookings,
          warrantyCount: w.warrantyCount,
          avgWarrantyResponseHours: w.avgWarrantyResponseHours,
          warrantyClaimRate: round1(safeRate(w.warrantyCount, base.totalRfqs || 0)),
          favoritesCount: favByPro.get(String(r.professionalId)) || 0,
        };
      })
      .sort((a, b) => (b.platformRevenue || 0) - (a.platformRevenue || 0) || (b.grossRevenue || 0) - (a.grossRevenue || 0) || (b.bookingsCount || 0) - (a.bookingsCount || 0));

    return res.json({ success: true, data: { range: { from, to }, rows } });
  } catch (error) {
    console.error('KPI by-professional error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI by professional' } });
  }
};

// ---------- by customer ----------

export const getKpiByCustomer = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const country = parseCountry(req);
    const bookingCountryMatch = buildBookingCountryMatch(country);

    const grouped = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, customer: { $ne: null }, ...bookingCountryMatch } },
      { $project: { customer: 1, capturedAt: '$payment.capturedAt', ...bookingMetricsProjection('$payment.currency') } },
      {
        $group: {
          _id: '$customer',
          ...bookingMetricsAccumulators,
          paymentDurationsMs: { $push: { $cond: [{ $and: [{ $ifNull: ['$capturedAt', false] }, { $ifNull: ['$createdAt', false] }] }, { $subtract: ['$capturedAt', '$createdAt'] }, null] } },
        },
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'cust' } },
      { $unwind: { path: '$cust', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          customerId: '$_id',
          name: { $ifNull: ['$cust.name', { $ifNull: ['$cust.username', '$cust.email'] }] },
          email: '$cust.email',
          city: { $ifNull: ['$cust.location.city', '$cust.companyAddress.city'] },
          country: { $ifNull: ['$cust.location.country', '$cust.companyAddress.country'] },
          loyaltyLevel: { $ifNull: ['$cust.loyaltyTier', null] },
          avgPaymentTimeHours: {
            $let: {
              vars: { ds: { $filter: { input: '$paymentDurationsMs', as: 'd', cond: { $ne: ['$$d', null] } } } },
              in: { $cond: [{ $gt: [{ $size: '$$ds' }, 0] }, { $round: [{ $divide: [{ $avg: '$$ds' }, 1000 * 60 * 60] }, 1] }, null] },
            },
          },
          metrics: '$$ROOT',
        },
      },
    ]);

    const warrantyRows = await WarrantyClaim.aggregate([
      { $match: { openedAt: { $gte: from, $lte: to }, customer: { $ne: null } } },
      ...(country
        ? [
            { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
            { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
            { $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> },
          ]
        : []),
      {
        $project: {
          customer: 1,
          responseHours: { $cond: [{ $ifNull: ['$proposal.proposedAt', false] }, { $divide: [{ $subtract: ['$proposal.proposedAt', '$openedAt'] }, 1000 * 60 * 60] }, null] },
        },
      },
      { $group: { _id: '$customer', warrantyCount: { $sum: 1 }, avgWarrantyResponseHours: { $avg: '$responseHours' } } },
    ]);
    const warrantyByCust = new Map<string, { warrantyCount: number; avgWarrantyResponseHours: number | null }>();
    for (const r of warrantyRows) warrantyByCust.set(String(r._id), { warrantyCount: r.warrantyCount, avgWarrantyResponseHours: round1(r.avgWarrantyResponseHours) });

    const rows = grouped
      .map((r) => {
        const base = deriveBookingRates(r.metrics as GroupAgg);
        const w = warrantyByCust.get(String(r.customerId)) || { warrantyCount: 0, avgWarrantyResponseHours: null };
        return {
          customerId: r.customerId,
          name: r.name,
          email: r.email,
          city: r.city,
          country: r.country,
          loyaltyLevel: r.loyaltyLevel,
          avgPaymentTimeHours: r.avgPaymentTimeHours,
          rfqsCreated: base.totalRfqs,
          ...base,
          completedCount: base.completedBookings,
          grossSpend: base.grossRevenue,
          warrantyCount: w.warrantyCount,
          avgWarrantyResponseHours: w.avgWarrantyResponseHours,
          warrantyClaimRate: round1(safeRate(w.warrantyCount, base.totalRfqs || 0)),
        };
      })
      .sort((a, b) => (b.platformRevenue || 0) - (a.platformRevenue || 0) || (b.grossSpend || 0) - (a.grossSpend || 0) || (b.bookingsCount || 0) - (a.bookingsCount || 0));

    return res.json({ success: true, data: { range: { from, to }, rows } });
  } catch (error) {
    console.error('KPI by-customer error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI by customer' } });
  }
};

// ---------- professional response times ----------

export const getKpiProfessionalResponse = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const country = parseCountry(req);
    const bookingCountryMatch = buildBookingCountryMatch(country);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);

    const rows = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: from, $lte: to },
          professional: { $ne: null },
          ...bookingCountryMatch,
          $or: [
            { 'quote.submittedAt': { $type: 'date' } },
            { 'quoteVersions.0.createdAt': { $type: 'date' } },
          ],
        },
      },
      { $project: { professional: 1, createdAt: 1, firstQuoteAt: { $ifNull: [{ $arrayElemAt: ['$quoteVersions.createdAt', 0] }, '$quote.submittedAt'] } } },
      { $project: { professional: 1, ttfqHours: { $divide: [{ $subtract: ['$firstQuoteAt', '$createdAt'] }, 1000 * 60 * 60] } } },
      { $group: { _id: '$professional', avgHours: { $avg: '$ttfqHours' }, minHours: { $min: '$ttfqHours' }, maxHours: { $max: '$ttfqHours' }, quotesSent: { $sum: 1 } } },
      { $sort: { avgHours: 1 } },
      { $limit: limit },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'pro' } },
      { $unwind: { path: '$pro', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          professionalId: '$_id',
          name: '$pro.name',
          email: '$pro.email',
          city: '$pro.businessInfo.city',
          avgHours: { $round: ['$avgHours', 1] },
          minHours: { $round: ['$minHours', 1] },
          maxHours: { $round: ['$maxHours', 1] },
          quotesSent: 1,
        },
      },
    ]);

    return res.json({ success: true, data: { range: { from, to }, rows } });
  } catch (error) {
    console.error('KPI professional-response error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute professional response KPIs' } });
  }
};

// ---------- CSV/XLSX export ----------

export const exportKpiCsv = async (req: Request, res: Response) => {
  try {
    const section = String(req.query.section || 'region');
    const format = String(req.query.format || 'csv').toLowerCase();
    const { from, to } = parseRange(req);
    const dateSlug = `${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}`;

    let headers: string[] = [];
    let rows: unknown[][] = [];
    const filename = `fixtract-kpi-${section}-${dateSlug}.${format === 'xlsx' ? 'xlsx' : 'csv'}`;

    type Row = Record<string, number | string | null | undefined>;
    if (section === 'region') {
      const data = ((await captureJson(getKpiByRegion, req))?.data?.rows || []) as Row[];
      headers = ['City', 'Sign-ups', 'Service views', 'Total bookings', 'Completed bookings', 'Booked value (EUR)', 'Platform revenue (EUR)', 'Quotation conversion rate (%)', 'Dispute rate (%)', 'Warranty claim rate (%)', 'Refund rate (%)'];
      rows = data.map((r) => [r.city, r.signUps, r.views, r.totalBookings, r.completedBookings, Number(r.bookedValue ?? 0).toFixed(2), Number(r.platformRevenue ?? 0).toFixed(2), r.quotationConversionRate, r.disputeRate, r.warrantyClaimRate, r.refundRate]);
    } else if (section === 'service') {
      const data = ((await captureJson(getKpiByService, req))?.data?.serviceBookings || []) as Row[];
      headers = ['Service type', 'RFQs', 'Quotes sent', 'Bookings', 'Completed', 'Gross revenue (EUR)', 'Platform revenue (EUR)', 'Quotation conversion (%)', 'Avg time to first quote (h)'];
      rows = data.map((r) => [r.serviceType, r.totalRfqs, r.quotedCount, r.bookingsCount, r.completedCount, Number(r.grossRevenue ?? 0).toFixed(2), Number(r.platformRevenue ?? 0).toFixed(2), r.quotationConversionRate, r.avgTtfqHours ?? '']);
    } else if (section === 'service-views') {
      const data = ((await captureJson(getKpiByService, req))?.data?.serviceViews || []) as Row[];
      headers = ['Service slug', 'Views'];
      rows = data.map((r) => [r.serviceId, r.views]);
    } else if (section === 'subproject') {
      const data = ((await captureJson(getKpiBySubproject, req))?.data?.rows || []) as Row[];
      headers = ['Project', 'Subproject', 'RFQs', 'Bookings', 'Completed', 'Disputes', 'Refunds', 'Reschedules', 'Gross revenue (EUR)', 'Platform revenue (EUR)', 'Price'];
      rows = data.map((r) => [r.projectTitle, r.subprojectName, r.totalRfqs, r.bookingsCount, r.completedCount, r.disputeCount, r.refundCount, r.reschedulingCount, Number(r.grossRevenue ?? 0).toFixed(2), Number(r.platformRevenue ?? 0).toFixed(2), r.price]);
    } else if (section === 'professional') {
      const data = ((await captureJson(getKpiByProfessional, req))?.data?.rows || []) as Row[];
      headers = ['Name', 'Email', 'City', 'Level', 'Created projects', 'RFQs received', 'Quoted', 'Bookings', 'Completed', 'Disputes', 'Refunds', 'Reschedules', 'Avg TTFQ (h)', 'Avg review', 'Gross revenue (EUR)', 'Platform revenue (EUR)'];
      rows = data.map((r) => [r.name, r.email, r.city, r.professionalLevel, r.createdProjects, r.rfqsReceived, r.quotedCount, r.bookingsCount, r.completedCount, r.disputeCount, r.refundCount, r.reschedulingCount, r.avgTtfqHours, r.avgReviewScore, Number(r.grossRevenue ?? 0).toFixed(2), Number(r.platformRevenue ?? 0).toFixed(2)]);
    } else if (section === 'customer') {
      const data = ((await captureJson(getKpiByCustomer, req))?.data?.rows || []) as Row[];
      headers = ['Name', 'Email', 'City', 'Loyalty', 'RFQs', 'Bookings', 'Completed', 'Disputes', 'Refunds', 'Reschedules', 'Avg payment time (h)', 'Gross spend (EUR)', 'Platform revenue (EUR)'];
      rows = data.map((r) => [r.name, r.email, r.city, r.loyaltyLevel, r.rfqsCreated, r.bookingsCount, r.completedCount, r.disputeCount, r.refundCount, r.reschedulingCount, r.avgPaymentTimeHours, Number(r.grossSpend ?? 0).toFixed(2), Number(r.platformRevenue ?? 0).toFixed(2)]);
    } else if (section === 'response') {
      const data = ((await captureJson(getKpiProfessionalResponse, req))?.data?.rows || []) as Row[];
      headers = ['Professional', 'Email', 'City', 'Quotes sent', 'Avg hours', 'Min hours', 'Max hours'];
      rows = data.map((r) => [r.name || '', r.email || '', r.city || '', r.quotesSent, r.avgHours, r.minHours, r.maxHours]);
    } else {
      return res.status(400).json({ success: false, error: { code: 'BAD_SECTION', message: 'Unknown section' } });
    }

    if (format === 'xlsx') {
      const xlsxXml = buildSimpleXlsxLikeXml(headers, rows);
      res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\.xlsx$/, '.xls')}"`);
      return res.send(xlsxXml);
    }

    const csv = buildCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (error) {
    console.error('KPI export error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to export KPI data' } });
  }
};

// Excel can open an XML Spreadsheet 2003 file; this avoids adding an xlsx dependency.
function buildSimpleXlsxLikeXml(headers: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const headerCells = headers.map((h) => `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('');
  const bodyRows = rows.map((row) => {
    const cells = row.map((v) => {
      const isNum = typeof v === 'number' && Number.isFinite(v);
      return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${esc(v)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="KPI"><Table><Row>${headerCells}</Row>${bodyRows}</Table></Worksheet>
</Workbook>`;
}

type CapturedPayload = { data?: Record<string, unknown>; success?: boolean; error?: { message?: string }; msg?: string };

async function captureJson(handler: (req: Request, res: Response) => Promise<unknown>, req: Request): Promise<CapturedPayload | null> {
  let captured: CapturedPayload | null = null;
  const state = { statusCode: 200 };
  const fakeRes: Partial<Response> = {
    setHeader: () => fakeRes as Response,
    status(code: number) { state.statusCode = code; return fakeRes as Response; },
    json(payload: CapturedPayload) { captured = payload; return fakeRes as Response; },
    send(payload: CapturedPayload) { captured = payload; return fakeRes as Response; },
  };
  await handler(req, fakeRes as Response);
  if (state.statusCode >= 400 || (captured && (captured as CapturedPayload).success === false)) {
    const message = (captured as CapturedPayload | null)?.error?.message
      || (captured as CapturedPayload | null)?.msg
      || `KPI handler failed with status ${state.statusCode}`;
    throw new Error(message);
  }
  return captured;
}

// ---------- background email report ----------

export const triggerKpiEmailReport = async (req: Request, res: Response) => {
  try {
    const adminUser = (req as Request & { admin?: { _id?: unknown; email?: unknown } }).admin;
    if (!adminUser?._id || !adminUser?.email) {
      return res.status(401).json({ success: false, msg: 'Admin authentication required' });
    }

    const { from, to } = parseRange(req);
    const adminId = String(adminUser._id);
    const adminEmail = String(adminUser.email);

    res.status(202).json({
      success: true,
      data: {
        queued: true,
        message: 'Report is being prepared and will be emailed to you.',
        range: { from: from.toISOString(), to: to.toISOString() },
      },
    });

    setImmediate(async () => {
      try {
        const { generateKpiPdf } = await import('../../utils/kpiReport');
        const { sendKpiReportEmail } = await import('../../utils/emailService');
        const { uploadBufferToS3 } = await import('../../utils/s3Upload');
        const buffer = await generateKpiPdf(from, to);
        const key = `kpi-reports/${adminId}/${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
        const reportUrl = await uploadBufferToS3(buffer, key, 'application/pdf');
        await sendKpiReportEmail(adminEmail, { from, to, reportUrl });
      } catch (e) {
        console.error('KPI background report failed', e);
        try {
          const { sendKpiReportEmail } = await import('../../utils/emailService');
          await sendKpiReportEmail(adminEmail, { from, to, error: (e as Error)?.message || 'Unknown error' });
        } catch (innerErr) {
          console.error('Failed to send KPI failure email', innerErr);
        }
      }
    });
  } catch (error) {
    console.error('KPI email-report trigger error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to trigger report' } });
    }
  }
};
