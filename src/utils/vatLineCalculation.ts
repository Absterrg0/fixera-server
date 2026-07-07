export interface VatPricingLineInput {
  description?: string;
  price: number;
  vatRate: number;
  vatCountry?: string;
  vatLabel?: string;
}

export interface VatLineBreakdown {
  description: string;
  netAmount: number;
  vatRate: number;
  vatAmount: number;
  totalAmount: number;
  vatCountry?: string;
  vatLabel?: string;
}

export interface VatLineCalculation {
  netAmount: number;
  vatAmount: number;
  total: number;
  vatRate: number;
  reverseCharge: boolean;
  vatBreakdown: VatLineBreakdown[];
}

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export const calculateVatFromPricingLines = (
  lines: VatPricingLineInput[],
  discountedNetAmount?: number
): VatLineCalculation | null => {
  const validLines = lines.filter((line) =>
    Number.isFinite(Number(line.price)) &&
    Number(line.price) > 0 &&
    Number.isFinite(Number(line.vatRate)) &&
    Number(line.vatRate) >= 0 &&
    Number(line.vatRate) <= 100
  );

  if (validLines.length === 0) return null;

  const originalNet = roundMoney(validLines.reduce((sum, line) => sum + Number(line.price), 0));
  if (!(originalNet > 0)) return null;

  const targetNet = Number.isFinite(discountedNetAmount) && Number(discountedNetAmount) > 0
    ? roundMoney(Number(discountedNetAmount))
    : originalNet;
  if (targetNet > originalNet) return null;
  const ratio = targetNet / originalNet;

  let allocatedNet = 0;
  const vatBreakdown = validLines.map((line, index) => {
    const isLast = index === validLines.length - 1;
    const remainingNet = roundMoney(targetNet - allocatedNet);
    const netAmount = isLast
      ? Math.max(0, remainingNet)
      : Math.max(0, Math.min(remainingNet, roundMoney(Number(line.price) * ratio)));
    allocatedNet = roundMoney(allocatedNet + netAmount);

    const vatRate = Number(line.vatRate);
    const vatAmount = roundMoney((netAmount * vatRate) / 100);
    return {
      description: String(line.description || `Line ${index + 1}`),
      netAmount,
      vatRate,
      vatAmount,
      totalAmount: roundMoney(netAmount + vatAmount),
      vatCountry: line.vatCountry,
      vatLabel: line.vatLabel,
    };
  });

  const vatAmount = roundMoney(vatBreakdown.reduce((sum, line) => sum + line.vatAmount, 0));
  const effectiveVatRate = targetNet > 0 ? Math.round((vatAmount / targetNet) * 100000) / 1000 : 0;

  return {
    netAmount: targetNet,
    vatAmount,
    total: roundMoney(targetNet + vatAmount),
    vatRate: effectiveVatRate,
    reverseCharge: vatBreakdown.every((line) => line.vatRate === 0),
    vatBreakdown,
  };
};
