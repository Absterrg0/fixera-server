import Booking from "../models/booking";
import Payment from "../models/payment";
import { uploadBufferToS3 } from "../utils/s3Upload";
import { generateBookingInvoice } from "./invoiceGenerator";
import { maybeDispatchPeppolInvoice } from "./peppolDispatch";

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

const toMoney = (value: unknown): string => {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toFixed(2);
};

const getCurrentQuote = (booking: any) => {
  const versions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  return versions.find((quote: any) => quote.version === booking.currentQuoteVersion) || versions[versions.length - 1];
};

const buildUblInvoiceXml = (
  booking: any,
  invoiceNumber: string,
  issuedAt: Date,
  options?: { creditNote?: boolean; relatedInvoiceNumber?: string }
): string => {
  const currency = booking.payment?.currency || "EUR";
  const customer = booking.customer || {};
  const professional = booking.professional || {};
  const currentQuote = getCurrentQuote(booking);
  const sign = options?.creditNote ? -1 : 1;
  const pricingLines = Array.isArray(currentQuote?.pricingLines) && currentQuote.pricingLines.length > 0
    ? currentQuote.pricingLines
    : [{
        description: booking.quote?.description || booking.rfqData?.description || "Service",
        price: booking.payment?.netAmount ?? booking.payment?.amount ?? 0,
        vatRate: booking.payment?.vatRate ?? 0,
      }];

  const invoiceLines = pricingLines.map((line: any, index: number) => `
    <cac:InvoiceLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
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
  <cbc:InvoiceTypeCode>${options?.creditNote ? "381" : "380"}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(booking.bookingNumber || booking._id?.toString?.())}</cbc:BuyerReference>
  ${options?.relatedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(options.relatedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${escapeXml(professional.businessInfo?.companyName || professional.name || "Supplier")}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(professional.vatNumber || professional.businessInfo?.vatNumber || "")}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${escapeXml(customer.businessName || customer.name || "Customer")}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(customer.vatNumber || "")}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.vatAmount || 0) * sign)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.totalWithVat) * sign)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${escapeXml(currency)}">${toMoney(Number(booking.payment?.totalWithVat) * sign)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${invoiceLines}
</Invoice>`;
};

const loadBookingForInvoice = async (bookingId: string) =>
  Booking.findById(bookingId)
    .populate("customer")
    .populate("professional")
    .populate("project", "title extraOptions subprojects");

export async function ensureBookingInvoiceArtifacts(bookingId: string): Promise<InvoiceArtifactResult | null> {
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment) return null;
  if (existing.payment.invoiceNumber && existing.payment.invoiceUrl) {
    return {
      invoiceNumber: existing.payment.invoiceNumber,
      invoiceUrl: existing.payment.invoiceUrl,
      invoiceUblUrl: existing.payment.invoiceUblUrl,
      invoiceGeneratedAt: existing.payment.invoiceGeneratedAt || new Date(),
      peppolDispatchStatus: existing.payment.peppolDispatchStatus,
      peppolDispatchReference: existing.payment.peppolDispatchReference,
    };
  }

  const booking = await loadBookingForInvoice(bookingId);
  if (!booking?.payment) return null;

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

  await Payment.findOneAndUpdate(
    { booking: booking._id },
    { $set: update }
  );

  return update;
}

export async function ensureCreditInvoiceArtifacts(bookingId: string): Promise<CreditArtifactResult | null> {
  const booking = await loadBookingForInvoice(bookingId);
  if (!booking?.payment?.invoiceNumber) {
    return null;
  }

  if (booking.payment.creditNoteNumber && booking.payment.creditNoteUrl) {
    return {
      creditNoteNumber: booking.payment.creditNoteNumber,
      creditNoteUrl: booking.payment.creditNoteUrl,
      creditNoteUblUrl: booking.payment.creditNoteUblUrl,
      creditNoteGeneratedAt: booking.payment.creditNoteGeneratedAt || new Date(),
      relatedInvoiceNumber: booking.payment.invoiceNumber,
    };
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

  await Payment.findOneAndUpdate(
    { booking: booking._id },
    { $set: update }
  );

  return {
    creditNoteNumber,
    creditNoteUrl,
    creditNoteUblUrl,
    creditNoteGeneratedAt: generatedAt,
    relatedInvoiceNumber,
  };
}
