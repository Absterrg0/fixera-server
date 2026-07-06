import { Request, Response } from 'express';
import Payment from '../../models/payment';
import { captureAndTransferPayment } from '../Stripe/payment';
import { ensureBookingInvoiceArtifacts, ensureCreditInvoiceArtifacts } from '../../services/invoiceArtifacts';

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getPayments = async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '25', search } = req.query;
    const pageNumber = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNumber = Math.min(Math.max(parseInt(limit as string, 10) || 25, 5), 100);

    const query: Record<string, any> = {};

    if (status && typeof status === 'string' && status !== 'all') {
      query.status = status;
    }

    if (typeof search === 'string' && search.trim().length > 0) {
      const term = search.trim();
      const regex = new RegExp(escapeRegex(term), 'i');
      query.$or = [
        { bookingNumber: regex },
        { stripePaymentIntentId: regex },
        { stripeChargeId: regex },
        { stripeTransferId: regex },
      ];
    }

    const skip = (pageNumber - 1) * limitNumber;

    const [payments, totalCount, statusBreakdown] = await Promise.all([
      Payment.find(query)
        .populate('booking', 'status bookingType bookingNumber createdAt')
        .populate('customer', 'name email')
        .populate('professional', 'name email businessInfo companyName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      Payment.countDocuments(query),
      Payment.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalVolume: { $sum: '$totalWithVat' }
          }
        }
      ])
    ]);

    res.json({
      success: true,
      data: {
        payments,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNumber)
        },
        stats: statusBreakdown
          .map(item => ({
            status: item._id,
            count: item.count,
            totalVolume: item.totalVolume
          }))
      }
    });
  } catch (error: any) {
    console.error('[ADMIN][PAYMENTS] Failed to fetch payments', error);
    res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to load payments'
    });
  }
};

export const capturePayment = async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, msg: 'Payment not found' });
    }

    if (payment.status !== 'authorized') {
      return res.status(400).json({
        success: false,
        msg: `Cannot capture payment with status "${payment.status}". Only authorized payments can be captured.`
      });
    }

    const bookingId = payment.booking.toString();
    const result = await captureAndTransferPayment(bookingId);

    if (!result.success) {
      if (result.error?.code === 'TRANSFER_FAILED') {
        return res.status(207).json({
          success: true,
          msg: 'Payment capture succeeded, but transfer to professional failed',
          warning: {
            code: result.error.code,
            details: result.error,
          },
          data: {
            bookingId,
            captureSucceeded: true,
            transferSucceeded: false,
          },
        });
      }

      return res.status(500).json({
        success: false,
        msg: 'Failed to capture and transfer payment',
        error: result.error
      });
    }

    return res.json({
      success: true,
      msg: 'Payment captured and transferred successfully'
    });
  } catch (error: any) {
    console.error('[ADMIN][PAYMENTS] Failed to capture payment', error);
    res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to capture payment'
    });
  }
};

export const generatePaymentInvoice = async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, msg: 'Payment not found' });
    }

    if (!['completed', 'authorized'].includes(payment.status)) {
      return res.status(400).json({
        success: false,
        msg: `Cannot generate invoice for payment with status "${payment.status}".`,
      });
    }

    const result = await ensureBookingInvoiceArtifacts(payment.booking.toString());
    if (!result) {
      return res.status(400).json({ success: false, msg: 'Unable to generate invoice artifacts for this booking' });
    }

    return res.json({
      success: true,
      msg: 'Invoice artifacts generated',
      data: result,
    });
  } catch (error: any) {
    console.error('[ADMIN][PAYMENTS] Failed to generate invoice artifacts', error);
    res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to generate invoice artifacts',
    });
  }
};

export const generatePaymentCreditNote = async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, msg: 'Payment not found' });
    }

    if (!payment.invoiceNumber) {
      return res.status(400).json({
        success: false,
        msg: 'Generate the original invoice before creating a credit note',
      });
    }

    if (!['completed', 'refunded', 'partially_refunded'].includes(payment.status)) {
      return res.status(400).json({
        success: false,
        msg: `Cannot generate credit note for payment with status "${payment.status}".`,
      });
    }

    const result = await ensureCreditInvoiceArtifacts(payment.booking.toString());
    if (!result) {
      return res.status(400).json({ success: false, msg: 'Unable to generate credit note for this booking' });
    }

    return res.json({
      success: true,
      msg: 'Credit note artifacts generated',
      data: result,
    });
  } catch (error: any) {
    console.error('[ADMIN][PAYMENTS] Failed to generate credit note artifacts', error);
    res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to generate credit note artifacts',
    });
  }
};
