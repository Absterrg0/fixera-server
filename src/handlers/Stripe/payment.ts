/**
 * Stripe Payment Handlers
 * Handles payment intent creation, capture, transfer, and refunds
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import Booking from '../../models/booking';
import User from '../../models/user';
import Payment from '../../models/payment';
import {
  generateIdempotencyKey,
  convertToStripeAmount,
  calculateProfessionalPayout,
  calculatePlatformCommission,
  calculateStripeFee,
  validatePaymentAmount,
  buildPaymentMetadata,
  buildTransferMetadata,
  determineBookingCurrency,
  computeGrossBookingAmount,
} from '../../utils/payment';
import { calculateVAT } from '../../utils/vat';
import { calculateVatFromPricingLines } from '../../utils/vatLineCalculation';
import { requiresVatRfqReview } from '../../utils/vatManagement';
import PlatformSettings from '../../models/platformSettings';
import { calculateAutoDiscount } from '../../utils/discountEngine';
// deductPoints moved to webhook handler (handlePaymentIntentSucceeded)
import { calculateDiscountedPayouts } from '../../utils/discountEngine';
import { auditLog } from '../../utils/auditLogger';
import { ensureBookingInvoiceArtifacts } from '../../services/invoiceArtifacts';

const extractParticipantIds = (booking: any, professionalOverride?: any) => {
  const customerId = (booking.customer as any)?._id || booking.customer;
  const professionalSource = professionalOverride || booking.professional;
  const professionalId = (professionalSource as any)?._id || professionalSource || undefined;
  return { customerId, professionalId };
};

const ALLOWED_PAYMENT_OVERRIDE_KEYS = new Set([
  'status',
  'method',
  'netAmount',
  'vatAmount',
  'vatRate',
  'totalWithVat',
  'reverseCharge',
  'vatBreakdown',
  'platformCommission',
  'professionalPayout',
  'stripePaymentIntentId',
  'stripeChargeId',
  'stripeTransferId',
  'stripeDestinationPayment',
  'authorizedAt',
  'capturedAt',
  'transferredAt',
  'refundedAt',
  'canceledAt',
  'invoiceNumber',
  'invoiceUrl',
  'invoiceUblUrl',
  'invoiceGeneratedAt',
  'peppolDispatchStatus',
  'peppolDispatchReference',
  'peppolDispatchedAt',
  'metadata',
  'notes',
  'refundReason',
  'refundSource',
  'refundNotes',
]);

const filterPaymentOverrides = (overrides: Record<string, any>) =>
  Object.entries(overrides).reduce((acc, [key, value]) => {
    if (ALLOWED_PAYMENT_OVERRIDE_KEYS.has(key)) {
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, any>);

const buildPaymentUpsertBase = (booking: any, overrides: Record<string, any> = {}, professionalOverride?: any) => {
  const { customerId, professionalId } = extractParticipantIds(booking, professionalOverride);
  const paymentSummary = booking.payment || {};
  const quoteSummary = booking.quote || {};

  const currency = paymentSummary.currency || quoteSummary.currency || 'EUR';
  const amount = paymentSummary.amount || quoteSummary.amount || 0;

  return {
    booking: booking._id,
    bookingNumber: booking.bookingNumber,
    customer: customerId,
    professional: professionalId,
    method: paymentSummary.method || 'card',
    currency,
    amount,
    netAmount: paymentSummary.netAmount || amount,
    vatAmount: paymentSummary.vatAmount,
    vatRate: paymentSummary.vatRate,
    totalWithVat: paymentSummary.totalWithVat || amount,
    reverseCharge: paymentSummary.reverseCharge,
    vatBreakdown: paymentSummary.vatBreakdown,
    platformCommission: paymentSummary.platformCommission,
    professionalPayout: paymentSummary.professionalPayout,
    invoiceNumber: paymentSummary.invoiceNumber,
    invoiceUrl: paymentSummary.invoiceUrl,
    invoiceUblUrl: paymentSummary.invoiceUblUrl,
    invoiceGeneratedAt: paymentSummary.invoiceGeneratedAt,
    peppolDispatchStatus: paymentSummary.peppolDispatchStatus,
    peppolDispatchReference: paymentSummary.peppolDispatchReference,
    peppolDispatchedAt: paymentSummary.peppolDispatchedAt,
    ...filterPaymentOverrides(overrides),
  };
};

const getQuotePricingVatCalculation = (booking: any, amount: number) => {
  const quoteVersions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  const currentVersion = quoteVersions.find((version: any) => version.version === booking.currentQuoteVersion)
    || quoteVersions[quoteVersions.length - 1];
  const pricingLines = Array.isArray(currentVersion?.pricingLines)
    ? currentVersion.pricingLines
    : [];
  if (pricingLines.length === 0) {
    return null;
  }
  const hasCompleteVatMetadata = pricingLines.every((line: any) =>
    Number.isFinite(Number(line.price)) &&
    Number(line.price) > 0 &&
    Number.isFinite(Number(line.vatRate)) &&
    Number(line.vatRate) >= 0 &&
    Number(line.vatRate) <= 100
  );
  if (!hasCompleteVatMetadata) {
    return null;
  }
  return calculateVatFromPricingLines(pricingLines, amount);
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

type CreatePaymentIntentResult = {
  success: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  milestoneIndex?: number | null;
  error?: any;
};

type NormalizedBookingMilestone = {
  amount: number;
  customDueDate?: Date | string;
  dueCondition?: string;
  order?: number;
  status?: string;
  workStatus?: string;
  _originalIndex: number;
};

const normalizeBookingMilestones = (milestones: any[]): NormalizedBookingMilestone[] =>
  milestones
    .map((milestone: any, idx: number) => ({
      ...(milestone?.toObject?.() || milestone),
      _originalIndex: idx,
    }))
    .sort((a: NormalizedBookingMilestone, b: NormalizedBookingMilestone) => (a.order ?? 0) - (b.order ?? 0));

const isMilestoneCurrentlyPayable = (
  milestone: NormalizedBookingMilestone,
  sortedMilestones: NormalizedBookingMilestone[]
): boolean => {
  if (milestone.status === 'paid') return false;

  const milestoneOrder = milestone.order ?? 0;
  const hasEarlierUnpaidMilestone = sortedMilestones.some(
    (candidate) => (candidate.order ?? 0) < milestoneOrder && candidate.status !== 'paid'
  );
  if (hasEarlierUnpaidMilestone) return false;

  const dueCondition = milestone.dueCondition;
  if (dueCondition === 'on_start') return true;
  if (dueCondition === 'on_milestone_start') {
    return milestone.workStatus === 'in_progress' || milestone.workStatus === 'completed';
  }
  if (dueCondition === 'on_milestone_completion') {
    return milestone.workStatus === 'completed';
  }
  if (dueCondition === 'custom_date') {
    if (milestone.workStatus === 'completed') return true;
    return !!milestone.customDueDate && new Date(milestone.customDueDate) <= new Date();
  }

  return false;
};

/**
 * Create Payment Intent when customer accepts quote
 * Called from booking respond endpoint
 */
