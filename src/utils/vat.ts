/**
 * VAT Calculation Utilities for Fixera Platform
 * Based on EU VAT rules and Belgian regulations
 * Version: 2.1
 */

import { VATCalculation, VATCalculationParams } from '../Types/stripe';
import { EU_COUNTRIES } from './viesApi';
import {
  B2B_VAT_EXEMPTION_NOTE,
  getStandardVatRate,
  isB2BSameAsB2CCountry,
} from './vatManagement';

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
  return EU_COUNTRIES.includes(countryCode.toUpperCase());
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
 * Validate EU VAT number format (basic check)
 * Format: Country code + 8-12 digits
 * @param vatNumber - VAT number to validate
 * @returns True if format is valid
 */
export function validateVATNumberFormat(vatNumber: string | null): boolean {
  if (!vatNumber) return false;

  // Remove spaces and convert to uppercase
  const cleaned = vatNumber.replace(/\s/g, '').toUpperCase();

  const countryCode = cleaned.slice(0, 2);
  const perCountryPatterns: Record<string, RegExp> = {
    AT: /^ATU\d{8}$/,
    BE: /^BE0?\d{9}$/,
    BG: /^BG\d{9,10}$/,
    CY: /^CY\d{8}[A-Z]$/,
    CZ: /^CZ\d{8,10}$/,
    DE: /^DE\d{9}$/,
    DK: /^DK\d{8}$/,
    EE: /^EE\d{9}$/,
    EL: /^EL\d{9}$/,
    ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
    FI: /^FI\d{8}$/,
    FR: /^FR[A-Z0-9]{2}\d{9}$/,
    HR: /^HR\d{11}$/,
    HU: /^HU\d{8}$/,
    IE: /^IE\d[A-Z0-9][A-Z0-9\d]{5}[A-Z]{1,2}$/,
    IT: /^IT\d{11}$/,
    LT: /^LT(\d{9}|\d{12})$/,
    LU: /^LU\d{8}$/,
    LV: /^LV\d{11}$/,
    MT: /^MT\d{8}$/,
    NL: /^NL\d{9}B\d{2}$/,
    PL: /^PL\d{10}$/,
    PT: /^PT\d{9}$/,
    RO: /^RO\d{2,10}$/,
    SE: /^SE\d{10}01$/,
    SI: /^SI\d{8}$/,
    SK: /^SK\d{10}$/,
  };
  const fallbackPattern = /^[A-Z]{2}[A-Z0-9]{8,12}$/;
  const regex = perCountryPatterns[countryCode] || fallbackPattern;

  return regex.test(cleaned);
}

/**
 * Calculate VAT based on customer and professional locations
 *
 * VAT Rules (Fixera - Belgian company):
 * 1. Belgium B2C (no VAT number): 21% VAT
 * 2. Belgium B2B (with VAT number): 21% VAT
 * 3. EU (ex-BE) B2C (no VAT number): 21% Belgian VAT
 * 4. EU (ex-BE) B2B (with VAT number): 0% VAT (Reverse charge)
 * 5. Non-EU: 0% VAT
 *
 * @param params - VAT calculation parameters
 * @returns VAT calculation result
 */
export function calculateVAT(params: VATCalculationParams): VATCalculation {
  const {
    amount,
    customerCountry,
    customerVATNumber,
    customerType,
  } = params;

  const customerCountryUpper = customerCountry.toUpperCase();
  const roundAmount = (value: number): number => Math.round(value * 100) / 100;
  const localRate = getVATRate(customerCountryUpper);

  if (customerType === 'business' && !isB2BSameAsB2CCountry(customerCountryUpper)) {
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
    return `VAT (${calculation.vatRate}%) charged under Belgian VAT regulations.`;
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
