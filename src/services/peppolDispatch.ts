import PlatformSettings from "../models/platformSettings";
import { normalizeVatCountry } from "../utils/vatManagement";

export type PeppolDispatchStatus = "skipped" | "queued" | "sent" | "failed";

export type PeppolDispatchResult = {
  status: PeppolDispatchStatus;
  provider?: string;
  reference?: string;
  reason?: string;
  dispatchedAt?: Date;
};

const isBelgianB2BBooking = (booking: any): boolean => {
  const customer = booking.customer || {};
  if (customer.customerType !== "business") return false;
  const country = normalizeVatCountry(
    customer.companyAddress?.country || customer.location?.country || booking.vatDecision?.country
  );
  return country === "BE";
};

export async function maybeDispatchPeppolInvoice(params: {
  booking: any;
  invoiceNumber: string;
  ublXml: string;
  invoiceUblUrl: string;
}): Promise<PeppolDispatchResult> {
  if (!isBelgianB2BBooking(params.booking)) {
    return { status: "skipped", reason: "Peppol dispatch is limited to Belgian B2B customers" };
  }

  const settings = await PlatformSettings.getCurrentConfig();
  const eInvoicing = settings.eInvoicing || {};

  if (!eInvoicing.peppolEnabled) {
    return { status: "skipped", reason: "Peppol e-invoicing is disabled in platform settings" };
  }

  const provider = eInvoicing.provider || "manual";
  const dispatchedAt = new Date();
  const reference = `peppol-${params.invoiceNumber}-${dispatchedAt.getTime()}`;

  if (provider === "manual") {
    return {
      status: "queued",
      provider,
      reference,
      reason: "UBL artifact stored; manual Peppol dispatch required",
      dispatchedAt,
    };
  }

  // Provider integrations are configured per environment. Until credentials are present,
  // we queue the dispatch and expose the UBL artifact for operator follow-up.
  return {
    status: "queued",
    provider,
    reference,
    reason: `${provider} API credentials not configured; UBL queued for operator dispatch`,
    dispatchedAt,
  };
}
