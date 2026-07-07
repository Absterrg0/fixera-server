import ServiceConfiguration, { IVatLogicCondition, IVatLogicRule } from "../models/serviceConfiguration";
import { validateVATNumberFormat } from "./vatValidation";

export type VatRoutingAction = "standard_rate" | "reduced_rate" | "rfq";

export interface VatDecision {
  action: VatRoutingAction;
  country: string;
  standardRate: number;
  appliedRate: number;
  reducedRate?: number;
  reverseCharge: boolean;
  explanation: string;
  matchedRuleText?: string;
  ruleGroup?: string;
}

export interface VatRateOption {
  rate: number;
  country: string;
  label: string;
  reverseCharge: boolean;
  source: "standard" | "reduced" | "b2b_exempt";
}

const COUNTRY_ALIASES: Record<string, string> = {
  AUSTRIA: "AT",
  BELGIUM: "BE",
  BULGARIA: "BG",
  CROATIA: "HR",
  CYPRUS: "CY",
  CZECHIA: "CZ",
  "CZECH REPUBLIC": "CZ",
  DENMARK: "DK",
  ESTONIA: "EE",
  FINLAND: "FI",
  FRANCE: "FR",
  MONACO: "MC",
  GERMANY: "DE",
  GREECE: "GR",
  HUNGARY: "HU",
  IRELAND: "IE",
  ITALY: "IT",
  LATVIA: "LV",
  LITHUANIA: "LT",
  LUXEMBOURG: "LU",
  MALTA: "MT",
  NETHERLANDS: "NL",
  "THE NETHERLANDS": "NL",
  HOLLAND: "NL",
  POLAND: "PL",
  PORTUGAL: "PT",
  ROMANIA: "RO",
  SLOVAKIA: "SK",
  SLOVENIA: "SI",
  SPAIN: "ES",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
  LIECHTENSTEIN: "LI",
  NORWAY: "NO",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  SCOTLAND: "GB",
  WALES: "GB",
  "UNITED STATES": "US",
  USA: "US",
  "UNITED STATES OF AMERICA": "US",
  CANADA: "CA",
  AUSTRALIA: "AU",
  "NEW ZEALAND": "NZ",
  INDIA: "IN",
  UKRAINE: "UA",
  MOLDOVA: "MD",
  ANDORRA: "AD",
  "SAN MARINO": "SM",
  TURKEY: "TR",
  TÜRKIYE: "TR",
  TURKIYE: "TR",
};

const STANDARD_RATES: Record<string, number> = {
  BE: 21, NL: 21, DE: 19, CH: 8.1, AT: 20, LI: 8.1, FR: 20, MC: 20, GB: 20,
  IE: 23, LT: 21, LV: 21, EE: 24, ES: 21, AD: 4.5, PT: 23, IT: 22, SM: 0,
  DK: 25, NO: 25, SE: 25, FI: 25.5, PL: 23, CZ: 21, UA: 20, RO: 21, MD: 20,
  SK: 23, HU: 27, SI: 22, HR: 25, GR: 24, CY: 19, BG: 20, TR: 20,
  US: 0, CA: 0, AU: 0, NZ: 0, IN: 0,
};

export const B2B_SAME_AS_B2C_COUNTRIES = new Set(["BE", "CH", "LI", "NO", "GR"]);
export const B2B_VAT_EXEMPTION_NOTE =
  'Intra-Community supply, VAT exempt under Article 39bis of the VAT Directive';

