/**
 * Payment Utility Functions for Fixtract Platform
 * Version: 2.1
 */

import { SupportedCurrency, IdempotencyKeyParams } from '../Types/stripe';

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

// ==================== Currency Utilities ====================

/**
 * Convert amount to Stripe format (cents)
 * @param amount - Amount in major currency units (e.g., 100.50 EUR)
 * @returns Amount in cents (e.g., 10050)
 */
export function convertToStripeAmount(amount: number, currency: string = "EUR"): number {
  const currencyUpper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(currencyUpper)) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

export function computeGrossBookingAmount(
  booking: { quote?: { amount?: number }; selectedExtraOptions?: Array<{ bookedPrice?: number } | number> },
  commissionPercent: number
): number {
  const optionsTotal = Array.isArray(booking?.selectedExtraOptions)
    ? booking.selectedExtraOptions.reduce((sum: number, entry) => {
        const bookedPrice = (entry as { bookedPrice?: number })?.bookedPrice;
        return typeof bookedPrice === 'number' ? sum + bookedPrice : sum;
      }, 0)
    : 0;
  const commissionedOptions = +(optionsTotal * (1 + commissionPercent / 100)).toFixed(2);
  const quoteAmount = booking?.quote?.amount || 0;
  return +(quoteAmount * (1 + commissionPercent / 100) + commissionedOptions).toFixed(2);
}

/**
 * Convert amount from Stripe format (cents) to major units
 * @param amount - Amount in cents (e.g., 10050)
 * @returns Amount in major currency units (e.g., 100.50)
 */
export function convertFromStripeAmount(amount: number, currency: string): number {
  const currencyUpper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(currencyUpper)) {
    return amount;
  }
  return amount / 100;
}

/**
 * Validate if currency is supported
 * @param currency - Currency code to validate
 * @returns True if currency is supported
 */
export function validateCurrency(currency: string): currency is SupportedCurrency {
  const supportedCurrencies: SupportedCurrency[] = ['EUR', 'USD', 'GBP', 'CAD', 'AUD'];
  return supportedCurrencies.includes(currency as SupportedCurrency);
}

/**
 * Get currency symbol for display
 * @param currency - Currency code
 * @returns Currency symbol
 */
export function getCurrencySymbol(currency: string): string {
  const symbols: Record<string, string> = {
    EUR: '€',
    USD: '$',
    GBP: '£',
    CAD: 'CA$',
    AUD: 'AU$',
  };
  return symbols[currency] || currency;
}

/**
 * Format amount with currency symbol
 * @param amount - Amount to format
 * @param currency - Currency code
 * @returns Formatted string (e.g., "€100.50")
 */
export function formatCurrency(amount: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount);
}

/**
 * Get currency by country code
 * @param countryCode - ISO country code (e.g., 'BE', 'US')
 * @returns Currency code
 */
export function getCurrencyByCountry(countryCode: string): SupportedCurrency {
  const countryToCurrency: Record<string, SupportedCurrency> = {
    // Eurozone
    BE: 'EUR', NL: 'EUR', FR: 'EUR', DE: 'EUR', IT: 'EUR',
    ES: 'EUR', PT: 'EUR', IE: 'EUR', LU: 'EUR', AT: 'EUR',
    FI: 'EUR', GR: 'EUR', SI: 'EUR', CY: 'EUR', MT: 'EUR',
    SK: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', HR: 'EUR',

    // Other currencies
    US: 'USD',
    GB: 'GBP',
    CA: 'CAD',
    AU: 'AUD',
  };

  return countryToCurrency[countryCode] || 'EUR';
}

// ==================== Stripe Fee Calculation ====================

/**
 * Calculate estimated Stripe processing fee
 * Stripe EU: 1.5% + €0.25 for European cards
 * Stripe EU: 2.9% + €0.25 for non-European cards
 * We'll use average: 2.9% + €0.25 (conservative estimate)
 *
 * @param amount - Payment amount
 * @param currency - Currency code
 * @returns Estimated Stripe fee
 */
export function calculateStripeFee(amount: number, currency: string): number {
  const percentageFee = amount * 0.029; // 2.9%

  // Fixed fee varies by currency
  const fixedFees: Record<string, number> = {
    EUR: 0.25,
    USD: 0.30,
    GBP: 0.20,
    CAD: 0.30,
    AUD: 0.30,
  };

  const fixedFee = fixedFees[currency] || 0.25;

  return Math.round((percentageFee + fixedFee) * 100) / 100; // Round to 2 decimals
}

// ==================== Idempotency Key Generation ====================

/**
 * Generate idempotency key for Stripe operations
 * Format: {bookingId}:{operation}:{version}[:{timestamp}]
 *
 * @param params - Idempotency key parameters
 * @returns Idempotency key string
 */
export function generateIdempotencyKey(params: IdempotencyKeyParams): string {
  const { bookingId, operation, version = 'v1', timestamp } = params;

  let key = `${bookingId}:${operation}:${version}`;

  // Add timestamp for operations that may occur multiple times (like refunds)
  if (timestamp) {
    key += `:${timestamp}`;
  }

  // Ensure max length of 255 characters (Stripe limit)
  if (key.length > 255) {
    throw new Error('Idempotency key exceeds 255 character limit');
  }

  return key;
}

