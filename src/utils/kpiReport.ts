import PDFDocument from 'pdfkit';
import Booking from '../models/booking';
import User from '../models/user';
import WarrantyClaim from '../models/warrantyClaim';
import ServiceView from '../models/serviceView';

interface KpiRange { from: Date; to: Date; }

const safeRate = (numer: number, denom: number): number => (denom > 0 ? (numer / denom) * 100 : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const formatCity = (key: string): string => (key === '__unknown__' ? 'Unknown' : key);

async function aggregateSummary({ from, to }: KpiRange) {
  const [signUps, bookingStats, disputeCount, warrantyCount, refundCount, totalBookings, ttfqStats] = await Promise.all([
    User.countDocuments({ role: { $in: ['customer', 'professional'] }, createdAt: { $gte: from, $lte: to } }),
    Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          grossRevenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.amount', 0] }, 0] } },
          platformRevenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.platformCommission', 0] }, 0] } },
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
          $or: [{ 'quote.submittedAt': { $type: 'date' } }, { 'quoteVersions.0.createdAt': { $type: 'date' } }],
        },
      },
      {
        $project: {
          ttfqHours: {
            $divide: [
              { $subtract: [{ $ifNull: [{ $arrayElemAt: ['$quoteVersions.createdAt', 0] }, '$quote.submittedAt'] }, '$createdAt'] },
              1000 * 60 * 60,
            ],
          },
        },
      },
      { $group: { _id: null, avgHours: { $avg: '$ttfqHours' }, count: { $sum: 1 } } },
    ]),
  ]);

  const bs = bookingStats[0] || {};
  const ttfq = ttfqStats[0] || {};
  return {
    signUps,
    totalBookings,
    completedBookings: bs.completedBookings || 0,
    grossRevenue: round2(bs.grossRevenue || 0),
    platformRevenue: round2(bs.platformRevenue || 0),
    disputeRate: round1(safeRate(disputeCount, totalBookings)),
    warrantyClaimRate: round1(safeRate(warrantyCount, totalBookings)),
    refundRate: round1(safeRate(refundCount, totalBookings)),
    avgTimeToFirstQuoteHours: ttfq.avgHours != null ? round1(ttfq.avgHours) : null,
    quotedBookingsCount: ttfq.count || 0,
  };
}

const normalizeBookingCityExpr = {
  $let: {
    vars: { raw: { $ifNull: ['$location.city', null] } },
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

async function aggregateByRegion({ from, to }: KpiRange) {
  const [userRows, viewRows, bookingRows] = await Promise.all([
    User.aggregate([
      { $match: { role: { $in: ['customer', 'professional'] }, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: normalizeUserCityExpr, signUps: { $sum: 1 } } },
    ]),
    ServiceView.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: { $cond: [{ $or: [{ $eq: ['$city', null] }, { $eq: ['$city', ''] }] }, '__unknown__', { $toLower: { $trim: { input: '$city' } } }] },
          views: { $sum: 1 },
        },
      },
    ]),
    Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: normalizeBookingCityExpr,
          totalBookings: { $sum: 1 },
          bookedValue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.amount', 0] }, 0] } },
          platformRevenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$payment.platformCommission', 0] }, 0] } },
          disputeCount: { $sum: { $cond: [{ $ifNull: ['$dispute.raisedAt', false] }, 1, 0] } },
          refundCount: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, 1, 0] } },
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
        },
      },
    ]),
  ]);

  const byCity = new Map<string, any>();
  const ensure = (key: string) => {
    if (!byCity.has(key)) {
      byCity.set(key, { city: formatCity(key), signUps: 0, views: 0, totalBookings: 0, bookedValue: 0, platformRevenue: 0, disputeCount: 0, refundCount: 0, quotedCount: 0, acceptedCount: 0 });
    }
    return byCity.get(key);
  };
  for (const r of userRows) ensure(r._id).signUps = r.signUps;
  for (const r of viewRows) ensure(r._id).views = r.views;
  for (const r of bookingRows) {
    const row = ensure(r._id);
    row.totalBookings = r.totalBookings;
    row.bookedValue = round2(r.bookedValue || 0);
    row.platformRevenue = round2(r.platformRevenue || 0);
    row.disputeCount = r.disputeCount;
    row.refundCount = r.refundCount;
    row.quotedCount = r.quotedCount;
    row.acceptedCount = r.acceptedCount;
  }

  return Array.from(byCity.values())
    .map((r) => ({
      ...r,
      disputeRate: round1(safeRate(r.disputeCount, r.totalBookings)),
      refundRate: round1(safeRate(r.refundCount, r.totalBookings)),
      quotationConversionRate: round1(safeRate(r.acceptedCount, r.quotedCount)),
    }))
    .sort((a, b) => b.bookedValue - a.bookedValue || b.totalBookings - a.totalBookings);
}

