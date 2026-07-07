import mongoose from "mongoose";
import Booking from "../models/booking";
import Payment from "../models/payment";
import { uploadBufferToS3 } from "../utils/s3Upload";
import { normalizeVatCountry, B2B_VAT_EXEMPTION_NOTE } from "../utils/vatManagement";
import { generateBookingInvoice } from "./invoiceGenerator";
import { maybeDispatchPeppolInvoice } from "./peppolDispatch";

export const SELF_BILLING_NOTE = "Prepared and sent on behalf of the supplier.";

type InvoiceArtifactResult = {
  invoiceNumber: string;
  invoiceUrl: string;
  invoiceUblUrl?: string;
  invoiceGeneratedAt: Date;
  peppolDispatchStatus?: string;
  peppolDispatchReference?: string;
};

type CreditArtifactResult = {
  creditNoteNumber: string;
  creditNoteUrl: string;
  creditNoteUblUrl?: string;
  creditNoteGeneratedAt: Date;
  relatedInvoiceNumber?: string;
};

const escapeXml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const hasInvoiceArtifacts = (payment: any) =>
  Boolean(payment?.invoiceNumber && payment?.invoiceUrl && !String(payment.invoiceNumber).startsWith("GENERATING-"));

const hasCreditNoteArtifacts = (payment: any) =>
  Boolean(payment?.creditNoteNumber && payment?.creditNoteUrl && !String(payment.creditNoteNumber).startsWith("GENERATING-CN-"));

const toInvoiceArtifactResult = (payment: any): InvoiceArtifactResult => ({
  invoiceNumber: payment.invoiceNumber,
  invoiceUrl: payment.invoiceUrl,
  invoiceUblUrl: payment.invoiceUblUrl,
  invoiceGeneratedAt: payment.invoiceGeneratedAt || new Date(),
  peppolDispatchStatus: payment.peppolDispatchStatus,
  peppolDispatchReference: payment.peppolDispatchReference,
});

const toCreditArtifactResult = (payment: any): CreditArtifactResult => ({
  creditNoteNumber: payment.creditNoteNumber,
  creditNoteUrl: payment.creditNoteUrl,
  creditNoteUblUrl: payment.creditNoteUblUrl,
  creditNoteGeneratedAt: payment.creditNoteGeneratedAt || new Date(),
  relatedInvoiceNumber: payment.invoiceNumber,
});

const claimInvoiceGeneration = async (bookingId: string) =>
  Booking.findOneAndUpdate(
    {
      _id: bookingId,
      $and: [
        {
          $or: [
            { "payment.invoiceNumber": { $exists: false } },
            { "payment.invoiceNumber": null },
            { "payment.invoiceNumber": "" },
          ],
        },
        {
          $or: [
            { "payment.invoiceUrl": { $exists: false } },
            { "payment.invoiceUrl": null },
            { "payment.invoiceUrl": "" },
          ],
        },
      ],
    },
    { $set: { "payment.invoiceNumber": `GENERATING-${Date.now()}` } },
    { new: true }
  );

const claimCreditNoteGeneration = async (bookingId: string) =>
  Booking.findOneAndUpdate(
    {
      _id: bookingId,
      "payment.invoiceNumber": { $exists: true, $nin: [null, ""] },
      $and: [
        {
          $or: [
            { "payment.creditNoteNumber": { $exists: false } },
            { "payment.creditNoteNumber": null },
            { "payment.creditNoteNumber": "" },
          ],
        },
        {
          $or: [
            { "payment.creditNoteUrl": { $exists: false } },
            { "payment.creditNoteUrl": null },
            { "payment.creditNoteUrl": "" },
          ],
        },
      ],
    },
    { $set: { "payment.creditNoteNumber": `GENERATING-CN-${Date.now()}` } },
    { new: true }
  );

const clearInvoiceGenerationClaim = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.invoiceNumber": /^GENERATING-/ },
    { $unset: { "payment.invoiceNumber": "" } }
  );
};

