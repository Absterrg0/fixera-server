import ServiceConfiguration, { IVatLogicCondition, IVatLogicRule } from "../models/serviceConfiguration";

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
  BELGIUM: "BE",
  NETHERLANDS: "NL",
  GERMANY: "DE",
  FRANCE: "FR",
  MONACO: "MC",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  IRELAND: "IE",
  SPAIN: "ES",
  PORTUGAL: "PT",
  ITALY: "IT",
  POLAND: "PL",
  CZECHIA: "CZ",
  "CZECH REPUBLIC": "CZ",
  SLOVENIA: "SI",
  CYPRUS: "CY",
  SWITZERLAND: "CH",
  LIECHTENSTEIN: "LI",
  NORWAY: "NO",
  GREECE: "GR",
};

const STANDARD_RATES: Record<string, number> = {
  BE: 21, NL: 21, DE: 19, CH: 8.1, AT: 20, LI: 8.1, FR: 20, MC: 20, GB: 20,
  IE: 23, LT: 21, LV: 21, EE: 24, ES: 21, AD: 4.5, PT: 23, IT: 22, SM: 0,
  DK: 25, NO: 25, SE: 25, FI: 25.5, PL: 23, CZ: 21, UA: 20, RO: 21, MD: 20,
  SK: 23, HU: 27, SI: 22, HR: 25, GR: 24, CY: 19, BG: 20, TR: 20,
};

export const B2B_SAME_AS_B2C_COUNTRIES = new Set(["BE", "CH", "LI", "NO", "GR"]);
export const B2B_VAT_EXEMPTION_NOTE =
  'Intra-Community supply, VAT exempt under Article 39bis of the VAT Directive';

export const normalizeVatCountry = (country?: string | null): string => {
  const raw = String(country || "BE").trim();
  if (!raw) return "BE";
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return COUNTRY_ALIASES[upper] || upper.slice(0, 2);
};

export const getStandardVatRate = (country?: string | null): number => {
  const normalized = normalizeVatCountry(country);
  return STANDARD_RATES[normalized] ?? 21;
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

export const applyB2BInvoiceRule = (decision: VatDecision, customerType?: string): VatDecision => {
  if (customerType !== "business") return decision;
  if (isB2BSameAsB2CCountry(decision.country)) return decision;

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
  });

  if (params.customerType === "business" && !isB2BSameAsB2CCountry(country)) {
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
}): Promise<VatDecision> => {
  const country = normalizeVatCountry(params.country);
  const fallbackRate = getStandardVatRate(country);
  const fallback: VatDecision = {
    action: "standard_rate",
    country,
    standardRate: fallbackRate,
    appliedRate: fallbackRate,
    reverseCharge: false,
    explanation: `Standard VAT rate ${fallbackRate}% applied.`,
  };

  const query = params.serviceConfigurationId
    ? { _id: params.serviceConfigurationId }
    : {
        ...(params.category ? { category: params.category } : {}),
        ...(params.service ? { service: params.service } : {}),
        ...(params.areaOfWork ? { areaOfWork: params.areaOfWork } : {}),
      };

  const config = Object.keys(query).length > 0
    ? await ServiceConfiguration.findOne(query).select("category service vatManagement")
    : null;

  if (config?.category === "Renovation") {
    return applyB2BInvoiceRule({
      ...fallback,
      action: "rfq",
      explanation: "Renovation services require quotation-level VAT review.",
    }, params.customerType);
  }

  if (!config?.vatManagement?.enabled) {
    return applyB2BInvoiceRule(fallback, params.customerType);
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
    return applyB2BInvoiceRule(next, params.customerType);
  }

  return applyB2BInvoiceRule({
    ...fallback,
    ruleGroup: config.vatManagement.rateRuleGroup,
  }, params.customerType);
};
