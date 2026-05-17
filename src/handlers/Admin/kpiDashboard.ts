import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking from '../../models/booking';
import User from '../../models/user';
import WarrantyClaim from '../../models/warrantyClaim';
import ServiceView from '../../models/serviceView';
import { buildCsv } from '../../utils/csv';

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
      a: { $ifNull: ['$location.city', null] },
      b: { $ifNull: ['$companyAddress.city', null] },
      c: { $ifNull: ['$businessInfo.city', null] },
    },
    in: {
      $let: {
        vars: { raw: { $ifNull: [{ $ifNull: ['$$a', '$$b'] }, '$$c'] } },
        in: {
          $cond: [
            { $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }] },
            '__unknown__',
            { $toLower: { $trim: { input: '$$raw' } } },
          ],
        },
      },
    },
  },
};

const formatCity = (key: string): string => (key === '__unknown__' ? 'Unknown' : key);

const safeRate = (numer: number, denom: number): number => (denom > 0 ? (numer / denom) * 100 : 0);

// ---------- summary ----------

export const getKpiSummary = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);

    const [signUps, bookingStats, disputeCount, warrantyCount, refundCount, totalBookingsInRange, firstQuoteAvg] = await Promise.all([
      User.countDocuments({ role: { $in: ['customer', 'professional'] }, createdAt: { $gte: from, $lte: to } }),
      Booking.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            grossRevenue: {
              $sum: {
                $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.amount', 0] }, 0],
              },
            },
            platformRevenue: {
              $sum: {
                $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.platformCommission', 0] }, 0],
              },
            },
          },
        },
      ]),
      Booking.countDocuments({ 'dispute.raisedAt': { $gte: from, $lte: to } }),
      WarrantyClaim.countDocuments({ openedAt: { $gte: from, $lte: to } }),
      Booking.countDocuments({ status: 'refunded', updatedAt: { $gte: from, $lte: to } }),
      Booking.countDocuments({ createdAt: { $gte: from, $lte: to } }),
      Booking.aggregate([
        {
          $match: {
            createdAt: { $gte: from, $lte: to },
            $or: [
              { 'quote.submittedAt': { $type: 'date' } },
              { 'quoteVersions.0.createdAt': { $type: 'date' } },
            ],
          },
        },
        {
          $project: {
            createdAt: 1,
            firstQuoteAt: {
              $ifNull: [
                { $arrayElemAt: ['$quoteVersions.createdAt', 0] },
                '$quote.submittedAt',
              ],
            },
          },
        },
        {
          $project: {
            ttfqHours: {
              $divide: [{ $subtract: ['$firstQuoteAt', '$createdAt'] }, 1000 * 60 * 60],
            },
          },
        },
        {
          $group: {
            _id: null,
            avgHours: { $avg: '$ttfqHours' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const bs = bookingStats[0] || {};
    const totalBookings = totalBookingsInRange || 0;
    const ttfq = firstQuoteAvg[0] || {};

    return res.json({
      success: true,
      data: {
        range: { from: from.toISOString(), to: to.toISOString() },
        signUps,
        totalBookings,
        completedBookings: bs.completedBookings || 0,
        grossRevenue: Math.round((bs.grossRevenue || 0) * 100) / 100,
        platformRevenue: Math.round((bs.platformRevenue || 0) * 100) / 100,
        disputeRate: Math.round(safeRate(disputeCount, totalBookings) * 10) / 10,
        warrantyClaimRate: Math.round(safeRate(warrantyCount, totalBookings) * 10) / 10,
        refundRate: Math.round(safeRate(refundCount, totalBookings) * 10) / 10,
        avgTimeToFirstQuoteHours: ttfq.avgHours != null ? Math.round(ttfq.avgHours * 10) / 10 : null,
        quotedBookingsCount: ttfq.count || 0,
      },
    });
  } catch (error: any) {
    console.error('KPI summary error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI summary' } });
  }
};

// ---------- by region ----------

export const getKpiByRegion = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);

    const userRows = await User.aggregate([
      {
        $match: {
          role: { $in: ['customer', 'professional'] },
          createdAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: normalizeUserCityExpr, signUps: { $sum: 1 } } },
    ]);

    const viewRows = await ServiceView.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, city: { $ne: null } } },
      {
        $group: {
          _id: { $cond: [{ $or: [{ $eq: ['$city', null] }, { $eq: ['$city', ''] }] }, '__unknown__', { $toLower: { $trim: { input: '$city' } } }] },
          views: { $sum: 1 },
        },
      },
    ]);

    const bookingRows = await Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: normalizeCityExpr,
          totalBookings: { $sum: 1 },
          completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          bookedValue: {
            $sum: {
              $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.amount', 0] }, 0],
            },
          },
          platformRevenue: {
            $sum: {
              $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.platformCommission', 0] }, 0],
            },
          },
          quotedCount: {
            $sum: {
              $cond: [
                { $or: [{ $ifNull: ['$quote.submittedAt', false] }, { $gt: [{ $size: { $ifNull: ['$quoteVersions', []] } }, 0] }] },
                1,
                0,
              ],
            },
          },
          acceptedCount: {
            $sum: {
              $cond: [
                { $in: ['$status', ['quote_accepted', 'payment_pending', 'booked', 'in_progress', 'professional_completed', 'completed']] },
                1,
                0,
              ],
            },
          },
          disputeCount: { $sum: { $cond: [{ $ifNull: ['$dispute.raisedAt', false] }, 1, 0] } },
          refundCount: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, 1, 0] } },
          bookingIds: { $push: '$_id' },
        },
      },
    ]);

    const warrantyRows = await WarrantyClaim.aggregate([
      { $match: { openedAt: { $gte: from, $lte: to } } },
      {
        $lookup: {
          from: 'bookings',
          localField: 'booking',
          foreignField: '_id',
          as: 'b',
        },
      },
      { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            $let: {
              vars: { raw: { $ifNull: ['$b.location.city', null] } },
              in: {
                $cond: [
                  { $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }] },
                  '__unknown__',
                  { $toLower: { $trim: { input: '$$raw' } } },
                ],
              },
            },
          },
          warrantyCount: { $sum: 1 },
        },
      },
    ]);

    const byCity = new Map<string, any>();
    const ensure = (key: string) => {
      if (!byCity.has(key)) {
        byCity.set(key, {
          city: formatCity(key),
          signUps: 0,
          views: 0,
          totalBookings: 0,
          completedBookings: 0,
          bookedValue: 0,
          platformRevenue: 0,
          quotedCount: 0,
          acceptedCount: 0,
          disputeCount: 0,
          warrantyCount: 0,
          refundCount: 0,
        });
      }
      return byCity.get(key);
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

    const rows = Array.from(byCity.values()).map((r) => ({
      ...r,
      disputeRate: Math.round(safeRate(r.disputeCount, r.totalBookings) * 10) / 10,
      warrantyClaimRate: Math.round(safeRate(r.warrantyCount, r.totalBookings) * 10) / 10,
      refundRate: Math.round(safeRate(r.refundCount, r.totalBookings) * 10) / 10,
      quotationConversionRate: Math.round(safeRate(r.acceptedCount, r.quotedCount) * 10) / 10,
    }));

    rows.sort((a, b) => b.bookedValue - a.bookedValue || b.totalBookings - a.totalBookings);

    return res.json({ success: true, data: { range: { from, to }, rows } });
  } catch (error: any) {
    console.error('KPI by-region error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI by region' } });
  }
};