const clearCreditNoteGenerationClaim = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.creditNoteNumber": /^GENERATING-CN-/ },
    { $unset: { "payment.creditNoteNumber": "" } }
  );
};

const GENERATION_CLAIM_TTL_MS = 15 * 60 * 1000;

const parseGenerationClaimTimestamp = (value: string, prefix: string): number | null => {
  if (!value.startsWith(prefix)) return null;
  const timestamp = Number(value.slice(prefix.length));
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isStaleGenerationClaim = (value?: string | null, prefix = "GENERATING-"): boolean => {
  if (!value?.startsWith(prefix)) return false;
  const timestamp = parseGenerationClaimTimestamp(value, prefix);
  if (timestamp == null) return true;
  return Date.now() - timestamp > GENERATION_CLAIM_TTL_MS;
};

const clearStaleGenerationClaimsIfNeeded = async (bookingId: string) => {
  const booking = await Booking.findById(bookingId).select("payment.invoiceNumber payment.creditNoteNumber");
  if (isStaleGenerationClaim(booking?.payment?.invoiceNumber, "GENERATING-")) {
    await clearInvoiceGenerationClaim(bookingId);
  }
  if (isStaleGenerationClaim(booking?.payment?.creditNoteNumber, "GENERATING-CN-")) {
    await clearCreditNoteGenerationClaim(bookingId);
  }
};

const persistPaymentArtifactUpdate = async (
  bookingId: mongoose.Types.ObjectId | string,
  paymentId: string | undefined,
  update: Record<string, unknown>
) => {
  if (paymentId && mongoose.Types.ObjectId.isValid(paymentId)) {
    await Payment.findByIdAndUpdate(paymentId, { $set: update });
    return;
  }
  await Payment.findOneAndUpdate({ booking: bookingId }, { $set: update });
};

const toMoney = (value: unknown): string => {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toFixed(2);
};

const getCurrentQuote = (booking: any) => {
  const versions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  return versions.find((quote: any) => quote.version === booking.currentQuoteVersion) || versions[versions.length - 1];
};

const buildUblAddress = (parts: {
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}): string => {
  const countryCode = normalizeVatCountry(parts.country) || "BE";
  return `
      <cac:PostalAddress>
        ${parts.street ? `<cbc:StreetName>${escapeXml(parts.street)}</cbc:StreetName>` : ""}
        ${parts.city ? `<cbc:CityName>${escapeXml(parts.city)}</cbc:CityName>` : ""}
        ${parts.postalCode ? `<cbc:PostalZone>${escapeXml(parts.postalCode)}</cbc:PostalZone>` : ""}
        <cac:Country><cbc:IdentificationCode>${escapeXml(countryCode)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>`;
};

const getPricingLinesForUbl = (booking: any) => {
  const currentQuote = getCurrentQuote(booking);
  if (Array.isArray(booking.payment?.vatBreakdown) && booking.payment.vatBreakdown.length > 0) {
    return booking.payment.vatBreakdown.map((line: any) => ({
      description: line.description,
      price: line.netAmount,
      vatRate: line.vatRate,
      vatAmount: line.vatAmount,
    }));
  }
  if (Array.isArray(currentQuote?.pricingLines) && currentQuote.pricingLines.length > 0) {
    return currentQuote.pricingLines;
  }
  return [{
    description: booking.quote?.description || booking.rfqData?.description || "Service",
    price: booking.payment?.netAmount ?? booking.payment?.amount ?? 0,
    vatRate: booking.payment?.vatRate ?? 0,
    vatAmount: booking.payment?.vatAmount ?? 0,
  }];
};

const buildUblPartiesAndTotals = (
  booking: any,
  currency: string,
  sign: number,
  pricingLines: any[],
  reverseCharge: boolean
) => {
  const customer = booking.customer || {};
  const professional = booking.professional || {};
  const taxCategoryId = reverseCharge ? "AE" : "S";
  const taxCategoryExtras = reverseCharge
    ? `<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>
        <cbc:TaxExemptionReason>${escapeXml(B2B_VAT_EXEMPTION_NOTE)}</cbc:TaxExemptionReason>`
    : "";
  const taxSubtotals = pricingLines.map((line: any) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price || 0) * sign)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.vatAmount ?? (Number(line.price || 0) * Number(line.vatRate || 0)) / 100) * sign)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${taxCategoryId}</cbc:ID>
        <cbc:Percent>${toMoney(line.vatRate ?? booking.payment?.vatRate ?? 0)}</cbc:Percent>
        ${taxCategoryExtras}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`).join("");

  return {
    supplierParty: `<cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${escapeXml(professional.businessInfo?.companyName || professional.name || "Supplier")}</cbc:Name></cac:PartyName>${buildUblAddress({
        street: professional.businessInfo?.address,
        city: professional.businessInfo?.city,
        postalCode: professional.businessInfo?.postalCode,
        country: professional.businessInfo?.country,
      })}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(professional.vatNumber || professional.businessInfo?.vatNumber || "")}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(professional.businessInfo?.companyName || professional.name || "Supplier")}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>`,
    customerParty: `<cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${escapeXml(customer.businessName || customer.name || "Customer")}</cbc:Name></cac:PartyName>${buildUblAddress({
        street: customer.companyAddress?.address || customer.location?.address,
        city: customer.companyAddress?.city || customer.location?.city,
        postalCode: customer.companyAddress?.postalCode || customer.location?.postalCode,
        country: customer.companyAddress?.country || customer.location?.country,
      })}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(customer.vatNumber || "")}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(customer.businessName || customer.name || "Customer")}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`,
    taxTotal: `<cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.vatAmount || 0) * sign)}</cbc:TaxAmount>
    ${taxSubtotals}
  </cac:TaxTotal>`,
    monetaryTotal: `<cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.totalWithVat) * sign)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.totalWithVat) * sign)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`,
    taxCategoryId,
  };
};

const buildUblCreditNoteXml = (
  booking: any,
  creditNoteNumber: string,
  issuedAt: Date,
  options?: { relatedInvoiceNumber?: string }
): string => {
  const currency = booking.payment?.currency || "EUR";
  const sign = -1;
  const reverseCharge = Boolean(booking.payment?.reverseCharge);
  const pricingLines = getPricingLinesForUbl(booking);
  const parties = buildUblPartiesAndTotals(booking, currency, sign, pricingLines, reverseCharge);
  const creditNoteLines = pricingLines.map((line: any, index: number) => `
    <cac:CreditNoteLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${parties.taxCategoryId}</cbc:ID>
          <cbc:Percent>${toMoney(line.vatRate ?? booking.payment?.vatRate ?? 0)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:PriceAmount>
      </cac:Price>
    </cac:CreditNoteLine>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:selfbilling:01:1.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:selfbilling:01:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(creditNoteNumber)}</cbc:ID>
  <cbc:IssueDate>${issuedAt.toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>261</cbc:CreditNoteTypeCode>
  <cbc:Note>${escapeXml(SELF_BILLING_NOTE)}</cbc:Note>
  ${reverseCharge ? `<cbc:Note>${escapeXml(B2B_VAT_EXEMPTION_NOTE)}</cbc:Note>` : ""}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(booking.bookingNumber || booking._id?.toString?.())}</cbc:BuyerReference>
  ${options?.relatedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(options.relatedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  ${parties.supplierParty}
  ${parties.customerParty}
  ${parties.taxTotal}
  ${parties.monetaryTotal}${creditNoteLines}
</CreditNote>`;
};

const buildUblInvoiceXml = (
  booking: any,
  invoiceNumber: string,
  issuedAt: Date,
  options?: { creditNote?: boolean; relatedInvoiceNumber?: string }
): string => {
  if (options?.creditNote) {
    return buildUblCreditNoteXml(booking, invoiceNumber, issuedAt, {
      relatedInvoiceNumber: options.relatedInvoiceNumber,
    });
  }

  const currency = booking.payment?.currency || "EUR";
  const sign = 1;
  const reverseCharge = Boolean(booking.payment?.reverseCharge);
  const invoiceTypeCode = "389";
  const pricingLines = getPricingLinesForUbl(booking);
  const parties = buildUblPartiesAndTotals(booking, currency, sign, pricingLines, reverseCharge);
  const invoiceLines = pricingLines.map((line: any, index: number) => `
    <cac:InvoiceLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${parties.taxCategoryId}</cbc:ID>
          <cbc:Percent>${toMoney(line.vatRate ?? booking.payment?.vatRate ?? 0)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${issuedAt.toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:Note>${escapeXml(SELF_BILLING_NOTE)}</cbc:Note>
  ${reverseCharge ? `<cbc:Note>${escapeXml(B2B_VAT_EXEMPTION_NOTE)}</cbc:Note>` : ""}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(booking.bookingNumber || booking._id?.toString?.())}</cbc:BuyerReference>
  ${options?.relatedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(options.relatedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  ${parties.supplierParty}
  ${parties.customerParty}
  ${parties.taxTotal}
  ${parties.monetaryTotal}${invoiceLines}
</Invoice>`;
};

const loadBookingForInvoice = async (bookingId: string) =>
  Booking.findById(bookingId)
    .populate("customer")
    .populate("professional")
    .populate("project", "title extraOptions subprojects");

export async function ensureBookingInvoiceArtifacts(
  bookingId: string,
  paymentId?: string
): Promise<InvoiceArtifactResult | null> {
  await clearStaleGenerationClaimsIfNeeded(bookingId);
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment) return null;
  if (hasInvoiceArtifacts(existing.payment)) {
    return toInvoiceArtifactResult(existing.payment);
  }

  const claimed = await claimInvoiceGeneration(bookingId);
  if (!claimed) {
    const refreshed = await Booking.findById(bookingId);
    if (refreshed?.payment && hasInvoiceArtifacts(refreshed.payment)) {
      return toInvoiceArtifactResult(refreshed.payment);
    }
    return null;
  }

  try {
    const booking = await loadBookingForInvoice(bookingId);
    if (!booking?.payment) {
      await clearInvoiceGenerationClaim(bookingId);
      return null;
    }

    const { invoiceNumber, pdfBuffer } = await generateBookingInvoice(booking as any);
    const generatedAt = new Date();
    const keyBase = `invoices/${booking._id.toString()}/${invoiceNumber}`;
    const invoiceUrl = await uploadBufferToS3(
      pdfBuffer,
      `${keyBase}.pdf`,
      "application/pdf",
      `inline; filename="${invoiceNumber}.pdf"`
    );
    const ublXml = buildUblInvoiceXml(booking, invoiceNumber, generatedAt);
    const invoiceUblUrl = await uploadBufferToS3(
      Buffer.from(ublXml, "utf8"),
      `${keyBase}.xml`,
      "application/xml",
      `attachment; filename="${invoiceNumber}.xml"`
    );

    const peppolResult = await maybeDispatchPeppolInvoice({
      booking,
      invoiceNumber,
      ublXml,
      invoiceUblUrl,
    });

    const update = {
      invoiceNumber,
      invoiceUrl,
      invoiceUblUrl,
      invoiceGeneratedAt: generatedAt,
      peppolDispatchStatus: peppolResult.status,
      peppolDispatchReference: peppolResult.reference,
      peppolDispatchedAt: peppolResult.dispatchedAt,
    };

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.invoiceNumber": update.invoiceNumber,
          "payment.invoiceUrl": update.invoiceUrl,
          "payment.invoiceUblUrl": update.invoiceUblUrl,
          "payment.invoiceGeneratedAt": update.invoiceGeneratedAt,
          "payment.peppolDispatchStatus": update.peppolDispatchStatus,
          "payment.peppolDispatchReference": update.peppolDispatchReference,
          "payment.peppolDispatchedAt": update.peppolDispatchedAt,
        },
      }
    );

    await persistPaymentArtifactUpdate(booking._id, paymentId, update);

    return update;
  } catch (error) {
    await clearInvoiceGenerationClaim(bookingId);
    throw error;
  }
}

export async function ensureCreditInvoiceArtifacts(
  bookingId: string,
  paymentId?: string
): Promise<CreditArtifactResult | null> {
  await clearStaleGenerationClaimsIfNeeded(bookingId);
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment?.invoiceNumber) {
    return null;
  }
  if (hasCreditNoteArtifacts(existing.payment)) {
    return toCreditArtifactResult(existing.payment);
  }

  const claimed = await claimCreditNoteGeneration(bookingId);
  if (!claimed) {
    const refreshed = await Booking.findById(bookingId);
    if (refreshed?.payment && hasCreditNoteArtifacts(refreshed.payment)) {
      return toCreditArtifactResult(refreshed.payment);
    }
    return null;
  }

  try {
    const booking = await loadBookingForInvoice(bookingId);
    if (!booking?.payment?.invoiceNumber) {
      await clearCreditNoteGenerationClaim(bookingId);
      return null;
    }

    const relatedInvoiceNumber = booking.payment.invoiceNumber;
    const { invoiceNumber: creditNoteNumber, pdfBuffer } = await generateBookingInvoice(booking as any, {
      creditNote: true,
      relatedInvoiceNumber,
    });
    const generatedAt = new Date();
    const keyBase = `invoices/${booking._id.toString()}/${creditNoteNumber}`;
    const creditNoteUrl = await uploadBufferToS3(
      pdfBuffer,
      `${keyBase}.pdf`,
      "application/pdf",
      `inline; filename="${creditNoteNumber}.pdf"`
    );
    const ublXml = buildUblInvoiceXml(booking, creditNoteNumber, generatedAt, {
      creditNote: true,
      relatedInvoiceNumber,
    });
    const creditNoteUblUrl = await uploadBufferToS3(
      Buffer.from(ublXml, "utf8"),
      `${keyBase}.xml`,
      "application/xml",
      `attachment; filename="${creditNoteNumber}.xml"`
    );

    const peppolResult = await maybeDispatchPeppolInvoice({
      booking,
      invoiceNumber: creditNoteNumber,
      ublXml,
      invoiceUblUrl: creditNoteUblUrl,
      documentType: "credit_note",
    });

    const update = {
      creditNoteNumber,
      creditNoteUrl,
      creditNoteUblUrl,
      creditNoteGeneratedAt: generatedAt,
      creditNoteRelatedInvoiceNumber: relatedInvoiceNumber,
      creditNotePeppolDispatchStatus: peppolResult.status,
      creditNotePeppolDispatchReference: peppolResult.reference,
    };

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.creditNoteNumber": update.creditNoteNumber,
          "payment.creditNoteUrl": update.creditNoteUrl,
          "payment.creditNoteUblUrl": update.creditNoteUblUrl,
          "payment.creditNoteGeneratedAt": update.creditNoteGeneratedAt,
          "payment.creditNoteRelatedInvoiceNumber": update.creditNoteRelatedInvoiceNumber,
          "payment.creditNotePeppolDispatchStatus": update.creditNotePeppolDispatchStatus,
          "payment.creditNotePeppolDispatchReference": update.creditNotePeppolDispatchReference,
        },
      }
    );

    await persistPaymentArtifactUpdate(booking._id, paymentId, update);

    return {
      creditNoteNumber,
      creditNoteUrl,
      creditNoteUblUrl,
      creditNoteGeneratedAt: generatedAt,
      relatedInvoiceNumber,
    };
  } catch (error) {
    await clearCreditNoteGenerationClaim(bookingId);
    throw error;
  }
}