export const normalizeVatCountry = (country?: string | null): string => {
  if (country == null || String(country).trim() === "") return "BE";
  const raw = String(country).trim();
  const upper = raw.toUpperCase();
  if (upper === "EL") return "GR";
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (COUNTRY_ALIASES[upper]) return COUNTRY_ALIASES[upper];
  const normalizedName = upper.replace(/[.,']/g, "").replace(/\s+/g, " ");
  if (COUNTRY_ALIASES[normalizedName]) return COUNTRY_ALIASES[normalizedName];
  return "";
};

export const requiresVatRfqReview = (
  decision?: Pick<VatDecision, "action" | "reverseCharge"> | null
): boolean => decision?.action === "rfq" && !decision?.reverseCharge;

export const getStandardVatRate = (country?: string | null): number => {
  const normalized = normalizeVatCountry(country);
  if (!normalized) return 0;
  return STANDARD_RATES[normalized] ?? 0;
};

export const isB2BSameAsB2CCountry = (country?: string | null): boolean =>
  B2B_SAME_AS_B2C_COUNTRIES.has(normalizeVatCountry(country));

const coerceComparable = (value: unknown): string | number | boolean => {
  if (typeof value === "boolean" || typeof value === "number") return value;
  const raw = String(value ?? "").trim();
  if (/^(true|yes|y)$/i.test(raw)) return true;
  if (/^(false|no|n)$/i.test(raw)) return false;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && raw !== "" ? parsed : raw.toLowerCase();
};

const compare = (condition: IVatLogicCondition, answers: Record<string, unknown>): boolean => {
  const actual = coerceComparable(answers[condition.fieldName]);
  const expected = coerceComparable(condition.value);

  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "greater_than":
      return Number(actual) > Number(expected);
    case "greater_than_or_equal":
      return Number(actual) >= Number(expected);
    case "less_than":
      return Number(actual) < Number(expected);
    case "less_than_or_equal":
      return Number(actual) <= Number(expected);
    case "includes":
      return Array.isArray(answers[condition.fieldName])
        ? (answers[condition.fieldName] as unknown[]).map(coerceComparable).includes(expected)
        : String(actual).includes(String(expected));
    default:
      return false;
  }
};

export const evaluateVatRule = (rule: IVatLogicRule, answers: Record<string, unknown>): boolean => {
  if (!rule.conditions?.length) return true;
  return rule.conditions.reduce((result, condition, index) => {
    const conditionResult = compare(condition, answers);
    if (index === 0) return conditionResult;
    return condition.connector === "OR" ? result || conditionResult : result && conditionResult;
  }, true);
};

const hasVerifiedVatNumber = (vatNumber?: string | null, isVatVerified?: boolean): boolean =>
  Boolean(isVatVerified && vatNumber && validateVATNumberFormat(vatNumber));

export const applyB2BInvoiceRule = (
  decision: VatDecision,
  customerType?: string,
  vatNumber?: string | null,
  isVatVerified?: boolean
): VatDecision => {
  if (customerType !== "business") return decision;
  if (isB2BSameAsB2CCountry(decision.country)) return decision;
  if (!hasVerifiedVatNumber(vatNumber, isVatVerified)) return decision;

  return {
    ...decision,
    appliedRate: 0,
    reverseCharge: true,
    explanation: B2B_VAT_EXEMPTION_NOTE,
  };
};

const pushUniqueRate = (options: VatRateOption[], option: VatRateOption) => {
  if (!options.some((existing) => existing.rate === option.rate && existing.reverseCharge === option.reverseCharge)) {
    options.push(option);
  }
};

export const getVatRateOptionsFromConfig = async (params: {
  serviceConfigurationId?: string;
  category?: string;
  service?: string;
  areaOfWork?: string;
  country?: string;
  customerType?: string;
  vatNumber?: string | null;
  isVatVerified?: boolean;
  answers?: Record<string, unknown>;
}): Promise<VatRateOption[]> => {
  const country = normalizeVatCountry(params.country);
  const decision = await resolveVatDecisionFromConfig({
    serviceConfigurationId: params.serviceConfigurationId,
    category: params.category,
    service: params.service,
    areaOfWork: params.areaOfWork,
    country,
    answers: params.answers,
    customerType: params.customerType,
    vatNumber: params.vatNumber,
    isVatVerified: params.isVatVerified,
  });

  if (decision.reverseCharge && decision.appliedRate === 0) {
    return [{
      rate: 0,
      country,
      label: `0% VAT - ${B2B_VAT_EXEMPTION_NOTE}`,
      reverseCharge: true,
      source: "b2b_exempt",
    }];
  }

  const options: VatRateOption[] = [];
  pushUniqueRate(options, {
    rate: decision.standardRate,
    country,
    label: `${decision.standardRate}% standard VAT`,
    reverseCharge: false,
    source: "standard",
  });

  if (decision.action === "reduced_rate" && Number.isFinite(decision.reducedRate)) {
    pushUniqueRate(options, {
      rate: decision.reducedRate!,
      country,
      label: decision.matchedRuleText
        ? `${decision.reducedRate}% reduced VAT - ${decision.matchedRuleText}`
        : `${decision.reducedRate}% reduced VAT`,
      reverseCharge: false,
      source: "reduced",
    });
  }

  return options.sort((a, b) => a.rate - b.rate);
};

export const resolveVatDecisionFromConfig = async (params: {
  serviceConfigurationId?: string;
  category?: string;
  service?: string;
  areaOfWork?: string;
  country?: string;
  answers?: Record<string, unknown>;
  customerType?: string;
  vatNumber?: string | null;
  isVatVerified?: boolean;
}): Promise<VatDecision> => {
  const country = normalizeVatCountry(params.country);
  const fallbackRate = getStandardVatRate(country);
  if (!country) {
    return {
      action: "rfq",
      country,
      standardRate: 0,
      appliedRate: 0,
      reverseCharge: false,
      explanation: "Customer country could not be matched to a VAT jurisdiction. VAT review is required before checkout.",
    };
  }
  const fallback: VatDecision = {
    action: "standard_rate",
    country,
    standardRate: fallbackRate,
    appliedRate: fallbackRate,
    reverseCharge: false,
    explanation: `Standard VAT rate ${fallbackRate}% applied.`,
  };

  const query = params.serviceConfigurationId && /^[a-f\d]{24}$/i.test(params.serviceConfigurationId)
    ? { _id: params.serviceConfigurationId }
    : {
        ...(params.category ? { category: params.category } : {}),
        ...(params.service ? { service: params.service } : {}),
        ...(params.areaOfWork ? { areaOfWork: params.areaOfWork } : {}),
      };

  const config = Object.keys(query).length > 0
    ? await ServiceConfiguration.findOne(query).select("category service vatManagement")
    : null;

  if (config?.category === "Renovation" || params.category === "Renovation") {
    return applyB2BInvoiceRule({
      ...fallback,
      action: "rfq",
      explanation: "Renovation services require quotation-level VAT review.",
    }, params.customerType, params.vatNumber, params.isVatVerified);
  }

  if (!config?.vatManagement?.enabled) {
    return applyB2BInvoiceRule(fallback, params.customerType, params.vatNumber, params.isVatVerified);
  }

  const rules = [...(config.vatManagement.logicRules || [])]
    .filter(rule => rule.isActive !== false && normalizeVatCountry(rule.country) === country)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));

  for (const rule of rules) {
    if (!evaluateVatRule(rule, params.answers || {})) continue;
    const standardRate = Number.isFinite(rule.standardRate) ? rule.standardRate : fallbackRate;
    const reducedRate = Number.isFinite(rule.reducedRate) ? rule.reducedRate : standardRate;
    const next: VatDecision = {
      action: rule.action === "rfq" ? "rfq" : "reduced_rate",
      country,
      standardRate,
      reducedRate,
      appliedRate: rule.action === "rfq" ? standardRate : reducedRate,
      reverseCharge: false,
      explanation: rule.customText || (rule.action === "rfq"
        ? "Reduced VAT claim requires RFQ review."
        : `Reduced VAT rate ${reducedRate}% applied.`),
      matchedRuleText: rule.customText,
      ruleGroup: config.vatManagement.rateRuleGroup,
    };
    return applyB2BInvoiceRule(next, params.customerType, params.vatNumber, params.isVatVerified);
  }

  return applyB2BInvoiceRule({
    ...fallback,
    ruleGroup: config.vatManagement.rateRuleGroup,
  }, params.customerType, params.vatNumber, params.isVatVerified);
};
