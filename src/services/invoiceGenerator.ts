/**
 * Invoice Generation Service
 * Generates PDF invoices for completed bookings
 */

import PDFDocument from "pdfkit";
import InvoiceSequence from "../models/invoiceSequence";
import PlatformSettings from "../models/platformSettings";
import { getVATExplanation, isEUCountry } from "../utils/vat";
import { formatCurrency } from "../utils/payment";

interface InvoiceData {
  invoiceNumber: string;
  invoiceDate: Date;
  bookingNumber: string;
  documentType?: "invoice" | "credit_note";
  relatedInvoiceNumber?: string;

  // Customer info
  customer: {
    name: string;
    email: string;
    businessName?: string;
    address?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
  };

  // Professional info
  professional: {
    name: string;
    companyName?: string;
    address?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
  };

  // Payment details
  payment: {
    netAmount: number;
    vatAmount: number;
    vatRate: number;
    totalWithVat: number;
    currency: string;
  };

  // Service description
  serviceDescription: string;
  lineItems?: { description: string; amount: number; vatRate?: number }[];
  discounts?: { label: string; amount: number }[];
  actualStartDate?: Date;
  actualEndDate?: Date;
  selfBilling?: boolean;
  issuer?: {
    name?: string;
    vatNumber?: string;
    street?: string;
    city?: string;
    postalCode?: string;
    country?: string;
  };

  // VAT explanation
  vatExplanation?: string;
}

interface InvoiceBooking {
  _id: { toString(): string } | string;
  bookingNumber?: string;
  quote?: { description?: string };
  rfqData?: { description?: string; serviceType?: string };
  quoteVersions?: Array<{
    version?: number;
    scope?: string;
    description?: string;
    pricingLines?: { description: string; price: number; vatRate?: number }[];
    totalAmount?: number;
  }>;
  currentQuoteVersion?: number;
  project?: {
    title?: string;
    category?: string;
    service?: string;
    extraOptions?: Array<{ name?: string; _id?: string }>;
    subprojects?: Array<{ title?: string; description?: string }>;
  };
  customer: {
    name: string;
    email: string;
    customerType?: string;
    businessName?: string;
    companyAddress?: {
      address?: string;
      city?: string;
      country?: string;
      postalCode?: string;
    };
    vatNumber?: string;
    location?: {
      address?: string;
      city?: string;
      country?: string;
    };
  };
  professional: {
    name: string;
    vatNumber?: string;
    businessInfo?: {
      companyName?: string;
      address?: string;
      city?: string;
      country?: string;
    };
  };
  payment: {
    netAmount?: number;
    vatAmount?: number;
    vatRate?: number;
    totalWithVat?: number;
    currency?: string;
    reverseCharge?: boolean;
    vatBreakdown?: { description: string; netAmount: number; vatRate: number; vatAmount: number }[];
    discount?: {
      loyaltyAmount?: number;
      repeatBuyerAmount?: number;
      pointsDiscountAmount?: number;
      codeDiscountAmount?: number;
      codeLabel?: string;
      totalDiscount?: number;
    };
  };
  actualStartDate?: Date;
  actualEndDate?: Date;
  scheduledStartDate?: Date;
  scheduledExecutionEndDate?: Date;
  extraCosts?: {
    name: string;
    amount: number;
    justification?: string;
    type?: string;
    estimatedUnits?: number;
    actualUnits?: number;
    unitPrice?: number;
  }[];
  extraCostTotal?: number;
  selectedExtraOptions?: Array<{ extraOptionId?: string; bookedPrice?: number; name?: string }>;
  selectedSubprojectIndex?: number;
  subprojects?: Array<{ title?: string; description?: string }>;
}

/**
 * Generate invoice number
 * Format: INV-YYYY-NNNNNN
 */
