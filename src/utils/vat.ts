/**
 * VAT Calculation Utilities for Fixtract Platform
 * Based on EU VAT rules and Belgian regulations
 * Version: 2.1
 */

import { VATCalculation, VATCalculationParams } from '../Types/stripe';
import { EU_COUNTRIES } from './viesApi';
import {
  B2B_VAT_EXEMPTION_NOTE,
  getStandardVatRate,
  isB2BSameAsB2CCountry,
  normalizeVatCountry,
} from './vatManagement';
import { validateVATNumberFormat } from './vatValidation';

// VAT rates by country (standard rates)
const VAT_RATES: Record<string, number> = {
  BE: 21, // Belgium
  NL: 21, // Netherlands
  FR: 20, // France
  DE: 19, // Germany
  IT: 22, // Italy
  ES: 21, // Spain
  PT: 23, // Portugal
  // Add more as needed
};

/**
 * Check if country is in EU
 * @param countryCode - ISO 2-letter country code
 * @returns True if country is in EU
 */
export function isEUCountry(countryCode: string): boolean {
  if (!countryCode || !String(countryCode).trim()) {
    return false;
  }
  const normalized = normalizeVatCountry(countryCode);
  return normalized ? EU_COUNTRIES.includes(normalized) : false;
}

/**
 * Get VAT rate for a country
 * @param countryCode - ISO 2-letter country code
 * @returns VAT rate as percentage (e.g., 21 for 21%)
 */
export function getVATRate(countryCode: string): number {
  return VAT_RATES[countryCode.toUpperCase()] || getStandardVatRate(countryCode);
}

/**
 * Calculate VAT based on customer and professional locations
 *
 * VAT Rules (Fixtract - Belgian company):
 * 1. Belgium B2C (no VAT number): 21% VAT
 * 2. Belgium B2B (with VAT number): 21% VAT
 * 3. EU (ex-BE) B2C (no VAT number): 21% Belgian VAT
 * 4. EU (ex-BE) B2B (with VAT number): 0% VAT (Reverse charge)
 * 5. Non-EU: 0% VAT
 *
 * IMPORTANT: callers must only pass `customerVATNumber` when the number has
 * been VIES-verified (i.e. `customer.isVatVerified === true`). Passing an
 * unverified number would incorrectly grant the reverse-charge exemption.
 *
 * @param params - VAT calculation parameters
 * @returns VAT calculation result
 */
export function calculateVAT(params: VATCalculationParams): VATCalculation {
  const {
    amount,
    customerCountry,
    customerVATNumber,
    customerVatVerified,
    customerType,
  } = params;

  const customerCountryUpper = normalizeVatCountry(customerCountry);
  const roundAmount = (value: number): number => Math.round(value * 100) / 100;
  const localRate = getVATRate(customerCountryUpper);

  if (
    customerType === 'business' &&
    !isB2BSameAsB2CCountry(customerCountryUpper) &&
    customerVatVerified === true &&
    customerVATNumber &&
    validateVATNumberFormat(customerVATNumber)
  ) {
    return {
      vatRate: 0,
      vatAmount: 0,
      total: roundAmount(amount),
      reverseCharge: true,
      vatRegistrationNumber: customerVATNumber || undefined,
    };
  }

  const vatRate = localRate;
  const vatAmountRaw = (amount * vatRate) / 100;
  const vatAmount = roundAmount(vatAmountRaw);
  const total = roundAmount(amount + vatAmount);
  return {
    vatRate,
    vatAmount,
    total,
    reverseCharge: false,
    vatRegistrationNumber: customerType === 'business' ? customerVATNumber || undefined : undefined,
  };
}

/**
 * Get VAT explanation text for invoice
 * @param calculation - VAT calculation result
 * @param customerCountry - Customer country code
 * @returns Explanation text for invoice
 */
export function getVATExplanation(
  calculation: VATCalculation,
  customerCountry: string
): string {
  if (calculation.reverseCharge) {
    return B2B_VAT_EXEMPTION_NOTE;
  }

  if (calculation.vatRate === 0 && !isEUCountry(customerCountry)) {
    return 'No VAT charged for non-EU customers.';
  }

  if (calculation.vatRate > 0) {
    const normalizedCountry = normalizeVatCountry(customerCountry);
    return normalizedCountry
      ? `VAT (${calculation.vatRate}%) charged using the ${normalizedCountry} rate.`
      : `VAT (${calculation.vatRate}%) charged using the applicable local rate.`;
  }

  return '';
}

/**
 * Calculate VAT breakdown for display
 * @param netAmount - Amount before VAT
 * @param params - VAT calculation parameters
 * @returns Object with net, VAT, and total
 */
export function getVATBreakdown(
  netAmount: number,
  params: VATCalculationParams
): {
  netAmount: number;
  vatAmount: number;
  vatRate: number;
  totalAmount: number;
  reverseCharge: boolean;
  explanation: string;
} {
  const calculation = calculateVAT({ ...params, amount: netAmount });
  const explanation = getVATExplanation(calculation, params.customerCountry);

  return {
    netAmount,
    vatAmount: calculation.vatAmount,
    vatRate: calculation.vatRate,
    totalAmount: calculation.total,
    reverseCharge: calculation.reverseCharge,
    explanation,
  };
}

// ==================== Export ====================

export default {
  isEUCountry,
  getVATRate,
  validateVATNumberFormat,
  calculateVAT,
  getVATExplanation,
  getVATBreakdown,
};
