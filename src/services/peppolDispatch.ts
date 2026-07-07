import PlatformSettings from "../models/platformSettings";
import { normalizeVatCountry } from "../utils/vatManagement";

export type PeppolDispatchStatus = "skipped" | "queued" | "sent" | "failed";

export type PeppolProvider = "manual" | "billit" | "odoo";

export type PeppolDispatchResult = {
  status: PeppolDispatchStatus;
  provider?: string;
  reference?: string;
  reason?: string;
  dispatchedAt?: Date;
  response?: unknown;
  attempts?: number;
};

type PeppolProviderConfig = {
  endpoint?: string;
  apiKey?: string;
};

type PeppolDispatchPayload = {
  documentType: "invoice" | "credit_note";
  invoiceNumber: string;
  peppolParticipantId?: string;
  supplierParticipantId?: string;
  customerVatNumber?: string;
  customerName?: string;
  ublXml: string;
  ublUrl: string;
};

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_DISPATCH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const PEPPOL_FETCH_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isBelgianB2BBooking = (booking: any): boolean => {
  const customer = booking.customer || {};
  if (customer.customerType !== "business") return false;
  const country = normalizeVatCountry(
    customer.companyAddress?.country || customer.location?.country || booking.vatDecision?.country
  );
  return country === "BE";
};

const getProviderConfig = (provider: PeppolProvider): PeppolProviderConfig => {
  if (provider === "billit") {
    return {
      endpoint: process.env.BILLIT_PEPPOL_ENDPOINT || process.env.BILLIT_API_URL,
      apiKey: process.env.BILLIT_API_KEY,
    };
  }
  if (provider === "odoo") {
    return {
      endpoint: process.env.ODOO_PEPPOL_ENDPOINT || process.env.ODOO_API_URL,
      apiKey: process.env.ODOO_API_KEY,
    };
  }
  return {};
};

const buildProviderRequest = (
  provider: PeppolProvider,
  payload: PeppolDispatchPayload
): { endpoint: string; headers: Record<string, string>; body: string } | null => {
  const config = getProviderConfig(provider);
  if (!config.endpoint || !config.apiKey) return null;

  if (provider === "billit") {
    return {
      endpoint: config.endpoint,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "X-Idempotency-Key": payload.invoiceNumber,
      },
      body: JSON.stringify({
        documentType: payload.documentType,
        format: "ubl",
        invoiceNumber: payload.invoiceNumber,
        supplierParticipantId: payload.supplierParticipantId,
        customerParticipantId: payload.customerVatNumber,
        customerName: payload.customerName,
        ublXml: payload.ublXml,
        sourceUrl: payload.ublUrl,
      }),
    };
  }

  return {
    endpoint: config.endpoint,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "peppol",
        method: "send_document",
        args: [{
          document_type: payload.documentType,
          is_credit_note: payload.documentType === "credit_note",
          invoice_number: payload.invoiceNumber,
          peppol_participant_id: payload.peppolParticipantId,
          customer_vat: payload.customerVatNumber,
          customer_name: payload.customerName,
          ubl_xml: payload.ublXml,
          ubl_url: payload.ublUrl,
        }],
      },
    }),
  };
};

const parseProviderResponse = (provider: PeppolProvider, parsed: unknown): string | undefined => {
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const body = parsed as Record<string, unknown>;
  if (provider === "odoo") {
    const result = body.result;
    if (typeof result === "object" && result !== null) {
      const record = result as Record<string, unknown>;
      return record.id != null
        ? String(record.id)
        : record.reference != null
          ? String(record.reference)
          : undefined;
    }
  }

  return body.id != null
    ? String(body.id)
    : body.reference != null
      ? String(body.reference)
      : body.uuid != null
        ? String(body.uuid)
        : undefined;
};

const shouldRetryDispatch = (response: Response | null, error?: unknown): boolean => {
  if (error) return true;
  if (!response) return false;
  return RETRYABLE_STATUS_CODES.has(response.status);
};

const dispatchWithRetries = async (
  provider: PeppolProvider,
  request: { endpoint: string; headers: Record<string, string>; body: string },
  reference: string
): Promise<PeppolDispatchResult> => {
  let lastReason = `${provider} Peppol dispatch failed`;
  let lastResponse: unknown;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(PEPPOL_FETCH_TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }

      if (!response.ok) {
        lastReason = `${provider} Peppol dispatch failed with HTTP ${response.status}`;
        lastResponse = parsed;
        if (attempt < MAX_DISPATCH_ATTEMPTS && shouldRetryDispatch(response)) {
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        return {
          status: "failed",
          provider,
          reference,
          reason: lastReason,
          response: parsed,
          attempts,
        };
      }

      const providerReference = parseProviderResponse(provider, parsed);
      return {
        status: "sent",
        provider,
        reference: providerReference ? String(providerReference) : reference,
        dispatchedAt: new Date(),
        response: parsed,
        attempts,
      };
    } catch (error: any) {
      lastReason = error?.message || `${provider} Peppol dispatch failed`;
      lastResponse = error;
      if (attempt < MAX_DISPATCH_ATTEMPTS && shouldRetryDispatch(null, error)) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      return {
        status: "failed",
        provider,
        reference,
        reason: lastReason,
        response: lastResponse,
        attempts,
      };
    }
  }

  return {
    status: "failed",
    provider,
    reference,
    reason: lastReason,
    response: lastResponse,
    attempts,
  };
};

export async function maybeDispatchPeppolInvoice(params: {
  booking: any;
  invoiceNumber: string;
  ublXml: string;
  invoiceUblUrl: string;
  documentType?: "invoice" | "credit_note";
}): Promise<PeppolDispatchResult> {
  if (!isBelgianB2BBooking(params.booking)) {
    return { status: "skipped", reason: "Peppol dispatch is limited to Belgian B2B customers" };
  }

  const settings = await PlatformSettings.getCurrentConfig();
  const eInvoicing = settings.eInvoicing || {};

  if (!eInvoicing.peppolEnabled) {
    return { status: "skipped", reason: "Peppol e-invoicing is disabled in platform settings" };
  }

  const provider = (eInvoicing.provider || "manual") as PeppolProvider;
  const dispatchedAt = new Date();
  const reference = `peppol-${params.invoiceNumber}-${dispatchedAt.getTime()}`;

  if (provider === "manual") {
    return {
      status: "queued",
      provider,
      reference,
      reason: "UBL artifact stored; manual Peppol dispatch required",
      attempts: 0,
    };
  }

  const payload: PeppolDispatchPayload = {
    documentType: params.documentType || "invoice",
    invoiceNumber: params.invoiceNumber,
    peppolParticipantId: eInvoicing.peppolParticipantId,
    supplierParticipantId: eInvoicing.peppolParticipantId,
    customerVatNumber: params.booking.customer?.vatNumber,
    customerName: params.booking.customer?.businessName || params.booking.customer?.name,
    ublXml: params.ublXml,
    ublUrl: params.invoiceUblUrl,
  };

  const request = buildProviderRequest(provider, payload);
  if (!request) {
    return {
      status: "failed",
      provider,
      reference,
      reason: `${provider} Peppol endpoint/API key is not configured`,
      attempts: 0,
    };
  }

  return dispatchWithRetries(provider, request, reference);
}
