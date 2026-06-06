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
      {
        $group: {
          _id: normalizeCityExpr,
          totalBookings: { $sum: 1 },
          completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          bookedValue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$payment.currency', null] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$payment.amount', 0] }, 0] } },
          platformRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$payment.currency', null] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$payment.platformCommission', 0] }, 0] } },
          quotedCount: { $sum: { $cond: [{ $or: [{ $ifNull: ['$quote.submittedAt', false] }, { $gt: [{ $size: { $ifNull: ['$quoteVersions', []] } }, 0] }] }, 1, 0] } },
          acceptedCount: { $sum: { $cond: [{ $in: ['$status', ['quote_accepted', 'payment_pending', 'booked', 'in_progress', 'professional_completed', 'completed']] }, 1, 0] } },
          disputeCount: { $sum: { $cond: [{ $ifNull: ['$dispute.raisedAt', false] }, 1, 0] } },
          refundCount: { $sum: { $cond: [{ $in: ['$payment.status', ['refunded', 'partially_refunded']] }, 1, 0] } },
        },
      },
    ]);

    const warrantyRows = await WarrantyClaim.aggregate([
      { $match: { openedAt: { $gte: from, $lte: to } } },
      { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b' } },
      { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
      ...(country ? [{ $match: { 'b.location.country': buildExactCountryRegex(country) } as Record<string, unknown> }] : []),
      {
        $group: {
          _id: {
            $let: {
              vars: { raw: { $ifNull: ['$b.location.city', null] } },
              in: { $cond: [{ $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }] }, '__unknown__', { $toLower: { $trim: { input: '$$raw' } } }] },
            },
          },
          warrantyCount: { $sum: 1 },
        },
      },
    ]);

    const byCity = new Map<string, Record<string, unknown>>();
    const ensure = (key: string) => {
      if (!byCity.has(key)) {
        byCity.set(key, {
          city: formatCity(key), signUps: 0, views: 0, totalBookings: 0, completedBookings: 0,
          bookedValue: 0, platformRevenue: 0, quotedCount: 0, acceptedCount: 0,
          disputeCount: 0, warrantyCount: 0, refundCount: 0,
        });
      }
      return byCity.get(key)!;
    };

    for (const r of userRows) ensure(r._id).signUps = r.signUps;
    for (const r of viewRows) ensure(r._id).views = r.views;
    for (const r of bookingRows) {
      const row = ensure(r._id);
      row.totalBookings = r.totalBookings;
      row.completedBookings = r.completedBookings;
      row.bookedValue = Math.round((r.bookedValue || 0) * 100) / 100;
      row.platformRevenue = Math.round((r.platformRevenue || 0) * 100) / 100;
      row.quotedCount = r.quotedCount;
      row.acceptedCount = r.acceptedCount;
      row.disputeCount = r.disputeCount;
      row.refundCount = r.refundCount;
    }
    for (const r of warrantyRows) ensure(r._id).warrantyCount = r.warrantyCount;

    const rows: Array<Record<string, number | string | null>> = Array.from(byCity.values()).map((r) => {
      const obj = r as Record<string, number | string>;
      return {
        ...obj,
        disputeRate: round1(safeRate(obj.disputeCount as number, obj.totalBookings as number)),
        warrantyClaimRate: round1(safeRate(obj.warrantyCount as number, obj.totalBookings as number)),
        refundRate: round1(safeRate(obj.refundCount as number, obj.totalBookings as number)),
        quotationConversionRate: round1(safeRate(obj.acceptedCount as number, obj.quotedCount as number)),
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
          serviceRaw: {
            $trim: { input: { $ifNull: ['$proj.service', { $ifNull: ['$rfqData.serviceType', ''] }] } },
          },
          status: 1,
          createdAt: 1,
          paymentAmount: '$payment.amount',
          platformCommission: '$payment.platformCommission',
          paymentCurrency: '$payment.currency',
          paymentStatus: '$payment.status',
          rescheduleRequestAt: '$rescheduleRequest.requestedAt',
          quoted: { $or: [{ $ifNull: ['$quote.submittedAt', false] }, { $gt: [{ $size: { $ifNull: ['$quoteVersions', []] } }, 0] }] },
          firstQuoteAt: { $ifNull: [{ $arrayElemAt: ['$quoteVersions.createdAt', 0] }, '$quote.submittedAt'] },
        },
      },
      {
        $group: {
          _id: { $cond: [{ $eq: ['$serviceRaw', ''] }, '__unknown__', { $toLower: '$serviceRaw' }] },
          serviceLabel: { $first: '$serviceRaw' },
          totalRfqs: { $sum: 1 },
          quotedCount: { $sum: { $cond: ['$quoted', 1, 0] } },
          bookingsCount: { $sum: { $cond: [{ $in: ['$status', ['booked', 'in_progress', 'professional_completed', 'completed']] }, 1, 0] } },
          completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          disputeCount: { $sum: { $cond: [{ $eq: ['$status', 'dispute'] }, 1, 0] } },
          refundCount: { $sum: { $cond: [{ $in: ['$paymentStatus', ['refunded', 'partially_refunded']] }, 1, 0] } },
          reschedulingCount: { $sum: { $cond: [{ $ifNull: ['$rescheduleRequestAt', false] }, 1, 0] } },
          grossRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$paymentCurrency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$paymentAmount', 0] }, 0] } },
          platformRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$paymentCurrency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$platformCommission', 0] }, 0] } },
          avgTtfqHours: { $avg: { $cond: ['$quoted', { $divide: [{ $subtract: ['$firstQuoteAt', '$createdAt'] }, 1000 * 60 * 60] }, null] } },
        },
      },
    ]);

    const serviceViews = viewRows
      .map((r) => ({ serviceId: String(r._id || ''), views: r.views }))
      .sort((a, b) => b.views - a.views);

    const serviceBookings = bookingRows
      .map((r) => ({
        serviceType: r._id === '__unknown__' ? 'Unknown' : String(r.serviceLabel || r._id || ''),
        totalRfqs: r.totalRfqs,
        quotedCount: r.quotedCount,
        bookingsCount: r.bookingsCount,
        completedCount: r.completedCount,
        disputeCount: r.disputeCount,
        refundCount: r.refundCount,
        reschedulingCount: r.reschedulingCount,
        grossRevenue: Math.round((r.grossRevenue || 0) * 100) / 100,
        platformRevenue: Math.round((r.platformRevenue || 0) * 100) / 100,
        avgTtfqHours: round1(r.avgTtfqHours),
        quotationConversionRate: round1(safeRate(r.bookingsCount, r.quotedCount)),
        disputeRate: round1(safeRate(r.disputeCount, r.totalRfqs)),
        refundRate: round1(safeRate(r.refundCount, r.totalRfqs)),
      }))
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

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, selectedSubprojectIndex: { $exists: true, $ne: null }, ...bookingCountryMatch } },
      { $lookup: { from: 'projects', localField: 'project', foreignField: '_id', as: 'proj' } },
      { $unwind: { path: '$proj', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          subIdx: '$selectedSubprojectIndex',
          subprojectName: {
            $let: {
              vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } },
              in: { $ifNull: ['$$sp.name', { $concat: ['Subproject #', { $toString: '$selectedSubprojectIndex' }] }] },
            },
          },
          projectTitle: '$proj.title',
          status: 1,
          paymentAmount: '$payment.amount',
          platformCommission: '$payment.platformCommission',
          paymentCurrency: '$payment.currency',
          paymentStatus: '$payment.status',
          rescheduleRequestAt: '$rescheduleRequest.requestedAt',
          customerReview: '$customerReview',
          executionDuration: {
            $let: {
              vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } },
              in: '$$sp.executionDuration',
            },
          },
          preparationDuration: {
            $let: {
              vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } },
              in: '$$sp.preparationDuration',
            },
          },
          bufferDuration: {
            $let: {
              vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } },
              in: '$$sp.bufferDuration',
            },
          },
          price: {
            $let: {
              vars: { sp: { $arrayElemAt: ['$proj.subprojects', '$selectedSubprojectIndex'] } },
              in: '$$sp.pricing.amount',
            },
          },
        },
      },
      {
        $group: {
          _id: { project: '$projectTitle', sub: '$subprojectName' },
          totalRfqs: { $sum: 1 },
          bookingsCount: { $sum: { $cond: [{ $in: ['$status', ['booked', 'in_progress', 'professional_completed', 'completed']] }, 1, 0] } },
          completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          disputeCount: { $sum: { $cond: [{ $eq: ['$status', 'dispute'] }, 1, 0] } },
          refundCount: { $sum: { $cond: [{ $in: ['$paymentStatus', ['refunded', 'partially_refunded']] }, 1, 0] } },
          reschedulingCount: { $sum: { $cond: [{ $ifNull: ['$rescheduleRequestAt', false] }, 1, 0] } },
          grossRevenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$paymentAmount', 0] }, 0] } },
          platformRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$paymentCurrency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$platformCommission', 0] }, 0] } },
          execution: { $first: '$executionDuration' },
          preparation: { $first: '$preparationDuration' },
          buffer: { $first: '$bufferDuration' },
          price: { $first: '$price' },
        },
      },
      {
        $project: {
          _id: 0,
          projectTitle: '$_id.project',
          subprojectName: '$_id.sub',
          totalRfqs: 1,
          bookingsCount: 1,
          completedCount: 1,
          disputeCount: 1,
          refundCount: 1,
          reschedulingCount: 1,
          grossRevenue: { $round: ['$grossRevenue', 2] },
          platformRevenue: { $round: [{ $ifNull: ['$platformRevenue', 0] }, 2] },
          executionDuration: '$execution',
          preparationDuration: '$preparation',
          bufferDuration: '$buffer',
          price: '$price',
        },
      },
      { $sort: { bookingsCount: -1, totalRfqs: -1 } },
    ]);

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

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, professional: { $ne: null }, ...bookingCountryMatch } },
      {
        $project: {
          professional: 1,
          status: 1,
          paymentAmount: '$payment.amount',
          platformCommission: '$payment.platformCommission',
          paymentCurrency: '$payment.currency',
          paymentStatus: '$payment.status',
          firstQuoteAt: { $ifNull: [{ $arrayElemAt: ['$quoteVersions.createdAt', 0] }, '$quote.submittedAt'] },
          createdAt: 1,
          rescheduleRequestAt: '$rescheduleRequest.requestedAt',
          reviewAvg: {
            $avg: [
              { $ifNull: ['$customerReview.communicationLevel', null] },
              { $ifNull: ['$customerReview.valueOfDelivery', null] },
              { $ifNull: ['$customerReview.qualityOfService', null] },
            ],
          },
        },
      },
      {
        $project: {
          professional: 1,
          status: 1,
          paymentAmount: 1,
          platformCommission: 1,
          paymentCurrency: 1,
          paymentStatus: 1,
          ttfqHours: { $cond: [{ $ifNull: ['$firstQuoteAt', false] }, { $divide: [{ $subtract: ['$firstQuoteAt', '$createdAt'] }, 1000 * 60 * 60] }, null] },
          rescheduleRequestAt: 1,
          reviewAvg: 1,
        },
      },
      {
        $group: {
          _id: '$professional',
          rfqsReceived: { $sum: 1 },
          quotedCount: { $sum: { $cond: [{ $ne: ['$ttfqHours', null] }, 1, 0] } },
          bookingsCount: { $sum: { $cond: [{ $in: ['$status', ['booked', 'in_progress', 'professional_completed', 'completed']] }, 1, 0] } },
          completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          disputeCount: { $sum: { $cond: [{ $eq: ['$status', 'dispute'] }, 1, 0] } },
          refundCount: { $sum: { $cond: [{ $in: ['$paymentStatus', ['refunded', 'partially_refunded']] }, 1, 0] } },
          reschedulingCount: { $sum: { $cond: [{ $ifNull: ['$rescheduleRequestAt', false] }, 1, 0] } },
          avgTtfqHours: { $avg: '$ttfqHours' },
          grossRevenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$paymentAmount', 0] }, 0] } },
          platformRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$paymentCurrency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$platformCommission', 0] }, 0] } },
          avgReviewScore: { $avg: '$reviewAvg' },
        },
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'pro' } },
      { $unwind: { path: '$pro', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          professionalId: '$_id',
          name: { $ifNull: ['$pro.businessInfo.companyName', { $ifNull: ['$pro.name', { $ifNull: ['$pro.username', '$pro.email'] }] }] },
          email: '$pro.email',
          city: { $ifNull: ['$pro.businessInfo.city', '$pro.location.city'] },
          country: { $ifNull: ['$pro.location.country', '$pro.businessInfo.country'] },
          professionalLevel: '$pro.professionalLevel',
          createdProjects: { $size: { $ifNull: ['$pro.projects', []] } },
          suspendedAccount: { $cond: [{ $eq: ['$pro.suspended', true] }, 1, 0] },
          rfqsReceived: 1,
          quotedCount: 1,
          bookingsCount: 1,
          completedCount: 1,
          disputeCount: 1,
          refundCount: 1,
          reschedulingCount: 1,
          avgTtfqHours: { $round: [{ $ifNull: ['$avgTtfqHours', 0] }, 1] },
          grossRevenue: { $round: [{ $ifNull: ['$grossRevenue', 0] }, 2] },
          platformRevenue: { $round: [{ $ifNull: ['$platformRevenue', 0] }, 2] },
          avgReviewScore: { $round: [{ $ifNull: ['$avgReviewScore', 0] }, 1] },
        },
      },
      { $sort: { platformRevenue: -1, grossRevenue: -1, bookingsCount: -1 } },
    ]);

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

    const rows = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, customer: { $ne: null }, ...bookingCountryMatch } },
      {
        $group: {
          _id: '$customer',
          rfqsCreated: { $sum: 1 },
          bookingsCount: { $sum: { $cond: [{ $in: ['$status', ['booked', 'in_progress', 'professional_completed', 'completed']] }, 1, 0] } },
          completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          disputeCount: { $sum: { $cond: [{ $eq: ['$status', 'dispute'] }, 1, 0] } },
          refundCount: { $sum: { $cond: [{ $in: ['$payment.status', ['refunded', 'partially_refunded']] }, 1, 0] } },
          reschedulingCount: { $sum: { $cond: [{ $ifNull: ['$rescheduleRequest.requestedAt', false] }, 1, 0] } },
          grossSpend: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.amount', 0] }, 0] } },
          platformRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $ifNull: ['$payment.currency', REPORTING_CURRENCY] }, REPORTING_CURRENCY] }] }, { $ifNull: ['$payment.platformCommission', 0] }, 0] } },
          paymentsTotal: { $sum: 1 },
          paymentDurationsMs: { $push: { $cond: [{ $and: [{ $ifNull: ['$payment.capturedAt', false] }, { $ifNull: ['$createdAt', false] }] }, { $subtract: ['$payment.capturedAt', '$createdAt'] }, null] } },
        },
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'cust' } },
      { $unwind: { path: '$cust', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          customerId: '$_id',
          name: { $ifNull: ['$cust.name', { $ifNull: ['$cust.username', '$cust.email'] }] },
          email: '$cust.email',
          city: { $ifNull: ['$cust.location.city', '$cust.companyAddress.city'] },
          country: { $ifNull: ['$cust.location.country', '$cust.companyAddress.country'] },
          loyaltyLevel: { $ifNull: ['$cust.loyaltyTier', null] },
          rfqsCreated: 1,
          bookingsCount: 1,
          completedCount: 1,
          disputeCount: 1,
          refundCount: 1,
          reschedulingCount: 1,
          grossSpend: { $round: ['$grossSpend', 2] },
          platformRevenue: { $round: [{ $ifNull: ['$platformRevenue', 0] }, 2] },
          avgPaymentTimeHours: {
            $let: {
              vars: { ds: { $filter: { input: '$paymentDurationsMs', as: 'd', cond: { $ne: ['$$d', null] } } } },
              in: { $cond: [{ $gt: [{ $size: '$$ds' }, 0] }, { $round: [{ $divide: [{ $divide: [{ $avg: '$$ds' }, 1000 * 60 * 60] }, 1] }, 1] }, null] },
            },
          },
        },
      },
      { $sort: { platformRevenue: -1, grossSpend: -1, bookingsCount: -1 } },
    ]);

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
    const filename = `fixera-kpi-${section}-${dateSlug}.${format === 'xlsx' ? 'xlsx' : 'csv'}`;

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