export async function generateInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const sequence = await InvoiceSequence.findOneAndUpdate(
    { year, kind: "invoice" },
    {
      $setOnInsert: { year, kind: "invoice" },
      $inc: { value: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (!sequence) {
    throw new Error("Failed to generate invoice sequence");
  }

  return `INV-${year}-${String(sequence.value).padStart(6, "0")}`;
}

export async function generateCreditNoteNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const sequence = await InvoiceSequence.findOneAndUpdate(
    { year, kind: "credit_note" },
    {
      $setOnInsert: { year, kind: "credit_note" },
      $inc: { value: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (!sequence) {
    throw new Error("Failed to generate credit note sequence");
  }

  return `CN-${year}-${String(sequence.value).padStart(6, "0")}`;
}

/**
 * Generate PDF invoice
 * Returns Buffer that can be uploaded to S3
 */
export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers: Buffer[] = [];
      const invoiceDate =
        data.invoiceDate instanceof Date ? data.invoiceDate : new Date(data.invoiceDate);
      const invoiceDateText = Number.isNaN(invoiceDate.getTime())
        ? new Date().toLocaleDateString("en-GB")
        : invoiceDate.toLocaleDateString("en-GB");

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on("error", (error) => {
        reject(error);
      });

      // Header. For self-billed documents the professional remains the legal
      // supplier; the platform is only the preparer of the document.
      const issuer = data.issuer || {};
      doc
        .fontSize(20)
        .text(issuer.name || "FIXERA", 50, 50)
        .fontSize(10)
        .text(
          data.selfBilling
            ? "Document prepared by the platform on behalf of the supplier"
            : "Property Services Marketplace",
          50,
          75
        )
        .text([issuer.street, issuer.postalCode, issuer.city, issuer.country].filter(Boolean).join(", ") || "Belgium", 50, 90);
      if (issuer.vatNumber) {
        doc.text(`VAT: ${issuer.vatNumber}`, 50, 105);
      }

      // Invoice title
      doc.fontSize(20).text(data.documentType === "credit_note" ? "CREDIT NOTE" : "INVOICE", 400, 50, { align: "right" });

      // Invoice details
      doc
        .fontSize(10)
        .text(`${data.documentType === "credit_note" ? "Credit note" : "Invoice"} #: ${data.invoiceNumber}`, 400, 75, { align: "right" })
        .text(`Date: ${invoiceDateText}`, 400, 90, { align: "right" })
        .text(`Booking #: ${data.bookingNumber}`, 400, 105, { align: "right" });
      if (data.relatedInvoiceNumber) {
        doc.text(`Related invoice: ${data.relatedInvoiceNumber}`, 400, 120, { align: "right" });
      }

      // Horizontal line
      doc.moveTo(50, 130).lineTo(550, 130).stroke();

      // Bill To section
      doc.fontSize(12).text("BILL TO:", 50, 150);

      doc.fontSize(10).text(data.customer.businessName || data.customer.name, 50, 170).text(data.customer.email, 50, 185);

      if (data.customer.address) {
        doc.text(data.customer.address, 50, 200);
      }
      if (data.customer.city && data.customer.country) {
        doc.text(`${data.customer.city}, ${data.customer.country}`, 50, 215);
      }
      if (data.customer.vatNumber) {
        doc.text(`VAT: ${data.customer.vatNumber}`, 50, 230);
      }

      // Supplier section (the professional is the legal supplier of the service)
      doc.fontSize(12).text(data.selfBilling ? "SUPPLIER:" : "SERVICE PROVIDER:", 320, 150);

      doc.fontSize(10).text(data.professional.companyName || data.professional.name, 320, 170);

      if (data.professional.address) {
        doc.text(data.professional.address, 320, 185);
      }
      if (data.professional.city && data.professional.country) {
        doc.text(`${data.professional.city}, ${data.professional.country}`, 320, 200);
      }
      if (data.professional.vatNumber) {
        doc.text(`VAT: ${data.professional.vatNumber}`, 320, 215);
      }
      if (data.selfBilling) {
        doc.text("Prepared and sent on behalf of the supplier.", 320, 230, { width: 230 });
      }

      // Service description
      doc.fontSize(12).text("SERVICE DESCRIPTION:", 50, 280);
      const descriptionStartY = 300;
      const descriptionWidth = 500;
      doc.fontSize(10);
      const descriptionHeight = doc.heightOfString(data.serviceDescription, {
        width: descriptionWidth,
      });
      doc.text(data.serviceDescription, 50, descriptionStartY, { width: descriptionWidth });

      const dateLines = [
        data.actualStartDate ? `Actual start date: ${new Date(data.actualStartDate).toLocaleDateString("en-GB")}` : undefined,
        data.actualEndDate ? `Actual end date: ${new Date(data.actualEndDate).toLocaleDateString("en-GB")}` : undefined,
      ].filter(Boolean);
      if (dateLines.length > 0) {
        doc.text(dateLines.join("\n"), 50, descriptionStartY + descriptionHeight + 8, { width: descriptionWidth });
      }

      // Invoice table (always rendered below the variable-height description)
      const tableTop = Math.max(360, descriptionStartY + descriptionHeight + (dateLines.length > 0 ? 45 : 20));

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Description", 50, tableTop)
        .text("Amount", 450, tableTop, { align: "right" });
      doc.font("Helvetica");

      // Line
      doc.moveTo(50, tableTop + 20).lineTo(550, tableTop + 20).stroke();

      let rowY = tableTop + 30;
      const lineItems = data.lineItems?.length
        ? data.lineItems
        : [{ description: "Service Amount", amount: data.payment.netAmount, vatRate: data.payment.vatRate }];
      for (const item of lineItems) {
        doc
          .text(item.vatRate != null ? `${item.description} (${item.vatRate}% VAT)` : item.description, 50, rowY, { width: 360 })
          .text(formatCurrency(item.amount, data.payment.currency), 450, rowY, { align: "right" });
        rowY += 20;
      }

      for (const discount of data.discounts || []) {
        const discountAmountLabel = discount.amount < 0
          ? formatCurrency(discount.amount, data.payment.currency)
          : `-${formatCurrency(Math.abs(discount.amount), data.payment.currency)}`;
        doc
          .text(discount.label, 50, rowY)
          .text(discountAmountLabel, 450, rowY, { align: "right" });
        rowY += 20;
      }

      // VAT
      if (data.payment.vatAmount !== 0) {
        doc
          .text(`VAT (${data.payment.vatRate}%)`, 50, rowY)
          .text(formatCurrency(data.payment.vatAmount, data.payment.currency), 450, rowY, {
            align: "right",
          });
        rowY += 20;
      }

      // Total line
      doc.moveTo(50, rowY).lineTo(550, rowY).stroke();

      // Total
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("TOTAL", 50, rowY + 10)
        .text(formatCurrency(data.payment.totalWithVat, data.payment.currency), 450, rowY + 10, {
          align: "right",
        });
      doc.font("Helvetica");

      // VAT explanation
      if (data.vatExplanation) {
        doc.fontSize(9).text(data.vatExplanation, 50, rowY + 50, {
          width: 500,
          align: "left",
        });
      }

      // Footer
      const tableContentBottom = data.vatExplanation ? rowY + 100 : rowY + 40;
      const contentBottom = Math.max(doc.y, tableContentBottom);
      const footerHeight = 30;
      const footerPadding = 20;
      const maxFooterY = doc.page.height - doc.page.margins.bottom - footerHeight;
      let footerY = contentBottom + footerPadding;

      if (footerY > maxFooterY) {
        doc.addPage();
        footerY = doc.page.margins.top;
      }

      doc
        .fontSize(8)
        .text("Thank you for using Fixera!", 50, footerY, {
          align: "center",
          width: 500,
        })
        .text("This invoice was generated automatically by the Fixera platform.", 50, footerY + 15, {
          align: "center",
          width: 500,
        });

      // Finalize PDF
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate invoice for a booking
 * This should be called after payment is captured
 */
export async function generateBookingInvoice(
  booking: InvoiceBooking,
  options?: { creditNote?: boolean; relatedInvoiceNumber?: string }
): Promise<{ invoiceNumber: string; pdfBuffer: Buffer }> {
  const invoiceNumber = options?.creditNote
    ? await generateCreditNoteNumber()
    : await generateInvoiceNumber();
  const invoiceDate = new Date();
  const sign = options?.creditNote ? -1 : 1;

  const customer = booking.customer;
  const professional = booking.professional;
  const customerCountry = customer.location?.country || "BE";
  const settings = await PlatformSettings.getCurrentConfig();
  const currentQuote = booking.quoteVersions?.find((quote) => quote.version === booking.currentQuoteVersion)
    || booking.quoteVersions?.[booking.quoteVersions.length - 1];
  const quoteLines = booking.payment.vatBreakdown?.length
    ? booking.payment.vatBreakdown.map((line) => ({
        description: line.description,
        amount: line.netAmount * sign,
        vatRate: line.vatRate,
      }))
    : currentQuote?.pricingLines?.map((line) => ({
        description: line.description,
        amount: line.price * sign,
        vatRate: line.vatRate,
      })) || [];

  const selectedSubproject =
    typeof booking.selectedSubprojectIndex === "number" &&
    Array.isArray(booking.project?.subprojects) &&
    booking.selectedSubprojectIndex >= 0 &&
    booking.selectedSubprojectIndex < booking.project.subprojects.length
      ? booking.project.subprojects[booking.selectedSubprojectIndex]
      : undefined;

  const optionLines = (booking.selectedExtraOptions || []).map((option) => {
    const projectOption = (booking as any).project?.extraOptions?.find(
      (entry: any, index: number) =>
        String(entry?._id || index) === String(option.extraOptionId) ||
        String(index) === String(option.extraOptionId)
    );
    return {
      description: `Option: ${projectOption?.name || option.name || option.extraOptionId || "Extra option"}`,
      amount: (option.bookedPrice ?? 0) * sign,
      vatRate: booking.payment.vatRate ?? 0,
    };
  });

  const extraCostLines = (booking.extraCosts || []).map((cost) => {
    const unitDetail =
      cost.type === "unit_adjustment" &&
      Number.isFinite(cost.actualUnits) &&
      Number.isFinite(cost.estimatedUnits)
        ? ` (${cost.estimatedUnits} est. → ${cost.actualUnits} actual)`
        : cost.type === "unit_adjustment" && Number.isFinite(cost.actualUnits)
          ? ` (${cost.actualUnits} units)`
          : "";
    return {
      description: `Extra cost: ${cost.name}${unitDetail}${cost.justification ? ` - ${cost.justification}` : ""}`,
      amount: cost.amount * sign,
      vatRate: booking.payment.vatRate ?? 0,
    };
  });
  const discount = booking.payment.discount;
  const discounts = [
    discount?.loyaltyAmount ? { label: "Loyalty discount", amount: discount.loyaltyAmount * sign } : undefined,
    discount?.repeatBuyerAmount ? { label: "Repeat buyer discount", amount: discount.repeatBuyerAmount * sign } : undefined,
    discount?.pointsDiscountAmount ? { label: "Points discount", amount: discount.pointsDiscountAmount * sign } : undefined,
    discount?.codeDiscountAmount ? { label: `Discount code${discount.codeLabel ? ` (${discount.codeLabel})` : ""}`, amount: discount.codeDiscountAmount * sign } : undefined,
  ].filter(Boolean) as { label: string; amount: number }[];

  const fallbackReverseChargeHeuristic =
    (booking.payment.vatRate ?? 0) === 0 &&
    (booking.payment.vatAmount ?? 0) === 0 &&
    isEUCountry(customerCountry);
  const reverseCharge =
    booking.payment.reverseCharge !== undefined
      ? booking.payment.reverseCharge
      : fallbackReverseChargeHeuristic;

  const invoiceData: InvoiceData = {
    invoiceNumber,
    invoiceDate,
    bookingNumber: booking.bookingNumber || booking._id.toString(),
    documentType: options?.creditNote ? "credit_note" : "invoice",
    relatedInvoiceNumber: options?.relatedInvoiceNumber,

    customer: {
      name: customer.name,
      email: customer.email,
      businessName: customer.customerType === "business" ? customer.businessName : undefined,
      address: customer.companyAddress?.address || customer.location?.address,
      city: customer.companyAddress?.city || customer.location?.city,
      country: customer.companyAddress?.country || customer.location?.country,
      vatNumber: customer.vatNumber,
    },

    professional: {
      name: professional.name,
      companyName: professional.businessInfo?.companyName,
      address: professional.businessInfo?.address,
      city: professional.businessInfo?.city,
      country: professional.businessInfo?.country,
      vatNumber: professional.vatNumber,
    },

    payment: {
      netAmount: (booking.payment.netAmount ?? 0) * sign,
      vatAmount: (booking.payment.vatAmount ?? 0) * sign,
      vatRate: booking.payment.vatRate ?? 0,
      totalWithVat: (booking.payment.totalWithVat ?? 0) * sign,
      currency: booking.payment.currency || "EUR",
    },

    serviceDescription:
      [
        booking.project?.title ? `Project: ${booking.project.title}` : undefined,
        selectedSubproject?.title ? `Package: ${selectedSubproject.title}` : undefined,
        selectedSubproject?.description ? `Package details: ${selectedSubproject.description}` : undefined,
        booking.rfqData?.serviceType ? `Service: ${booking.rfqData.serviceType}` : undefined,
        currentQuote?.scope ? `Scope: ${currentQuote.scope}` : undefined,
        currentQuote?.description || booking.quote?.description || booking.rfqData?.description || "Property service",
      ].filter(Boolean).join("\n"),

    lineItems: [...quoteLines, ...optionLines, ...extraCostLines],
    discounts,
    actualStartDate: booking.actualStartDate || booking.scheduledStartDate,
    actualEndDate: booking.actualEndDate || booking.scheduledExecutionEndDate,
    selfBilling: true,
    issuer: {
      name: settings.companyAddress?.name || "Fixera",
      vatNumber: settings.companyVatNumber,
      street: settings.companyAddress?.street,
      city: settings.companyAddress?.city,
      postalCode: settings.companyAddress?.postalCode,
      country: settings.companyAddress?.country,
    },

    vatExplanation: getVATExplanation(
      {
        vatRate: booking.payment.vatRate ?? 0,
        vatAmount: booking.payment.vatAmount ?? 0,
        total: booking.payment.totalWithVat ?? 0,
        reverseCharge,
      },
      customerCountry
    ),
  };

  const pdfBuffer = await generateInvoicePDF(invoiceData);

  return {
    invoiceNumber,
    pdfBuffer,
  };
}
