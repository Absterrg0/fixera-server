/**
 * Stripe-related TypeScript types for Fixera Platform
 * Version: 2.1
 */

// ==================== Stripe Account Types ====================

export interface StripeAccountStatusResponse {
  accountId: string;
  onboardingCompleted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  accountStatus: 'pending' | 'active' | 'restricted' | 'rejected';
  requirements: {
    currentlyDue: string[];
    pendingVerification: string[];
  };
}

export interface StripeConnectAccount {
  accountId?: string;
  onboardingCompleted?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  chargesEnabled?: boolean;
  accountStatus?: 'pending' | 'active' | 'restricted' | 'rejected';
  lastOnboardingRefresh?: Date;
  createdAt?: Date;
}

// ==================== Payment Intent Types ====================

export interface PaymentIntentResponse {
  clientSecret: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'requires_capture' | 'canceled' | 'succeeded';
}

export interface PaymentIntentMetadata {
  bookingId: string;
  bookingNumber: string;
  customerId: string;
  professionalId: string;
  professionalStripeAccountId: string;
  type: 'booking_payment';
  environment: 'production' | 'test';
  version: 'v1';
}

// ==================== Booking Payment Types ====================

export interface BookingPayment {
  // Core payment info
  amount: number;
  currency: string;
  status: 'pending' | 'authorized' | 'completed' | 'failed' | 'refunded' | 'partially_refunded' | 'disputed';
  method: 'card' | 'bank_transfer' | 'cash';

  // Stripe IDs
  stripePaymentIntentId?: string;
  stripeClientSecret?: string;
  stripeChargeId?: string;
  stripeTransferId?: string;
  stripeDestinationPayment?: string;

  // Financial breakdown
  stripeFeeAmount?: number;
  platformCommission: number;
  professionalPayout: number;
  netAmount: number;
  vatAmount: number;
  vatRate: number;
  totalWithVat: number;
  vatBreakdown?: {
    description: string;
    netAmount: number;
    vatRate: number;
    vatAmount: number;
    totalAmount: number;
    vatCountry?: string;
    vatLabel?: string;
  }[];

  // Multi-currency support
  originalCurrency?: string;
  fxRate?: number;
  fxProvider?: 'stripe' | 'fixera';

  // Timestamps
  authorizedAt?: Date;
  capturedAt?: Date;
  transferredAt?: Date;
  paidAt?: Date;
  refundedAt?: Date;

  // Refund metadata
  refundReason?: string;
  refundSource?: 'professional' | 'platform' | 'mixed';
  refundNotes?: string;

  // Invoice
  invoiceNumber?: string;
  invoiceUrl?: string;
  invoiceGeneratedAt?: Date;
}

// ==================== Transfer Types ====================

export interface TransferResponse {
  transferId: string;
  amount: number;
  currency: string;
  destination: string;
  status: 'pending' | 'paid' | 'failed' | 'canceled' | 'reversed';
  arrivalDate?: Date;
  reversalId?: string;
}

export interface TransferMetadata {
  bookingId: string;
  bookingNumber: string;
  type: 'booking_completion_payout';
  payoutDate: string;
  environment: 'production' | 'test';
}

// ==================== Refund Types ====================

export interface RefundRequest {
  bookingId: string;
  amount?: number; // Optional for partial refunds
  reason: string;
  requestedBy: string; // Admin ID or customer ID
}

export interface RefundResponse {
  refundId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  refundSource: 'professional' | 'platform' | 'mixed';
  transferReversalId?: string;
}

// ==================== VAT Calculation Types ====================

export interface VATCalculation {
  vatRate: number;
  vatAmount: number;
  total: number;
  reverseCharge: boolean;
  vatRegistrationNumber?: string;
}

export interface VATCalculationParams {
  amount: number;
  customerCountry: string;
  customerVATNumber: string | null;
  professionalCountry: string;
  customerType: 'individual' | 'business';
}

// ==================== Idempotency Key Generator ====================

export type IdempotencyOperation =
  | 'payment-intent'
  | 'capture'
  | 'transfer'
  | 'refund'
  | 'account-create'
  | 'onboarding-link'
  | 'extra-cost-payment-intent'
  | 'unit-underuse-refund'
  | 'dispute-resolution-refund';

export interface IdempotencyKeyParams {
  bookingId: string;
  operation: IdempotencyOperation;
  version?: string;
  timestamp?: number; // For refunds (partial refund support)
}

// ==================== Currency Types ====================

export type SupportedCurrency = 'EUR' | 'USD' | 'GBP' | 'CAD' | 'AUD';

export interface CurrencyConfig {
  code: SupportedCurrency;
  symbol: string;
  decimals: number;
  countries: string[];
}

// ==================== Webhook Event Types ====================

export interface StripeWebhookEvent {
  id: string;
  type: StripeWebhookEventType;
  data: {
    object: any;
  };
  created: number;
}

export type StripeWebhookEventType =
  | 'payment_intent.succeeded'
  | 'payment_intent.payment_failed'
  | 'payment_intent.canceled'
  | 'charge.captured'
  | 'charge.refunded'
  | 'transfer.created'
  | 'transfer.reversed'
  | 'transfer.failed'
  | 'account.updated'
  | 'payout.paid'
  | 'payout.failed';

// ==================== API Response Types ====================

export interface StripeAPIResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface OnboardingLinkResponse {
  url: string;
  expiresAt: number;
}

export interface DashboardLinkResponse {
  url: string;
}

// ==================== Balance Types ====================

export interface StripeBalance {
  available: BalanceAmount[];
  pending: BalanceAmount[];
  reserved: BalanceAmount[];
}

export interface BalanceAmount {
  amount: number;
  currency: string;
}

// ==================== Error Types ====================

export interface StripeErrorResponse {
  type: 'card_error' | 'invalid_request_error' | 'api_error' | 'authentication_error' | 'rate_limit_error';
  code?: string;
  message: string;
  param?: string;
  decline_code?: string;
}