// ---------- by service ----------

export const getKpiByService = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);

    const viewRows = await ServiceView.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$serviceId', views: { $sum: 1 } } },
    ]);

    const bookingRows = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: from, $lte: to },
          'rfqData.serviceType': { $type: 'string' },
        },
      },
      {
        $group: {
          _id: { $toLower: { $trim: { input: '$rfqData.serviceType' } } },
          totalRfqs: { $sum: 1 },
          quotedCount: {
            $sum: {
              $cond: [
                { $or: [{ $ifNull: ['$quote.submittedAt', false] }, { $gt: [{ $size: { $ifNull: ['$quoteVersions', []] } }, 0] }] },
                1,
                0,
              ],
            },
          },
          bookingsCount: {
            $sum: {
              $cond: [
                { $in: ['$status', ['booked', 'in_progress', 'professional_completed', 'completed']] },
                1,
                0,
              ],
            },
          },
          avgTtfqHours: {
            $avg: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$createdAt', null] },
                    {
                      $or: [
                        { $ifNull: ['$quote.submittedAt', false] },
                        { $gt: [{ $size: { $ifNull: ['$quoteVersions', []] } }, 0] },
                      ],
                    },
                  ],
                },
                {
                  $divide: [
                    {
                      $subtract: [
                        {
                          $ifNull: [
                            { $arrayElemAt: ['$quoteVersions.createdAt', 0] },
                            '$quote.submittedAt',
                          ],
                        },
                        '$createdAt',
                      ],
                    },
                    1000 * 60 * 60,
                  ],
                },
                null,
              ],
            },
          },
        },
      },
    ]);

    const byService = new Map<string, any>();
    const ensure = (key: string) => {
      if (!byService.has(key)) {
        byService.set(key, {
          service: key,
          views: 0,
          totalRfqs: 0,
          quotedCount: 0,
          bookingsCount: 0,
          avgTtfqHours: null as number | null,
        });
      }
      return byService.get(key);
    };

    for (const r of viewRows) ensure(String(r._id || '').toLowerCase()).views = r.views;
    for (const r of bookingRows) {
      const row = ensure(String(r._id || '').toLowerCase());
      row.totalRfqs = r.totalRfqs;
      row.quotedCount = r.quotedCount;
      row.bookingsCount = r.bookingsCount;
      row.avgTtfqHours = r.avgTtfqHours != null ? Math.round(r.avgTtfqHours * 10) / 10 : null;
    }

    const rows = Array.from(byService.values()).map((r) => ({
      ...r,
      viewsToBookingRate: Math.round(safeRate(r.bookingsCount, r.views) * 10) / 10,
      quotationConversionRate: Math.round(safeRate(r.bookingsCount, r.quotedCount) * 10) / 10,
    }));

    rows.sort((a, b) => b.bookingsCount - a.bookingsCount || b.views - a.views);

    return res.json({ success: true, data: { range: { from, to }, rows } });
  } catch (error: any) {
    console.error('KPI by-service error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute KPI by service' } });
  }
};