export const createPaymentIntent = async (
  bookingId: string,
  userId: string,
  pointsToRedeem: number = 0,
  requestedMilestoneIndex?: number,
  discountCode?: string
): Promise<CreatePaymentIntentResult> => {
  try {
    const booking = await Booking.findById(bookingId)
      .populate('customer')
      .populate('professional')
      .populate('project', 'professionalId title extraOptions');

    if (!booking) {
      return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } };
    }

    // Verify customer
    if (booking.customer._id.toString() !== userId) {
      return { success: false, error: { code: 'UNAUTHORIZED', message: 'Not authorized' } };
    }

    const hasUnpaidMilestones = Array.isArray(booking.milestonePayments)
      && booking.milestonePayments.length > 0
      && booking.milestonePayments.some((m: any) => m.status !== 'paid');

    const allowedStatuses = hasUnpaidMilestones
      ? ['quote_accepted', 'payment_pending', 'booked', 'in_progress', 'professional_completed']
      : ['quote_accepted', 'payment_pending', 'booked'];
    if (!booking.quote || !allowedStatuses.includes(booking.status)) {
      return { success: false, error: { code: 'NO_QUOTE', message: 'No quote to pay for' } };
    }

    // Get professional (direct booking or project owner)
    let professional = booking.professional as any;
    if (!professional && booking.project && (booking.project as any).professionalId) {
      professional = await User.findById((booking.project as any).professionalId);
    }

    if (!professional) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_NOT_FOUND',
          message: 'No professional assigned to this booking'
        }
      };
    }
    const customer = booking.customer as any;
    const projectInfo = booking.project as any;
    const selectedExtraOptionsTotal = Array.isArray(booking.selectedExtraOptions)
      ? booking.selectedExtraOptions.reduce(
          (sum: number, entry: any) => (typeof entry?.bookedPrice === 'number' ? sum + entry.bookedPrice : sum),
          0
        )
      : 0;

    // Check if professional has Stripe connected
    if (!professional.stripe?.accountId) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_NO_STRIPE',
          message: 'Professional hasn\'t connected their Stripe account yet. Payment cannot proceed.'
        }
      };
    }

    if (!professional.stripe.chargesEnabled) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_STRIPE_NOT_READY',
          message: 'Professional\'s Stripe account is not fully set up yet.'
        }
      };
    }

    // Fetch commission rate from DB early so milestone amounts include it
    let commissionPercent: number;
    try {
      const platformConfig = await PlatformSettings.getCurrentConfig();
      commissionPercent = platformConfig.commissionPercent;
    } catch (configError) {
      console.warn('Failed to fetch platform config from DB, falling back to env var:', configError);
      const parsed = Number.parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0');
      commissionPercent = Number.isFinite(parsed) ? parsed : 0;
    }

    // Determine currency
    const currency = determineBookingCurrency(
      booking.quote.currency,
      professional.currency,
      customer.location?.country
    );

    let chargeAmount = +(booking.quote.amount * (1 + commissionPercent / 100)).toFixed(2);
    let milestoneIndex: number | null = null;
    let milestoneOrder: number | null = null;
    if (Array.isArray(booking.milestonePayments) && booking.milestonePayments.length > 0) {
      const sorted = normalizeBookingMilestones(booking.milestonePayments as any[]);
      const nextPayable = sorted.find((milestone) => isMilestoneCurrentlyPayable(milestone, sorted));
      if (nextPayable) {
        if (
          typeof requestedMilestoneIndex === 'number'
          && nextPayable._originalIndex !== requestedMilestoneIndex
        ) {
          return {
            success: false,
            error: {
              code: 'MILESTONE_NOT_DUE',
              message: 'The selected milestone is not currently due for payment.'
            }
          };
        }
        chargeAmount = +(nextPayable.amount * (1 + commissionPercent / 100)).toFixed(2);
        milestoneIndex = nextPayable._originalIndex;
        milestoneOrder = nextPayable.order ?? 0;
      } else {
        return {
          success: false,
          error: {
            code: 'NO_MILESTONE_DUE',
            message: 'No milestone is currently due for payment.'
          }
        };
      }
    }
    const commissionedExtraOptionsTotal = +(selectedExtraOptionsTotal * (1 + commissionPercent / 100)).toFixed(2);
    let milestoneExtraOptionsCharge = 0;
    if (selectedExtraOptionsTotal > 0) {
      if (Array.isArray(booking.milestonePayments) && booking.milestonePayments.length > 0) {
        const minOrder = Math.min(...booking.milestonePayments.map((m: any) => m.order ?? 0));
        if (milestoneOrder === minOrder) {
          milestoneExtraOptionsCharge = commissionedExtraOptionsTotal;
          chargeAmount += milestoneExtraOptionsCharge;
        }
      } else {
        chargeAmount += commissionedExtraOptionsTotal;
      }
    }

    if (booking.payment?.stripePaymentIntentId && booking.payment?.stripeClientSecret) {
      if (['authorized', 'completed'].includes(booking.payment.status) && !hasUnpaidMilestones) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ALREADY_PROCESSED',
            message: 'Payment has already been processed for this booking'
          }
        };
      }
      const isMatchingPendingMilestoneIntent =
        typeof requestedMilestoneIndex === 'number'
          ? booking.payment.milestoneIndex === requestedMilestoneIndex
          : true;
      const storedCodeLabel = (booking.payment as any)?.discount?.codeLabel;
      const requestedCodeLabel = discountCode ? discountCode.trim().toUpperCase() : undefined;
      const codeMatches = (storedCodeLabel || undefined) === (requestedCodeLabel || undefined);
      const storedPoints = Number((booking.payment as any)?.discount?.pointsRedeemed) || 0;
      const pointsMatch = storedPoints === (Number(pointsToRedeem) || 0);

      // Verify that the charge amount matches the original amount of the pending payment intent
      const existingOriginalAmount = booking.payment?.discount?.originalAmount ?? booking.payment?.netAmount ?? 0;
      const amountMatches = Math.abs(chargeAmount - existingOriginalAmount) < 0.01;

      if (booking.payment.status === 'pending' && isMatchingPendingMilestoneIntent && codeMatches && pointsMatch && amountMatches) {
        console.log(`♻️  Reusing existing PaymentIntent for booking ${booking._id}: ${booking.payment.stripePaymentIntentId}`);
        return {
          success: true,
          clientSecret: booking.payment.stripeClientSecret,
          paymentIntentId: booking.payment.stripePaymentIntentId,
          milestoneIndex: typeof booking.payment.milestoneIndex === 'number' ? booking.payment.milestoneIndex : null,
        };
      }
      if (booking.payment.status === 'pending') {
        try {
          await stripe.paymentIntents.cancel(booking.payment.stripePaymentIntentId);
          console.log(`🗑️  Cancelled superseded PaymentIntent ${booking.payment.stripePaymentIntentId} for booking ${booking._id}`);
        } catch (cancelErr: any) {
          if (cancelErr?.code !== 'payment_intent_unexpected_state' && cancelErr?.code !== 'resource_missing') {
            console.warn(`Failed to cancel superseded PaymentIntent: ${cancelErr?.message || cancelErr}`);
          }
        }
      }
    }

    const fullBookingAmount = computeGrossBookingAmount(booking, commissionPercent);

    let codeInfo: any = null;
    if (discountCode) {
      const { validateDiscountCode } = await import('../../utils/discountEngine');
      const validation = await validateDiscountCode(
        discountCode,
        customer._id.toString(),
        fullBookingAmount,
        customer.location?.country,
        (booking as any).rfqData?.serviceType
      );
      if (!validation.ok) {
        return { success: false, error: { code: 'INVALID_DISCOUNT_CODE', message: validation.error || 'Invalid discount code' } };
      }
      codeInfo = validation.info;
    }


    const fullDiscountBreakdown = await calculateAutoDiscount(
      customer._id.toString(),
      professional._id.toString(),
      booking.project ? (booking.project as any)._id?.toString() || booking.project.toString() : null,
      fullBookingAmount,
      customer.totalSpent || 0,
      pointsToRedeem,
      codeInfo
    );

    let discountBreakdown = fullDiscountBreakdown;
    if (fullBookingAmount > 0 && chargeAmount < fullBookingAmount) {
      const ratio = chargeAmount / fullBookingAmount;
      const proratedLoyalty = Math.round(fullDiscountBreakdown.loyaltyDiscount.amount * ratio * 100) / 100;
      const proratedRepeat = Math.round(fullDiscountBreakdown.repeatBuyerDiscount.amount * ratio * 100) / 100;
      const proratedPoints = Math.round(fullDiscountBreakdown.pointsDiscount.discountAmount * ratio * 100) / 100;
      const proratedCode = fullDiscountBreakdown.codeDiscount
        ? Math.round(fullDiscountBreakdown.codeDiscount.amount * ratio * 100) / 100
        : 0;
      const proratedTotal = proratedLoyalty + proratedRepeat + proratedPoints + proratedCode;
      discountBreakdown = {
        ...fullDiscountBreakdown,
        loyaltyDiscount: { ...fullDiscountBreakdown.loyaltyDiscount, amount: proratedLoyalty },
        repeatBuyerDiscount: { ...fullDiscountBreakdown.repeatBuyerDiscount, amount: proratedRepeat },
        pointsDiscount: { ...fullDiscountBreakdown.pointsDiscount, discountAmount: proratedPoints },
        codeDiscount: fullDiscountBreakdown.codeDiscount
          ? { ...fullDiscountBreakdown.codeDiscount, amount: proratedCode }
          : undefined,
        totalDiscount: proratedTotal,
        originalAmount: chargeAmount,
        finalAmount: chargeAmount - proratedTotal,
      };
    }

    // Use discounted amount for VAT and payment calculations
    const discountedQuoteAmount = discountBreakdown.finalAmount;

    // Calculate VAT on the discounted amount. Prefer the booking's service-level VAT
    // decision when the booking wizard already evaluated a configured rule.
    const configuredVatDecision = (booking as any).vatDecision;
    const quotePricingVatCalculation = getQuotePricingVatCalculation(booking, discountedQuoteAmount);
    const vatCalculation = quotePricingVatCalculation
      ? quotePricingVatCalculation
      : configuredVatDecision && !requiresVatRfqReview(configuredVatDecision)
        ? (() => {
            const vatRate = Number(configuredVatDecision.appliedRate) || 0;
            const vatAmount = Math.round(((discountedQuoteAmount * vatRate) / 100) * 100) / 100;
            return {
              vatRate,
              vatAmount,
              total: Math.round((discountedQuoteAmount + vatAmount) * 100) / 100,
              reverseCharge: Boolean(configuredVatDecision.reverseCharge),
            };
          })()
        : calculateVAT({
          amount: discountedQuoteAmount,
          customerCountry: customer.location?.country || 'BE',
          customerVATNumber: customer.isVatVerified ? customer.vatNumber || null : null,
          customerVatVerified: customer.isVatVerified === true,
          professionalCountry: professional.businessInfo?.country || 'BE',
          customerType: customer.customerType || 'individual',
        });

    // Calculate amounts
    const netAmount = discountedQuoteAmount;
    const vatAmount = vatCalculation.vatAmount;
    const totalAmount = vatCalculation.total;

    // Validate payment amount against Stripe minimums/maximums
    const amountValidation = validatePaymentAmount(totalAmount, currency);
    if (!amountValidation.valid) {
      return { success: false, error: { code: 'INVALID_AMOUNT', message: amountValidation.error! } };
    }

    // Use hybrid discount absorption model
    const discountedPayouts = calculateDiscountedPayouts(discountBreakdown, commissionPercent);
    const platformCommission = discountedPayouts.platformCommission;
    const professionalPayout = discountedPayouts.professionalPayout;
    const stripeFee = calculateStripeFee(totalAmount, currency);

    if (discountBreakdown.totalDiscount > 0) {
      console.log(`Discount applied for booking ${booking._id}: loyalty=${discountBreakdown.loyaltyDiscount.amount}, repeat=${discountBreakdown.repeatBuyerDiscount.amount}, points=${discountBreakdown.pointsDiscount.discountAmount}, total=${discountBreakdown.totalDiscount}`);
    }

    // Create Payment Intent with immediate charge
    const paymentIntent = await stripe.paymentIntents.create({
      amount: convertToStripeAmount(totalAmount, currency),
      currency: currency.toLowerCase(),
      payment_method_types: ['card'],
      metadata: buildPaymentMetadata(
        booking._id.toString(),
        booking.bookingNumber || '',
        customer._id.toString(),
        professional._id.toString(),
        professional.stripe.accountId,
        STRIPE_CONFIG.environment as 'production' | 'test'
      ),
      description: `Fixera Booking #${booking.bookingNumber} - ${projectInfo?.title || 'Service'}`,
    }, {
      idempotencyKey: generateIdempotencyKey({
        bookingId: booking._id.toString(),
        operation: 'payment-intent',
        timestamp: Date.now(),
      })
    });

    // Update booking with payment info
    booking.payment = {
      amount: netAmount,
      currency: currency,
      method: 'card',
      status: 'pending',
      stripePaymentIntentId: paymentIntent.id,
      stripeClientSecret: paymentIntent.client_secret || undefined,
      stripeFeeAmount: stripeFee,
      platformCommission,
      professionalPayout,
      netAmount,
      vatAmount,
      vatRate: vatCalculation.vatRate,
      totalWithVat: totalAmount,
      reverseCharge: vatCalculation.reverseCharge,
      vatBreakdown: (vatCalculation as any).vatBreakdown,
      ...(milestoneIndex !== null && { milestoneIndex }),
      ...(discountBreakdown.totalDiscount > 0 && {
        discount: {
          loyaltyTier: discountBreakdown.loyaltyDiscount.tier,
          loyaltyPercentage: discountBreakdown.loyaltyDiscount.percentage,
          loyaltyAmount: discountBreakdown.loyaltyDiscount.amount,
          repeatBuyerPercentage: discountBreakdown.repeatBuyerDiscount.percentage,
          repeatBuyerAmount: discountBreakdown.repeatBuyerDiscount.amount,
          pointsRedeemed: discountBreakdown.pointsDiscount.pointsUsed,
          pointsDiscountAmount: discountBreakdown.pointsDiscount.discountAmount,
          codeDiscountAmount: discountBreakdown.codeDiscount?.amount || 0,
          codeId: discountBreakdown.codeDiscount?.codeId
            ? new mongoose.Types.ObjectId(discountBreakdown.codeDiscount.codeId)
            : undefined,
          codeLabel: discountBreakdown.codeDiscount?.code || undefined,
          totalDiscount: discountBreakdown.totalDiscount,
          originalAmount: discountBreakdown.originalAmount,
        },
      }),
    };
    if (!hasUnpaidMilestones || ['quote_accepted', 'payment_pending'].includes(booking.status)) {
      booking.status = 'payment_pending';
    }
    await booking.save();

    // Points deduction is handled in the payment success webhook (handlePaymentIntentSucceeded)
    // to avoid permanently consuming points if the payment is abandoned or fails.
    // The booking.payment.discount.pointsRedeemed field tells the webhook how much to deduct.

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      buildPaymentUpsertBase(
        booking,
        {
          status: 'pending',
          method: 'card',
          currency,
          amount: netAmount,
          netAmount,
          vatAmount,
          vatRate: vatCalculation.vatRate,
          totalWithVat: totalAmount,
          reverseCharge: vatCalculation.reverseCharge,
          vatBreakdown: (vatCalculation as any).vatBreakdown,
          platformCommission,
          professionalPayout,
          stripePaymentIntentId: paymentIntent.id,
          ...(milestoneIndex !== null && { milestoneIndex }),
          metadata: {
            environment: STRIPE_CONFIG.environment,
            projectId: projectInfo?._id?.toString?.(),
          },
        },
        professional
      ),
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Payment Intent created for booking ${booking._id}: ${paymentIntent.id}`);

    return {
      success: true,
      clientSecret: paymentIntent.client_secret || undefined,
      paymentIntentId: paymentIntent.id,
      milestoneIndex,
    };

  } catch (error: any) {
    console.error('Error creating payment intent:', error);
    return {
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to create payment intent'
      }
    };
  }
};

/**
 * Confirm payment after customer completes payment on frontend
 * POST /api/stripe/payment/confirm
 */
export const confirmPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId, paymentIntentId } = req.body;
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    if (typeof bookingId !== 'string' || !bookingId.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_BOOKING_ID', message: 'bookingId must be a non-empty string' }
      });
    }

    if (typeof paymentIntentId !== 'string' || !paymentIntentId.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PAYMENT_INTENT_ID', message: 'paymentIntentId must be a non-empty string' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Verify customer
    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    // Check if payment is already authorized or completed
    if (booking.payment?.status === 'authorized' || booking.payment?.status === 'completed') {
      console.log(`[PAYMENT CONFIRM] Payment already ${booking.payment.status} for booking ${booking._id}`);
      return res.json({
        success: true,
        data: {
          status: booking.payment.status,
          bookingId: booking._id,
          message: `Payment already ${booking.payment.status}`,
          alreadyProcessed: true
        }
      });
    }

    // Verify the payment intent ID matches the booking
    if (booking.payment?.stripePaymentIntentId && booking.payment.stripePaymentIntentId !== paymentIntentId) {
      console.warn(`[PAYMENT CONFIRM] PaymentIntent mismatch: expected ${booking.payment.stripePaymentIntentId}, got ${paymentIntentId}`);
      return res.status(400).json({
        success: false,
        error: { code: 'PAYMENT_INTENT_MISMATCH', message: 'Payment intent does not match this booking' }
      });
    }

    // Retrieve payment intent from Stripe
    console.log(`[PAYMENT CONFIRM] Retrieving PaymentIntent ${paymentIntentId} from Stripe`);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      // Payment charged successfully — funds in Fixera's Stripe account
      console.log(`[PAYMENT CONFIRM] PaymentIntent status is succeeded, updating booking`);

      const now = new Date();
      const msIdx = booking.payment!.milestoneIndex;
      const updateFields: Record<string, any> = {
        'payment.status': 'authorized',
        'payment.authorizedAt': now,
        'payment.capturedAt': now,
      };
      if (booking.status === 'quote_accepted' || booking.status === 'payment_pending') {
        updateFields.status = 'booked';
      }
      if (paymentIntent.latest_charge) {
        updateFields['payment.stripeChargeId'] = paymentIntent.latest_charge as string;
      }
      if (typeof msIdx === 'number' && Array.isArray(booking.milestonePayments) && booking.milestonePayments[msIdx]) {
        updateFields[`milestonePayments.${msIdx}.status`] = 'paid';
        updateFields[`milestonePayments.${msIdx}.paidAt`] = now;
      }

      const milestoneFilter: Record<string, any> = { _id: booking._id };
      if (typeof msIdx === 'number') {
        milestoneFilter[`milestonePayments.${msIdx}.status`] = { $ne: 'paid' };
      }

      await Booking.findOneAndUpdate(milestoneFilter, { $set: updateFields });
      const refreshed = await Booking.findById(booking._id);
      if (refreshed) {
        booking.payment = refreshed.payment;
        booking.status = refreshed.status;
        booking.milestonePayments = refreshed.milestonePayments;
      }

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        buildPaymentUpsertBase(booking, {
          status: 'authorized',
          stripePaymentIntentId: paymentIntent.id,
          stripeChargeId: (paymentIntent.latest_charge as string) || booking.payment!.stripeChargeId,
          authorizedAt: booking.payment!.authorizedAt || new Date(),
          capturedAt: booking.payment!.capturedAt || new Date(),
        })
      );

      void ensureBookingInvoiceArtifacts(booking._id.toString()).catch((invoiceError: unknown) => {
        console.error(
          `[PAYMENT CONFIRM] Payment authorized for booking ${booking._id}, but invoice generation failed:`,
          invoiceError instanceof Error ? invoiceError.message : invoiceError
        );
      });

      console.log(`✅ Payment authorized for booking ${booking._id}`);

      return res.json({
        success: true,
        data: {
          status: 'authorized',
          bookingId: booking._id,
          message: 'Payment authorized successfully'
        }
      });
    }

    // Handle other statuses
    res.json({
      success: true,
      data: {
        status: paymentIntent.status,
        message: 'Payment confirmation received, awaiting webhook'
      }
    });

  } catch (error: any) {
    console.error('Error confirming payment:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: 'Failed to confirm payment'
      }
    });
  }
};

/**
 * Capture payment and transfer to professional on booking completion
 */
export const captureAndTransferPayment = async (bookingId: string): Promise<{ success: boolean; error?: any }> => {
  try {
    const booking = await Booking.findById(bookingId).populate('professional');
    if (!booking) {
      return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } };
    }

    if (!booking.payment?.stripePaymentIntentId) {
      return { success: false, error: { code: 'NO_PAYMENT', message: 'No payment to capture' } };
    }

    if (booking.payment.status !== 'authorized') {
      return { success: false, error: { code: 'INVALID_STATUS', message: 'Payment not authorized' } };
    }

    const professional = booking.professional as any;

    // Payment already captured (automatic capture) — proceed to transfer
    const latestChargeId = booking.payment.stripeChargeId;

    console.log(`Transferring payment for booking ${booking._id} (already captured)`);

    // Step 2: Transfer to professional (money goes from Fixera -> Professional)
    const payoutMajorAmount = Number(
      booking.payment.professionalPayout ?? booking.payment.totalWithVat ?? booking.payment.amount ?? 0
    );
    const bookingCurrency = (booking.payment.currency || 'EUR').toLowerCase();
    const destinationAccountId = professional?.stripe?.accountId;
    if (!destinationAccountId) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_STRIPE_ACCOUNT_MISSING',
          message: 'Professional Stripe account missing or deauthorized',
        },
      };
    }

    let transferCurrency = bookingCurrency;
    let transferAmount = convertToStripeAmount(payoutMajorAmount, transferCurrency);
    let sourceTransaction: string | undefined;

    // If Stripe settled the charge in another currency (e.g., USD), source_transaction transfers
    // must use that settlement currency. We compute payout proportionally in minor units.
    if (latestChargeId) {
      sourceTransaction = latestChargeId;
      try {
        const charge = await stripe.charges.retrieve(latestChargeId, {
          expand: ['balance_transaction'],
        });

        const balanceTransaction =
          typeof charge.balance_transaction === 'string'
            ? null
            : (charge.balance_transaction as Stripe.BalanceTransaction);

        if (balanceTransaction?.currency) {
          transferCurrency = balanceTransaction.currency.toLowerCase();
        } else if (charge.currency) {
          transferCurrency = charge.currency.toLowerCase();
        }

        if (typeof balanceTransaction?.amount === 'number' && balanceTransaction.amount > 0) {
          const bookingTotal = Number(booking.payment.totalWithVat ?? booking.payment.amount ?? payoutMajorAmount);
          const payoutRatio = bookingTotal > 0 ? clamp(payoutMajorAmount / bookingTotal, 0, 1) : 1;
          transferAmount = Math.max(1, Math.round(balanceTransaction.amount * payoutRatio));
        }
      } catch (chargeInspectError: any) {
        console.warn(
          `[TRANSFER] Could not inspect charge ${latestChargeId} for booking ${booking._id}. Falling back to booking currency.`,
          chargeInspectError?.message || chargeInspectError
        );
      }
    }

    let transfer;
    try {
      transfer = await stripe.transfers.create({
        amount: transferAmount,
        currency: transferCurrency,
        destination: destinationAccountId,
        source_transaction: sourceTransaction,
        metadata: {
          ...buildTransferMetadata(
            booking._id.toString(),
            booking.bookingNumber || '',
            new Date().toISOString(),
            STRIPE_CONFIG.environment as 'production' | 'test'
          ),
          bookingCurrency,
          transferCurrency,
        },
        description: `Payout for Booking #${booking.bookingNumber}`,
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'transfer',
        })
      });
    } catch (transferError: any) {
      // Capture succeeded but transfer failed — record the state for manual recovery
      console.error(`Transfer FAILED after capture for booking ${booking._id}:`, transferError.message);

      booking.payment.status = 'completed'; // Money is captured
      booking.payment.refundNotes = `Transfer failed after capture: ${transferError.message}. Funds held in platform account.`;
      await booking.save();

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        buildPaymentUpsertBase(booking, {
          status: 'completed',
          capturedAt: booking.payment.capturedAt,
          stripeChargeId: booking.payment.stripeChargeId,
          metadata: {
            transferFailed: true,
            transferError: transferError.message,
            attemptedTransferCurrency: transferCurrency,
            attemptedTransferAmount: transferAmount,
            bookingCurrency,
          },
        }, professional),
        { upsert: true }
      );

      return {
        success: false,
        error: {
          code: 'TRANSFER_FAILED',
          message: 'Payment captured but transfer to professional failed. Admin will handle manually.'
        }
      };
    }

    console.log(`Transfer created for booking ${booking._id}: ${transfer.id}`);

    // Update booking with full completion
    booking.payment.status = 'completed';
    booking.payment.stripeTransferId = transfer.id;
    booking.payment.stripeDestinationPayment = transfer.destination_payment as string;
    booking.payment.transferCurrency = transferCurrency;
    booking.payment.transferAmount = transferAmount;
    booking.payment.transferredAt = new Date();
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      buildPaymentUpsertBase(booking, {
        status: 'completed',
        stripePaymentIntentId: booking.payment.stripePaymentIntentId,
        stripeChargeId: booking.payment.stripeChargeId,
        stripeTransferId: transfer.id,
        stripeDestinationPayment: transfer.destination_payment as string,
        capturedAt: booking.payment.capturedAt,
        transferredAt: booking.payment.transferredAt,
        professionalPayout: booking.payment.professionalPayout,
      }, professional),
      { upsert: true }
    );

    return { success: true };

  } catch (error: any) {
    console.error('Error capturing and transferring payment:', error);
    return {
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to capture payment'
      }
    };
  }
};