// ==================== Payment Amount Calculations ====================

/**
 * Calculate professional payout amount
 * @param totalAmount - Total payment amount
 * @param platformCommissionPercent - Platform commission percentage (0-100)
 * @returns Professional payout amount
 */
export function calculateProfessionalPayout(
  totalAmount: number,
  platformCommissionPercent: number = 0
): number {
  const safeCommissionPercent = Math.max(0, Math.min(100, platformCommissionPercent));
  const commission = roundToTwo((totalAmount * safeCommissionPercent) / 100);
  const payout = roundToTwo(totalAmount - commission);
  return Math.max(0, payout);
}

/**
 * Calculate platform commission
 * @param amount - Payment amount
 * @param commissionPercent - Commission percentage (0-100)
 * @returns Commission amount
 */
export function calculatePlatformCommission(
  amount: number,
  commissionPercent: number = 0
): number {
  const safeCommissionPercent = Math.max(0, Math.min(100, commissionPercent));
  return roundToTwo((amount * safeCommissionPercent) / 100);
}

// ==================== Currency Selection ====================

/**
 * Determine booking currency based on quote, professional, and customer
 * Priority: Quote currency > Professional currency > Customer country currency > Default EUR
 *
 * @param quoteCurrency - Currency specified in quote
 * @param professionalCurrency - Professional's default currency
 * @param customerCountry - Customer's country code
 * @returns Selected currency
 */
export function determineBookingCurrency(
  quoteCurrency?: string,
  professionalCurrency?: string,
  customerCountry?: string
): SupportedCurrency {
  // Priority 1: Quote currency (professional explicitly set it)
  if (quoteCurrency && validateCurrency(quoteCurrency)) {
    return quoteCurrency as SupportedCurrency;
  }

  // Priority 2: Professional's default currency
  if (professionalCurrency && validateCurrency(professionalCurrency)) {
    return professionalCurrency as SupportedCurrency;
  }

  // Priority 3: Customer's country currency
  if (customerCountry) {
    return getCurrencyByCountry(customerCountry);
  }

  // Default: EUR
  return 'EUR';
}

// ==================== Payment Validation ====================

/**
 * Validate payment amount
 * @param amount - Amount to validate
 * @param currency - Currency code
 * @returns Validation result
 */
export function validatePaymentAmount(amount: number, currency: string): {
  valid: boolean;
  error?: string;
} {
  if (!Number.isFinite(amount)) {
    return {
      valid: false,
      error: 'Invalid amount',
    };
  }

  // Minimum amounts per currency (Stripe minimums)
  const minimums: Record<string, number> = {
    EUR: 0.50,
    USD: 0.50,
    GBP: 0.30,
    CAD: 0.50,
    AUD: 0.50,
  };

  const minimum = minimums[currency] || 0.50;

  if (amount < minimum) {
    return {
      valid: false,
      error: `Amount must be at least ${formatCurrency(minimum, currency)}`,
    };
  }

  // Maximum amount (Stripe limit is typically €999,999.99)
  const maximum = 999999.99;
  if (amount > maximum) {
    return {
      valid: false,
      error: `Amount exceeds maximum of ${formatCurrency(maximum, currency)}`,
    };
  }

  return { valid: true };
}

// ==================== Metadata Builders ====================

/**
 * Build payment intent metadata
 * @param bookingId - Booking ID
 * @param bookingNumber - Booking number (e.g., BK-2024-001234)
 * @param customerId - Customer user ID
 * @param professionalId - Professional user ID
 * @param professionalStripeAccountId - Professional's Stripe account ID
 * @param environment - Current environment
 * @returns Payment intent metadata object
 */
export function buildPaymentMetadata(
  bookingId: string,
  bookingNumber: string,
  customerId: string,
  professionalId: string,
  professionalStripeAccountId: string,
  environment: 'production' | 'test' = process.env.NODE_ENV === 'production' ? 'production' : 'test'
): Record<string, string> {
  const computedEnv = environment;
  return {
    bookingId,
    bookingNumber,
    customerId,
    professionalId,
    professionalStripeAccountId,
    type: 'booking_payment',
    environment: computedEnv,
    version: 'v1',
  };
}

/**
 * Build transfer metadata
 * @param bookingId - Booking ID
 * @param bookingNumber - Booking number
 * @param payoutDate - Payout date (ISO string)
 * @param environment - Current environment
 * @returns Transfer metadata object
 */
export function buildTransferMetadata(
  bookingId: string,
  bookingNumber: string,
  payoutDate: string,
  environment: 'production' | 'test' = process.env.NODE_ENV === 'production' ? 'production' : 'test'
): Record<string, string> {
  const computedEnv = environment;
  return {
    bookingId,
    bookingNumber,
    type: 'booking_completion_payout',
    payoutDate,
    environment: computedEnv,
  };
}

// ==================== Export All ====================

export default {
  convertToStripeAmount,
  convertFromStripeAmount,
  validateCurrency,
  getCurrencySymbol,
  formatCurrency,
  getCurrencyByCountry,
  calculateStripeFee,
  generateIdempotencyKey,
  calculateProfessionalPayout,
  calculatePlatformCommission,
  determineBookingCurrency,
  validatePaymentAmount,
  buildPaymentMetadata,
  buildTransferMetadata,
};
