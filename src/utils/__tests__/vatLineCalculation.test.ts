import { describe, expect, it } from "vitest";
import { calculateVatFromPricingLines } from "../vatLineCalculation";

describe("calculateVatFromPricingLines", () => {
  it("returns null when there are no valid lines", () => {
    expect(calculateVatFromPricingLines([])).toBeNull();
    expect(calculateVatFromPricingLines([{ price: 0, vatRate: 21 }])).toBeNull();
    expect(calculateVatFromPricingLines([{ price: NaN, vatRate: 21 }])).toBeNull();
  });

  it("calculates a single line", () => {
    const result = calculateVatFromPricingLines([
      { description: "Roof insulation", price: 1000, vatRate: 21 },
    ]);
    expect(result).not.toBeNull();
    expect(result!.netAmount).toBe(1000);
    expect(result!.vatAmount).toBe(210);
    expect(result!.total).toBe(1210);
    expect(result!.reverseCharge).toBe(false);
  });

  it("calculates mixed-rate lines and preserves per-line breakdown", () => {
    const result = calculateVatFromPricingLines([
      { description: "Renovation work", price: 1000, vatRate: 6 },
      { description: "New materials", price: 500, vatRate: 21 },
    ]);
    expect(result!.netAmount).toBe(1500);
    expect(result!.vatAmount).toBe(60 + 105);
    expect(result!.total).toBe(1665);
    expect(result!.vatBreakdown).toHaveLength(2);
    expect(result!.vatBreakdown[0].vatRate).toBe(6);
    expect(result!.vatBreakdown[1].vatRate).toBe(21);
  });

  it("prorates discounts across lines and keeps totals consistent", () => {
    const result = calculateVatFromPricingLines(
      [
        { description: "A", price: 600, vatRate: 21 },
        { description: "B", price: 400, vatRate: 6 },
      ],
      900 // 10% discount applied upstream
    );
    expect(result!.netAmount).toBe(900);
    const allocatedNet = result!.vatBreakdown.reduce((sum, line) => sum + line.netAmount, 0);
    expect(Math.round(allocatedNet * 100) / 100).toBe(900);
    // 540 * 21% + 360 * 6% = 113.4 + 21.6 = 135
    expect(result!.vatAmount).toBe(135);
    expect(result!.total).toBe(1035);
  });

  it("flags reverse charge when every line is 0%", () => {
    const result = calculateVatFromPricingLines([
      { description: "B2B export", price: 250, vatRate: 0 },
    ]);
    expect(result!.reverseCharge).toBe(true);
    expect(result!.vatAmount).toBe(0);
    expect(result!.total).toBe(250);
  });

  it("does not flag reverse charge for mixed 0% and positive rates", () => {
    const result = calculateVatFromPricingLines([
      { description: "Exempt part", price: 100, vatRate: 0 },
      { description: "Taxed part", price: 100, vatRate: 21 },
    ]);
    expect(result!.reverseCharge).toBe(false);
  });
});