// ---------- professional response times ----------

export const getKpiProfessionalResponse = async (req: Request, res: Response) => {
  try {
    const { from, to } = parseRange(req);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);

    const rows = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: from, $lte: to },
          professional: { $ne: null },
          $or: [
            { 'quote.submittedAt': { $type: 'date' } },
            { 'quoteVersions.0.createdAt': { $type: 'date' } },
          ],
        },
      },
      {
        $project: {
          professional: 1,
          createdAt: 1,
          firstQuoteAt: {
            $ifNull: [
              { $arrayElemAt: ['$quoteVersions.createdAt', 0] },
              '$quote.submittedAt',
            ],
          },
        },
      },
      {
        $project: {
          professional: 1,
          ttfqHours: { $divide: [{ $subtract: ['$firstQuoteAt', '$createdAt'] }, 1000 * 60 * 60] },
        },
      },
      {
        $group: {
          _id: '$professional',
          avgHours: { $avg: '$ttfqHours' },
          minHours: { $min: '$ttfqHours' },
          maxHours: { $max: '$ttfqHours' },
          quotesSent: { $sum: 1 },
        },
      },
      { $sort: { avgHours: 1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'pro',
        },
      },
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
  } catch (error: any) {
    console.error('KPI professional-response error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to compute professional response KPIs' } });
  }
};

// ---------- CSV export ----------

export const exportKpiCsv = async (req: Request, res: Response) => {
  try {
    const section = String(req.query.section || 'region');
    const { from, to } = parseRange(req);
    const dateSlug = `${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}`;

    let headers: string[] = [];
    let rows: unknown[][] = [];
    let filename = `fixera-kpi-${section}-${dateSlug}.csv`;

    if (section === 'region') {
      const proxyRes = await captureJson(getKpiByRegion, req);
      const data = proxyRes?.data?.rows || [];
      headers = ['City', 'Sign-ups', 'Service views', 'Total bookings', 'Completed bookings', 'Booked value (EUR)', 'Platform revenue (EUR)', 'Quotation conversion rate (%)', 'Dispute rate (%)', 'Warranty claim rate (%)', 'Refund rate (%)'];
      rows = data.map((r: any) => [r.city, r.signUps, r.views, r.totalBookings, r.completedBookings, r.bookedValue.toFixed(2), r.platformRevenue.toFixed(2), r.quotationConversionRate, r.disputeRate, r.warrantyClaimRate, r.refundRate]);
    } else if (section === 'service') {
      const proxyRes = await captureJson(getKpiByService, req);
      const data = proxyRes?.data?.rows || [];
      headers = ['Service', 'Views', 'RFQs', 'Quotes sent', 'Bookings', 'Views→bookings (%)', 'Quotation conversion (%)', 'Avg time to first quote (h)'];
      rows = data.map((r: any) => [r.service, r.views, r.totalRfqs, r.quotedCount, r.bookingsCount, r.viewsToBookingRate, r.quotationConversionRate, r.avgTtfqHours ?? '']);
    } else if (section === 'response') {
      const proxyRes = await captureJson(getKpiProfessionalResponse, req);
      const data = proxyRes?.data?.rows || [];
      headers = ['Professional', 'Email', 'City', 'Quotes sent', 'Avg hours', 'Min hours', 'Max hours'];
      rows = data.map((r: any) => [r.name || '', r.email || '', r.city || '', r.quotesSent, r.avgHours, r.minHours, r.maxHours]);
    } else {
      return res.status(400).json({ success: false, error: { code: 'BAD_SECTION', message: 'Unknown section' } });
    }

    const csv = buildCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (error: any) {
    console.error('KPI export error:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to export KPI CSV' } });
  }
};

// Helper: capture JSON response payload from one of the KPI handlers without sending it
async function captureJson(handler: (req: Request, res: Response) => Promise<any>, req: Request): Promise<any> {
  let captured: any = null;
  const fakeRes: any = {
    statusCode: 200,
    headers: {},
    setHeader() {},
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { captured = payload; return this; },
    send(payload: any) { captured = payload; return this; },
  };
  await handler(req, fakeRes);
  return captured;
}

// ---------- background email report ----------

export const triggerKpiEmailReport = async (req: Request, res: Response) => {
  try {
    const adminUser: any = (req as any).admin;
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
  } catch (error: any) {
    console.error('KPI email-report trigger error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to trigger report' } });
    }
  }
};