async function aggregateByService({ from, to }: KpiRange) {
  const [viewRows, bookingRows] = await Promise.all([
    ServiceView.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$serviceId', views: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, 'rfqData.serviceType': { $type: 'string' } } },
      {
        $group: {
          _id: { $toLower: { $trim: { input: '$rfqData.serviceType' } } },
          totalRfqs: { $sum: 1 },
          bookingsCount: { $sum: { $cond: [{ $in: ['$status', ['booked', 'in_progress', 'professional_completed', 'completed']] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const byService = new Map<string, any>();
  const ensure = (key: string) => {
    if (!byService.has(key)) byService.set(key, { service: key, views: 0, totalRfqs: 0, bookingsCount: 0 });
    return byService.get(key);
  };
  for (const r of viewRows) ensure(String(r._id || '').toLowerCase()).views = r.views;
  for (const r of bookingRows) {
    const row = ensure(String(r._id || '').toLowerCase());
    row.totalRfqs = r.totalRfqs;
    row.bookingsCount = r.bookingsCount;
  }
  return Array.from(byService.values())
    .map((r) => ({
      ...r,
      viewsToBookingRate: round1(safeRate(r.bookingsCount, r.views)),
    }))
    .sort((a, b) => b.bookingsCount - a.bookingsCount || b.views - a.views)
    .slice(0, 50);
}

async function aggregateResponseTimes({ from, to }: KpiRange) {
  return Booking.aggregate([
    {
      $match: {
        createdAt: { $gte: from, $lte: to },
        professional: { $ne: null },
        $or: [{ 'quote.submittedAt': { $type: 'date' } }, { 'quoteVersions.0.createdAt': { $type: 'date' } }],
      },
    },
    {
      $project: {
        professional: 1,
        ttfqHours: {
          $divide: [
            { $subtract: [{ $ifNull: [{ $arrayElemAt: ['$quoteVersions.createdAt', 0] }, '$quote.submittedAt'] }, '$createdAt'] },
            1000 * 60 * 60,
          ],
        },
      },
    },
    { $group: { _id: '$professional', avgHours: { $avg: '$ttfqHours' }, quotesSent: { $sum: 1 } } },
    { $sort: { avgHours: 1 } },
    { $limit: 25 },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'pro' } },
    { $unwind: { path: '$pro', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        name: '$pro.name',
        email: '$pro.email',
        avgHours: { $round: ['$avgHours', 1] },
        quotesSent: 1,
      },
    },
  ]);
}

const drawTable = (doc: PDFKit.PDFDocument, headers: string[], rows: (string | number | null)[][], opts?: { startX?: number }) => {
  const startX = opts?.startX ?? 50;
  const pageWidth = doc.page.width - startX - 50;
  const colWidth = pageWidth / headers.length;

  doc.fontSize(9).font('Helvetica-Bold');
  let y = doc.y;
  headers.forEach((h, i) => {
    doc.text(h, startX + i * colWidth, y, { width: colWidth - 4, lineBreak: false, ellipsis: true });
  });
  doc.moveTo(startX, y + 14).lineTo(startX + pageWidth, y + 14).stroke();
  doc.moveDown(1.2);

  doc.font('Helvetica').fontSize(8);
  for (const row of rows) {
    if (doc.y > doc.page.height - 80) {
      doc.addPage();
    }
    const rowY = doc.y;
    row.forEach((cell, i) => {
      const text = cell == null ? '' : String(cell);
      doc.text(text, startX + i * colWidth, rowY, { width: colWidth - 4, lineBreak: false, ellipsis: true });
    });
    doc.moveDown(1);
  }
  doc.moveDown(0.5);
};

export async function generateKpiPdf(from: Date, to: Date): Promise<Buffer> {
  const [summary, regionRows, serviceRows, responseRows] = await Promise.all([
    aggregateSummary({ from, to }),
    aggregateByRegion({ from, to }),
    aggregateByService({ from, to }),
    aggregateResponseTimes({ from, to }),
  ]);

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers: Buffer[] = [];
      doc.on('data', (b: Buffer) => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const rangeLabel = `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`;

      doc.fontSize(20).font('Helvetica-Bold').text('FIXERA — Monthly KPI Report', { align: 'left' });
      doc.fontSize(10).font('Helvetica').text(`Period: ${rangeLabel}`).moveDown(1);

      doc.fontSize(13).font('Helvetica-Bold').text('Summary');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      const summaryLines: [string, string][] = [
        ['Sign-ups', String(summary.signUps)],
        ['Total bookings', String(summary.totalBookings)],
        ['Completed bookings', String(summary.completedBookings)],
        ['Gross revenue (EUR)', summary.grossRevenue.toFixed(2)],
        ['Platform revenue (EUR)', summary.platformRevenue.toFixed(2)],
        ['Dispute rate', `${summary.disputeRate}%`],
        ['Warranty claim rate', `${summary.warrantyClaimRate}%`],
        ['Refund rate', `${summary.refundRate}%`],
        ['Avg time to first quote', summary.avgTimeToFirstQuoteHours != null ? `${summary.avgTimeToFirstQuoteHours} h` : 'n/a'],
      ];
      for (const [k, v] of summaryLines) {
        doc.text(`${k}: ${v}`);
      }
      doc.moveDown(1);

      doc.fontSize(13).font('Helvetica-Bold').text('By Region (City)');
      doc.moveDown(0.5);
      drawTable(
        doc,
        ['City', 'Sign-ups', 'Views', 'Bookings', 'Booked €', 'Platform €', 'Convert %', 'Dispute %', 'Refund %'],
        regionRows.slice(0, 40).map((r: any) => [r.city, r.signUps, r.views, r.totalBookings, r.bookedValue.toFixed(2), r.platformRevenue.toFixed(2), r.quotationConversionRate, r.disputeRate, r.refundRate])
      );

      if (doc.y > doc.page.height - 200) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text('By Service');
      doc.moveDown(0.5);
      drawTable(
        doc,
        ['Service', 'Views', 'RFQs', 'Bookings', 'Views→Booking %'],
        serviceRows.slice(0, 40).map((r: any) => [r.service, r.views, r.totalRfqs, r.bookingsCount, r.viewsToBookingRate])
      );

      if (doc.y > doc.page.height - 200) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text('Top Professional Response Times (avg hours to first quote)');
      doc.moveDown(0.5);
      drawTable(
        doc,
        ['Professional', 'Email', 'Quotes', 'Avg hours'],
        responseRows.map((r: any) => [r.name || '-', r.email || '-', r.quotesSent, r.avgHours])
      );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