/**
 * Reusable refund core. Throws RefundError on validation/state failures so callers
 * can map to HTTP responses or other flows (e.g., admin-approved cancellation).
 */
export class RefundError extends Error {
  constructor(public code: string, message: string, public httpStatus: number = 400) {
    super(message);
  }
}

export interface RefundResult {
  refundId: string;
  amount: number;
  status?: string;
  refundSource: 'platform' | 'professional' | 'mixed';
}

export const executeRefund = async (
  bookingId: string,
  opts: { amount?: number; reason?: string }
): Promise<RefundResult> => {
  const { amount, reason } = opts;

  if (typeof bookingId !== 'string' || !bookingId.trim() || !mongoose.Types.ObjectId.isValid(bookingId)) {
    throw new RefundError('INVALID_BOOKING_ID', 'bookingId must be a valid non-empty ID');
  }

  let normalizedAmount: number | undefined;
  if (amount !== undefined && amount !== null) {
    const parsedAmount = typeof amount === 'string' ? Number.parseFloat(amount as any) : Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new RefundError('INVALID_AMOUNT', 'amount must be a number greater than 0');
    }
    normalizedAmount = parsedAmount;
  }

  const booking = await Booking.findById(bookingId).populate('professional');
  if (!booking) {
    throw new RefundError('BOOKING_NOT_FOUND', 'Booking not found', 404);
  }

  if (!booking.payment?.stripePaymentIntentId) {
    throw new RefundError('NO_PAYMENT', 'No payment to refund');
  }

  const totalWithVat = booking.payment?.totalWithVat ?? 0;
  let previousRefundTotal = 0;
  if (['completed', 'authorized', 'partially_refunded'].includes(booking.payment.status)) {
    const existingPayment = await Payment.findOne({ booking: booking._id });
    if (existingPayment) {
      previousRefundTotal = (existingPayment.refunds || []).reduce(
        (sum: number, r: any) => sum + (r.amount || 0),
        0
      );
    }
  }
  const remainingRefundable = Math.max(0, totalWithVat - previousRefundTotal);
  if (remainingRefundable <= 0) {
    throw new RefundError(
      'REFUND_EXCEEDS_TOTAL',
      `No refundable amount remaining. Already refunded: ${previousRefundTotal}, original: ${totalWithVat}`
    );
  }
  if (normalizedAmount && normalizedAmount > remainingRefundable) {
    throw new RefundError(
      'REFUND_EXCEEDS_TOTAL',
      `Refund of ${normalizedAmount} would exceed remaining refundable. Already refunded: ${previousRefundTotal}, original: ${totalWithVat}`
    );
  }
  const refundAmount = normalizedAmount ?? remainingRefundable;
  const refundIntentVersion = normalizedAmount
    ? `partial-${booking.payment.stripePaymentIntentId}-${previousRefundTotal}-${normalizedAmount}`
    : `full-${booking.payment.stripePaymentIntentId}-${previousRefundTotal}`;

  if (booking.payment.status === 'authorized') {
    const refund = await stripe.refunds.create(
      {
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, booking.payment.currency || 'EUR'),
      },
      {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'refund',
          version: refundIntentVersion,
        }),
      }
    );

    const isPartial = !!normalizedAmount && normalizedAmount < remainingRefundable;
    booking.payment.status = isPartial ? 'partially_refunded' : 'refunded';
    booking.payment.refundedAt = new Date();
    booking.payment.refundAmount = previousRefundTotal + refundAmount;
    booking.payment.refundReason = reason;
    booking.payment.refundSource = 'platform';
    if (!isPartial) {
      booking.status = 'cancelled';
    }
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id, "refunds.refundId": { $ne: refund.id } },
      {
        $set: buildPaymentUpsertBase(booking, {
          status: booking.payment.status,
          refundedAt: booking.payment.refundedAt,
        }),
        $push: {
          refunds: {
            amount: refundAmount,
            reason,
            refundId: refund.id,
            refundedAt: booking.payment.refundedAt || new Date(),
            source: 'platform',
            notes: 'Refund issued before transfer to professional',
          },
        },
      },
      { upsert: true }
    );

    console.log(`✅ Payment refunded for booking ${booking._id}: ${refund.id}`);

    return { refundId: refund.id, amount: refundAmount, status: refund.status || undefined, refundSource: 'platform' };
  }

  if (booking.payment.status === 'completed' || booking.payment.status === 'partially_refunded') {
    const refund = await stripe.refunds.create(
      {
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, booking.payment.currency || 'EUR'),
      },
      {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'refund',
          version: refundIntentVersion,
        }),
      }
    );

    if (booking.payment.stripeTransferId) {
      try {
        const reversalCurrency =
          booking.payment.transferCurrency || booking.payment.currency || 'EUR';
        const storedTransferAmount = booking.payment.transferAmount;
        let reversalMinorAmount: number | undefined;
        if (typeof storedTransferAmount === 'number' && storedTransferAmount > 0 && totalWithVat > 0) {
          if (normalizedAmount && normalizedAmount < totalWithVat) {
            reversalMinorAmount = Math.min(
              storedTransferAmount,
              Math.max(1, Math.round(storedTransferAmount * (normalizedAmount / totalWithVat)))
            );
          } else {
            reversalMinorAmount = storedTransferAmount;
          }
        } else if (normalizedAmount) {
          reversalMinorAmount = convertToStripeAmount(normalizedAmount, reversalCurrency);
        }
        await stripe.transfers.createReversal(booking.payment.stripeTransferId, {
          amount: reversalMinorAmount,
          metadata: { reason: reason || '', bookingId: booking._id.toString() },
        });
        booking.payment.refundSource = 'professional';
      } catch (error) {
        console.error('Transfer reversal failed:', error);
        booking.payment.refundSource = 'platform';
        booking.payment.refundNotes = 'Platform-funded refund (transfer reversal failed)';
      }
    } else {
      booking.payment.refundSource = 'platform';
    }

    booking.payment.status =
      normalizedAmount && normalizedAmount < remainingRefundable ? 'partially_refunded' : 'refunded';
    booking.payment.refundedAt = new Date();
    booking.payment.refundAmount = previousRefundTotal + refundAmount;
    booking.payment.refundReason = reason;
    if (booking.payment.status === 'refunded') {
      booking.status = 'refunded';
    }
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id, "refunds.refundId": { $ne: refund.id } },
      {
        $set: buildPaymentUpsertBase(booking, {
          status: booking.payment.status,
          refundedAt: booking.payment.refundedAt,
        }),
        $push: {
          refunds: {
            amount: refundAmount,
            reason,
            refundId: refund.id,
            refundedAt: booking.payment.refundedAt || new Date(),
            source: booking.payment.refundSource || 'platform',
            notes: booking.payment.refundNotes,
          },
        },
      },
      { upsert: true }
    );

    console.log(`✅ Refund processed for booking ${booking._id}: ${refund.id}`);

    return {
      refundId: refund.id,
      amount: refundAmount,
      status: refund.status || undefined,
      refundSource: booking.payment.refundSource || 'platform',
    };
  }

  throw new RefundError('INVALID_STATUS', 'Payment cannot be refunded in current status');
};

