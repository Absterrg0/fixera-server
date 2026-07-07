import { describe, expect, it } from "vitest";
import {
  applyB2BInvoiceRule,
  B2B_VAT_EXEMPTION_NOTE,
  evaluateVatRule,
  getStandardVatRate,
  isB2BSameAsB2CCountry,
  normalizeVatCountry,
  requiresVatRfqReview,
  type VatDecision,
} from "../vatManagement";
import type { IVatLogicRule } from "../../models/serviceConfiguration";

describe("normalizeVatCountry", () => {
  it("defaults to BE when empty", () => {
    expect(normalizeVatCountry(undefined)).toBe("BE");
    expect(normalizeVatCountry("")).toBe("BE");
    expect(normalizeVatCountry("   ")).toBe("BE");
  });

  it("passes through ISO-2 codes", () => {
    expect(normalizeVatCountry("nl")).toBe("NL");
    expect(normalizeVatCountry("DE")).toBe("DE");
  });

  it("maps EL (Greek VAT prefix) to GR", () => {
    expect(normalizeVatCountry("EL")).toBe("GR");
  });

  it("maps country names and aliases", () => {
    expect(normalizeVatCountry("Belgium")).toBe("BE");
    expect(normalizeVatCountry("The Netherlands")).toBe("NL");
    expect(normalizeVatCountry("holland")).toBe("NL");
    expect(normalizeVatCountry("United Kingdom")).toBe("GB");
    expect(normalizeVatCountry("Czech Republic")).toBe("CZ");
  });

  it("returns empty string for unknown countries", () => {
    expect(normalizeVatCountry("Atlantis")).toBe("");
  });
});

describe("getStandardVatRate", () => {
  it("returns configured standard rates", () => {
    expect(getStandardVatRate("BE")).toBe(21);
    expect(getStandardVatRate("Germany")).toBe(19);
    expect(getStandardVatRate("CH")).toBe(8.1);
    expect(getStandardVatRate("NO")).toBe(25);
    expect(getStandardVatRate("GR")).toBe(24);
  });

  it("returns 0 for non-VAT countries and unknowns", () => {
    expect(getStandardVatRate("US")).toBe(0);
    expect(getStandardVatRate("Atlantis")).toBe(0);
  });
});

describe("isB2BSameAsB2CCountry", () => {
  it("matches the five exception countries", () => {
    for (const country of ["BE", "CH", "LI", "NO", "GR"]) {
      expect(isB2BSameAsB2CCountry(country)).toBe(true);
    }
  });

  it("does not match other EU countries", () => {
    expect(isB2BSameAsB2CCountry("NL")).toBe(false);
    expect(isB2BSameAsB2CCountry("DE")).toBe(false);
  });
});

const makeRule = (overrides: Partial<IVatLogicRule> = {}): IVatLogicRule => ({
  country: "BE",
  standardRate: 21,
  reducedRate: 6,
  conditions: [],
  action: "reduced_rate",
  priority: 1,
  isActive: true,
  ...overrides,
});

