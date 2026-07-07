export function validateVATNumberFormat(vatNumber: string | null): boolean {
  if (!vatNumber) return false;

  const cleaned = vatNumber.replace(/\s/g, "").toUpperCase();
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

  return (perCountryPatterns[countryCode] || fallbackPattern).test(cleaned);
}