/**
 * Refund payment
 * POST /api/stripe/payment/refund
 */
export const refundPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId, reason, amount } = req.body;
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    if (typeof bookingId !== 'string' || !bookingId.trim() || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_BOOKING_ID', message: 'bookingId must be a valid non-empty ID' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    const user = await User.findById(userId);
    const isAuthorized = user?.role === 'admin' || booking.customer.toString() === userId;
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to refund' }
      });
    }

    const result = await executeRefund(bookingId, { amount, reason });

    if (user?.role === 'admin') {
      await auditLog({
        req,
        action: 'admin.payment.refund',
        targetType: 'Booking',
        targetId: bookingId,
        details: {
          refundId: result.refundId,
          amount: result.amount,
          status: result.status,
          refundSource: result.refundSource,
          reason,
          requestedAmount: typeof amount === 'number' ? amount : undefined,
        },
        status: 'success',
        statusCode: 200,
      });
    }

    return res.json({
      success: true,
      data: {
        refundId: result.refundId,
        amount: result.amount,
        status: result.status,
        refundSource: result.refundSource,
      },
    });
  } catch (error: any) {
    if (error instanceof RefundError) {
      const userRole = (req as any).user?.role;
      if (userRole === 'admin') {
        await auditLog({
          req,
          action: 'admin.payment.refund',
          targetType: 'Booking',
          targetId: req.body?.bookingId,
          status: 'failure',
          statusCode: error.httpStatus,
          errorMessage: `${error.code}: ${error.message}`,
        });
      }
      return res.status(error.httpStatus).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
    }
    console.error('Error processing refund:', error);
    const userRole = (req as any).user?.role;
    if (userRole === 'admin') {
      await auditLog({
        req,
        action: 'admin.payment.refund',
        targetType: 'Booking',
        targetId: req.body?.bookingId,
        status: 'failure',
        statusCode: 500,
        errorMessage: error?.message || 'unknown',
      });
    }
    res.status(500).json({
      success: false,
      error: { code: 'STRIPE_ERROR', message: 'Failed to refund payment' }
    });
  }
};
