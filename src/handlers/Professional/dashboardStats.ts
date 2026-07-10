import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking from '../../models/booking';
import Favorite from '../../models/favorite';
import WarrantyClaim from '../../models/warrantyClaim';
import ProfileView from '../../models/profileView';
import { escapeCsv } from '../../utils/csv';

type RangeKey = 'month' | '3months' | '12months' | 'all';

const subtractMonthsClamped = (base: Date, months: number): Date => {
  const d = new Date(base);
  const originalDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(originalDay, lastDay));
  return d;
};

const resolveRangeStart = (range: RangeKey): Date | null => {
  const now = new Date();
  switch (range) {
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case '3months':
      return subtractMonthsClamped(now, 3);
    case '12months':
      return subtractMonthsClamped(now, 12);
    case 'all':
    default:
      return null;
  }
};

export const getProfessionalDashboardStats = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const professionalId = new mongoose.Types.ObjectId(String(userId));
    const rangeParam = (req.query.range as string) || 'all';
    const range: RangeKey = (['month', '3months', '12months', 'all'] as RangeKey[]).includes(rangeParam as RangeKey)
      ? (rangeParam as RangeKey)
      : 'all';
    const startDate = resolveRangeStart(range);

    const dateFilter = startDate ? { createdAt: { $gte: startDate } } : {};
    const baseMatch: any = { professional: professionalId, ...dateFilter };

    const activeStatuses = ['booked', 'in_progress', 'professional_completed', 'completed'];

    const [
      totalBookings,
      allBookingsCount,
      completedBookings,
      cancelledBookings,
      quotedBookings,
      acceptedQuoteBookings,
      revenueAgg,
      refundsAgg,
      warrantyClaims,
      favoritesCount,
      monthlyRevenue,
      views,
      overdueAgg,
      serviceBreakdown,
      projectBreakdown,
    ] = await Promise.all([
      Booking.countDocuments({ ...baseMatch, status: { $in: activeStatuses } }),
      Booking.countDocuments(baseMatch),
      Booking.countDocuments({ ...baseMatch, status: 'completed' }),
      Booking.countDocuments({ ...baseMatch, status: 'cancelled' }),
      Booking.countDocuments({
        ...baseMatch,
        $or: [
          { 'quoteVersions.0': { $exists: true } },
          { 'quote.amount': { $gt: 0 } },
        ],
      }),
      Booking.countDocuments({
        ...baseMatch,
        status: { $in: ['quote_accepted', 'payment_pending', 'booked', 'in_progress', 'professional_completed', 'completed'] },
        $or: [
          { 'quoteVersions.0': { $exists: true } },
          { 'quote.amount': { $gt: 0 } },
        ],
      }),
      Booking.aggregate([
        {
          $match: {
            professional: professionalId,
            'payment.status': { $in: ['authorized', 'completed'] },
          },
        },
        {
          $addFields: {
            _paymentAt: {
              $ifNull: [
                '$payment.paidAt',
                { $ifNull: ['$payment.capturedAt', { $ifNull: ['$payment.authorizedAt', '$createdAt'] }] },
              ],
            },
          },
        },
        ...(startDate ? [{ $match: { _paymentAt: { $gte: startDate } } }] : []),
        {
          $group: {
            _id: null,
            gross: { $sum: { $ifNull: ['$payment.amount', 0] } },
            net: { $sum: { $ifNull: ['$payment.professionalPayout', 0] } },
            count: { $sum: 1 },
          },
        },
      ]),
      Booking.aggregate([
        { $match: { ...baseMatch, 'cancellation.refundAmount': { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$cancellation.refundAmount' } } },
      ]),
      WarrantyClaim.countDocuments({ professional: professionalId, ...(startDate ? { createdAt: { $gte: startDate } } : {}) }),
      Favorite.countDocuments({
        targetType: 'professional',
        targetId: professionalId,
        ...(startDate ? { createdAt: { $gte: startDate } } : {}),
      }),
      Booking.aggregate([
        {
          $match: {
            professional: professionalId,
            'payment.status': { $in: ['authorized', 'completed'] },
          },
        },
        {
          $addFields: {
            _paymentAt: {
              $ifNull: [
                '$payment.paidAt',
                { $ifNull: ['$payment.capturedAt', { $ifNull: ['$payment.authorizedAt', '$createdAt'] }] },
              ],
            },
          },
        },
        ...(startDate ? [{ $match: { _paymentAt: { $gte: startDate } } }] : []),
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m',
                date: '$_paymentAt',
              },
            },
            revenue: { $sum: { $ifNull: ['$payment.professionalPayout', 0] } },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      ProfileView.countDocuments({
        professional: professionalId,
        ...(startDate ? { createdAt: { $gte: startDate } } : {}),
      }),
      Booking.aggregate([
        {
          $match: {
            professional: professionalId,
            status: 'completed',
            actualEndDate: { $ne: null },
            scheduledExecutionEndDate: { $ne: null },
            ...(startDate ? { createdAt: { $gte: startDate } } : {}),
          },
        },
        {
          $project: {
            overdueMs: { $subtract: ['$actualEndDate', '$scheduledExecutionEndDate'] },
          },
        },
        {
          $group: {
            _id: null,
            completedWithDeadline: { $sum: 1 },
            overdueCount: { $sum: { $cond: [{ $gt: ['$overdueMs', 0] }, 1, 0] } },
            totalOverdueMs: { $sum: { $cond: [{ $gt: ['$overdueMs', 0] }, '$overdueMs', 0] } },
          },
        },
      ]),
      Booking.aggregate([
        {
          $match: {
            professional: professionalId,
            'rfqData.serviceType': { $exists: true, $ne: null },
            ...(startDate ? { createdAt: { $gte: startDate } } : {}),
          },
        },
        {
          $group: {
            _id: '$rfqData.serviceType',
            bookings: { $sum: 1 },
            revenue: {
              $sum: {
                $cond: [
                  { $in: ['$payment.status', ['authorized', 'completed']] },
                  { $ifNull: ['$payment.professionalPayout', 0] },
                  0,
                ],
              },
            },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
      ]),
      Booking.aggregate([
        {
          $match: {
            professional: professionalId,
            project: { $exists: true, $ne: null },
            ...(startDate ? { createdAt: { $gte: startDate } } : {}),
          },
        },
        {
          $group: {
            _id: '$project',
            bookings: { $sum: 1 },
            revenue: {
              $sum: {
                $cond: [
                  { $in: ['$payment.status', ['authorized', 'completed']] },
                  { $ifNull: ['$payment.professionalPayout', 0] },
                  0,
                ],
              },
            },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          },
        },
        {
          $lookup: {
            from: 'projects',
            localField: '_id',
            foreignField: '_id',
            as: 'projectInfo',
          },
        },
        {
          $project: {
            _id: 0,
            projectId: '$_id',
            title: { $ifNull: [{ $arrayElemAt: ['$projectInfo.title', 0] }, 'Untitled'] },
            bookings: 1,
            revenue: 1,
            completed: 1,
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const gross = revenueAgg[0]?.gross || 0;
    const net = revenueAgg[0]?.net || 0;
    const paidCount = revenueAgg[0]?.count || 0;
    const refundTotal = refundsAgg[0]?.total || 0;

    const conversionRate = quotedBookings > 0
      ? Math.round((acceptedQuoteBookings / quotedBookings) * 100)
      : 0;

    const avgBookingValue = paidCount > 0
      ? Math.round((gross / paidCount) * 100) / 100
      : 0;

    const bookingRate = views > 0
      ? Math.round((totalBookings / views) * 1000) / 10
      : 0;

    const completedWithDeadline = overdueAgg[0]?.completedWithDeadline || 0;
    const overdueCount = overdueAgg[0]?.overdueCount || 0;
    const totalOverdueMs = overdueAgg[0]?.totalOverdueMs || 0;
    const overdueRate = completedWithDeadline > 0
      ? Math.round((overdueCount / completedWithDeadline) * 1000) / 10
      : 0;
    const avgOverdueDays = overdueCount > 0
      ? Math.round((totalOverdueMs / overdueCount / (1000 * 60 * 60 * 24)) * 10) / 10
      : 0;

    return res.json({
      success: true,
      data: {
        range,
        kpis: {
          totalBookings,
          completedBookings,
          cancelledBookings,
          quotesSent: quotedBookings,
          quotesAccepted: acceptedQuoteBookings,
          conversionRate,
          revenueGross: Math.round(gross * 100) / 100,
          revenueNet: Math.round(net * 100) / 100,
          avgBookingValue,
          refundTotal: Math.round(refundTotal * 100) / 100,
          warrantyClaims,
          favorites: favoritesCount,
          views,
          bookingRate,
          overdueRate,
          avgOverdueDays,
        },
        funnel: {
          rfq: allBookingsCount,
          quoted: quotedBookings,
          accepted: acceptedQuoteBookings,
          completed: completedBookings,
        },
        monthlyRevenue: monthlyRevenue.map((m: any) => ({
          month: m._id,
          revenue: Math.round((m.revenue || 0) * 100) / 100,
          bookings: m.bookings || 0,
        })),
        serviceBreakdown: serviceBreakdown.map((s: any) => ({
          service: s._id,
          bookings: s.bookings || 0,
          revenue: Math.round((s.revenue || 0) * 100) / 100,
          completed: s.completed || 0,
        })),
        projectBreakdown: projectBreakdown.map((p: any) => ({
          projectId: p.projectId?.toString(),
          title: p.title,
          bookings: p.bookings || 0,
          revenue: Math.round((p.revenue || 0) * 100) / 100,
          completed: p.completed || 0,
        })),
      },
    });
  } catch (error: any) {
    console.error('Error fetching professional dashboard stats:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch dashboard stats' },
    });
  }
};

export const getProfessionalDashboardBookings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const professionalId = new mongoose.Types.ObjectId(String(userId));
    const rangeParam = (req.query.range as string) || 'all';
    const range: RangeKey = (['month', '3months', '12months', 'all'] as RangeKey[]).includes(rangeParam as RangeKey)
      ? (rangeParam as RangeKey)
      : 'all';
    const startDate = resolveRangeStart(range);
    const format = (req.query.format as string) === 'csv' ? 'csv' : 'json';
    const parsedLimit = parseInt((req.query.limit as string) || '200', 10);
    const safeLimit = Number.isNaN(parsedLimit) ? 200 : parsedLimit;
    const limit = Math.min(Math.max(safeLimit, 1), 1000);

    const match: any = { professional: professionalId };
    if (startDate) match.createdAt = { $gte: startDate };

    const bookings = await Booking.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('project', 'title')
      .populate('customer', 'name email')
      .select('bookingNumber status createdAt scheduledStartDate scheduledExecutionEndDate actualEndDate payment rfqData project customer')
      .lean();

    const rows = bookings.map((b: any) => ({
      bookingNumber: b.bookingNumber || b._id?.toString(),
      createdAt: b.createdAt,
      status: b.status,
      service: b.rfqData?.serviceType || '',
      project: b.project?.title || '',
      customer: b.customer?.name || '',
      scheduledStart: b.scheduledStartDate || null,
      scheduledEnd: b.scheduledExecutionEndDate || null,
      completedAt: b.actualEndDate || null,
      gross: Math.round(((b.payment?.amount || 0)) * 100) / 100,
      net: Math.round(((b.payment?.professionalPayout || 0)) * 100) / 100,
      paymentStatus: b.payment?.status || '',
      overdue:
        b.status === 'completed' &&
        b.actualEndDate &&
        b.scheduledExecutionEndDate &&
        new Date(b.actualEndDate) > new Date(b.scheduledExecutionEndDate),
    }));

    if (format === 'csv') {
      const headers = [
        'Booking #',
        'Created',
        'Status',
        'Service',
        'Project',
        'Customer',
        'Scheduled Start',
        'Scheduled End',
        'Completed',
        'Gross (EUR)',
        'Net (EUR)',
        'Payment Status',
        'Overdue',
      ];
      const lines = [headers.map(escapeCsv).join(',')];
      for (const r of rows) {
        lines.push([
          r.bookingNumber,
          r.createdAt ? new Date(r.createdAt).toISOString() : '',
          r.status,
          r.service,
          r.project,
          r.customer,
          r.scheduledStart ? new Date(r.scheduledStart).toISOString() : '',
          r.scheduledEnd ? new Date(r.scheduledEnd).toISOString() : '',
          r.completedAt ? new Date(r.completedAt).toISOString() : '',
          r.gross.toFixed(2),
          r.net.toFixed(2),
          r.paymentStatus,
          r.overdue ? 'yes' : 'no',
        ].map(escapeCsv).join(','));
      }
      const csv = lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="fixtract-bookings-${range}-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      return res.send(csv);
    }

    return res.json({ success: true, data: { range, count: rows.length, bookings: rows } });
  } catch (error: any) {
    console.error('Error fetching professional dashboard bookings:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch bookings' },
    });
  }
};