describe("evaluateVatRule", () => {
  it("matches when there are no conditions", () => {
    expect(evaluateVatRule(makeRule(), {})).toBe(true);
  });

  it("evaluates equals with boolean coercion", () => {
    const rule = makeRule({
      conditions: [{ fieldName: "is_residence", operator: "equals", value: true }],
    });
    expect(evaluateVatRule(rule, { is_residence: true })).toBe(true);
    expect(evaluateVatRule(rule, { is_residence: "yes" })).toBe(true);
    expect(evaluateVatRule(rule, { is_residence: false })).toBe(false);
  });

  it("evaluates numeric comparisons", () => {
    const rule = makeRule({
      conditions: [{ fieldName: "building_age", operator: "greater_than_or_equal", value: 10 }],
    });
    expect(evaluateVatRule(rule, { building_age: 12 })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: "10" })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: 9 })).toBe(false);
  });

  it("combines conditions with AND", () => {
    const rule = makeRule({
      conditions: [
        { fieldName: "building_age", operator: "greater_than_or_equal", value: 10 },
        { fieldName: "is_residence", operator: "equals", value: true, connector: "AND" },
      ],
    });
    expect(evaluateVatRule(rule, { building_age: 15, is_residence: true })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: 15, is_residence: false })).toBe(false);
  });

  it("combines conditions with OR", () => {
    const rule = makeRule({
      conditions: [
        { fieldName: "building_age", operator: "greater_than_or_equal", value: 10 },
        { fieldName: "is_social_housing", operator: "equals", value: true, connector: "OR" },
      ],
    });
    expect(evaluateVatRule(rule, { building_age: 2, is_social_housing: true })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: 2, is_social_housing: false })).toBe(false);
  });

  it("evaluates includes against checkbox arrays", () => {
    const rule = makeRule({
      conditions: [{ fieldName: "work_types", operator: "includes", value: "insulation" }],
    });
    expect(evaluateVatRule(rule, { work_types: ["roofing", "insulation"] })).toBe(true);
    expect(evaluateVatRule(rule, { work_types: ["roofing"] })).toBe(false);
  });

  it("supports the remaining comparison operators and unknown fallback", () => {
    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "occupancy", operator: "not_equals", value: "commercial" }] }),
        { occupancy: "residential" }
      )
    ).toBe(true);

    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "building_age", operator: "less_than", value: 10 }] }),
        { building_age: 9 }
      )
    ).toBe(true);

    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "building_age", operator: "less_than_or_equal", value: 10 }] }),
        { building_age: 10 }
      )
    ).toBe(true);

    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "building_age", operator: "mystery" as any, value: 10 }] }),
        { building_age: 10 }
      )
    ).toBe(false);
  });
});

const makeDecision = (overrides: Partial<VatDecision> = {}): VatDecision => ({
  action: "standard_rate",
  country: "NL",
  standardRate: 21,
  appliedRate: 21,
  reverseCharge: false,
  explanation: "Standard VAT rate 21% applied.",
  ...overrides,
});

describe("applyB2BInvoiceRule", () => {
  it("keeps decision untouched for individuals", () => {
    const decision = makeDecision();
    expect(applyB2BInvoiceRule(decision, "individual", "NL123456789B01", true)).toEqual(decision);
  });

  it("applies 0% reverse charge for verified EU B2B outside exception countries", () => {
    const result = applyB2BInvoiceRule(makeDecision(), "business", "NL123456789B01", true);
    expect(result.appliedRate).toBe(0);
    expect(result.reverseCharge).toBe(true);
    expect(result.explanation).toBe(B2B_VAT_EXEMPTION_NOTE);
  });

  it("does not exempt B2B in the five exception countries", () => {
    for (const country of ["BE", "CH", "LI", "NO", "GR"]) {
      const decision = makeDecision({ country });
      const result = applyB2BInvoiceRule(decision, "business", "BE0123456789", true);
      expect(result.reverseCharge).toBe(false);
      expect(result.appliedRate).toBe(decision.appliedRate);
    }
  });

  it("requires a verified VAT number for the exemption", () => {
    const unverified = applyB2BInvoiceRule(makeDecision(), "business", "NL123456789B01", false);
    expect(unverified.reverseCharge).toBe(false);

    const missing = applyB2BInvoiceRule(makeDecision(), "business", null, true);
    expect(missing.reverseCharge).toBe(false);
  });
});

describe("requiresVatRfqReview", () => {
  it("requires review for rfq decisions without reverse charge", () => {
    expect(requiresVatRfqReview({ action: "rfq", reverseCharge: false })).toBe(true);
  });

  it("does not require review when reverse charge applies", () => {
    expect(requiresVatRfqReview({ action: "rfq", reverseCharge: true })).toBe(false);
  });

  it("does not require review for standard or reduced rates", () => {
    expect(requiresVatRfqReview({ action: "standard_rate", reverseCharge: false })).toBe(false);
    expect(requiresVatRfqReview({ action: "reduced_rate", reverseCharge: false })).toBe(false);
    expect(requiresVatRfqReview(null)).toBe(false);
  });
});
