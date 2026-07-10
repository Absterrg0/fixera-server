const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 15_000;
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;

export type OdooAccountingConfig = {
  baseUrl: string;
  apiKey: string;
  companyId: number;
  incomeAccountId: number;
  salesJournalId?: number;
  defaultTaxId: number;
  reverseChargeTaxId?: number;
  autoPost: boolean;
  taxIdsByRate: Record<string, number>;
};

type OdooCredentials = {
  baseUrl: string;
  apiKey: string;
};

type DiscoveryCacheEntry = {
  key: string;
  config: OdooAccountingConfig;
  expiresAt: number;
};

let discoveryCache: DiscoveryCacheEntry | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toPositiveInteger = (value: unknown): number | undefined => {
  if (value === "" || value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const buildJson2Endpoint = (baseUrl: string, model: string, method: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const json2Index = trimmed.indexOf("/json/2");
  const root = json2Index >= 0 ? trimmed.slice(0, json2Index) : trimmed;
  return `${root}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`;
};

const withCompanyContext = (
  companyId: number | undefined,
  body: Record<string, unknown>
): Record<string, unknown> => {
  if (!companyId) return body;
  const existingContext =
    typeof body.context === "object" && body.context !== null
      ? (body.context as Record<string, unknown>)
      : {};
  return {
    ...body,
    context: {
      ...existingContext,
      allowed_company_ids: [companyId],
      force_company: companyId,
      active_test: false,
    },
  };
};

const resolveOdooCompanyIds = async (credentials: OdooCredentials): Promise<number[]> => {
  const overrideCompanyId = toPositiveInteger(process.env.ODOO_COMPANY_ID);
  if (overrideCompanyId) return [overrideCompanyId];

  const context = await odooJson2Call<{ uid?: number }>(credentials, "res.users", "context_get", {});
  const uid = toPositiveInteger(context.uid);
  if (!uid) {
    throw new Error("Could not resolve the Odoo API user context");
  }

  const users = await odooJson2Call<Array<{ company_ids?: number[] }>>(
    credentials,
    "res.users",
    "read",
    { ids: [uid], fields: ["company_ids"] }
  );
  const companyIds = users[0]?.company_ids?.filter((id) => Number.isInteger(id) && id > 0) || [];
  if (!companyIds.length) {
    throw new Error("The Odoo API user has no accessible companies");
  }
  return companyIds;
};

const assertOdooResponse = (parsed: unknown): void => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  if (typeof record.name === "string" && /Error|Exception/i.test(record.name) && record.message) {
    throw new Error(String(record.message));
  }
};

export const odooJson2Call = async <T>(
  credentials: OdooCredentials,
  model: string,
  method: string,
  body: Record<string, unknown>,
  companyId?: number
): Promise<T> => {
  const response = await fetch(buildJson2Endpoint(credentials.baseUrl, model, method), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `bearer ${credentials.apiKey}`,
      "User-Agent": "fixtract-server odoo-accounting",
    },
    body: JSON.stringify(withCompanyContext(companyId, body)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as Record<string, unknown>).message)
        : `Odoo API call failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  assertOdooResponse(parsed);
  return parsed as T;
};

const odooJson2CallWithRetries = async <T>(
  credentials: OdooCredentials,
  model: string,
  method: string,
  body: Record<string, unknown>,
  companyId?: number
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await odooJson2Call<T>(credentials, model, method, body, companyId);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
    }
  }
  throw lastError;
};

const getOdooCredentials = (): OdooCredentials | null => {
  const baseUrl = process.env.ODOO_API_URL?.trim();
  const apiKey = process.env.ODOO_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
};

const pickIncomeAccount = (
  accounts: Array<{ id: number; code?: string | false; name?: string; company_ids?: number[] }>
): { accountId: number; companyId: number } => {
  const ranked = [...accounts].sort((left, right) => {
    const score = (account: typeof left): number => {
      const code = String(account.code || "");
      const name = String(account.name || "").toLowerCase();
      if (code === "700100" && name.includes("service")) return 0;
      if (code === "700100") return 1;
      if (name.includes("services in belgium")) return 2;
      if (code === "705000" && name.includes("service")) return 3;
      if (name.includes("service") && name.includes("belgium")) return 4;
      return 10;
    };
    return score(left) - score(right);
  });
  const selected = ranked[0];
  const companyId = selected.company_ids?.[0];
  if (!selected?.id || !companyId) {
    throw new Error("Could not resolve an Odoo income account with a company");
  }
  return { accountId: selected.id, companyId };
};

const pickSaleTax = (
  taxes: Array<{ id: number; name?: string; amount?: number }>,
  amount: number,
  preferredNames: string[]
): number | undefined => {
  const normalizedPreferred = preferredNames.map((name) => name.toLowerCase());
  const exact = taxes.find((tax) => normalizedPreferred.includes(String(tax.name || "").toLowerCase()));
  if (exact?.id) return exact.id;
  const byAmount = taxes.find((tax) => Number(tax.amount) === amount);
  return byAmount?.id;
};

const discoverIncomeAccount = async (
  credentials: OdooCredentials
): Promise<{ accountId: number; companyId: number }> => {
  const companyIds = await resolveOdooCompanyIds(credentials);
  const mergedAccounts: Array<{ id: number; code?: string | false; name?: string; company_ids?: number[] }> = [];

  for (const companyId of companyIds) {
    const accounts = await odooJson2CallWithRetries<Array<{ id: number; code?: string | false; name?: string }>>(
      credentials,
      "account.account",
      "search_read",
      {
        domain: [
          ["account_type", "=", "income"],
          "|",
          "|",
          ["code", "=", "700100"],
          ["code", "=", "705000"],
          ["name", "ilike", "Services in Belgium"],
        ],
        fields: ["id", "code", "name"],
        limit: 20,
      },
      companyId
    );
    for (const account of accounts) {
      mergedAccounts.push({ ...account, company_ids: [companyId] });
    }
  }

  if (!mergedAccounts.length) {
    throw new Error("No Odoo income account found; install the Belgian chart of accounts in Odoo");
  }
  return pickIncomeAccount(mergedAccounts);
};

const discoverSaleTaxes = async (
  credentials: OdooCredentials,
  companyId: number
): Promise<{ taxIdsByRate: Record<string, number>; defaultTaxId: number; reverseChargeTaxId?: number }> => {
  const taxes = await odooJson2CallWithRetries<Array<{ id: number; name?: string; amount?: number }>>(
    credentials,
    "account.tax",
    "search_read",
    {
      domain: [["type_tax_use", "=", "sale"]],
      fields: ["id", "name", "amount"],
      limit: 100,
    },
    companyId
  );

  const tax21 = pickSaleTax(taxes, 21, ["21% S", "21%"]);
  const tax6 = pickSaleTax(taxes, 6, ["6% S", "6%"]);
  if (!tax21) {
    throw new Error("Could not find a 21% Odoo sales tax (expected Belgian tax such as 21% S)");
  }

  const reverseTaxes = await odooJson2CallWithRetries<Array<{ id: number; name?: string; amount?: number }>>(
    credentials,
    "account.tax",
    "search_read",
    {
      domain: [
        ["type_tax_use", "=", "sale"],
        ["amount", "=", 0],
      ],
      fields: ["id", "name", "amount"],
      limit: 20,
    },
    companyId
  );
  const reverseChargeTaxId = reverseTaxes.find((tax) => /ic|intra|reverse|co-contractor/i.test(String(tax.name || "")))?.id;

  return {
    taxIdsByRate: {
      ...(tax21 ? { "21": tax21 } : {}),
      ...(tax6 ? { "6": tax6 } : {}),
    },
    defaultTaxId: tax21,
    reverseChargeTaxId,
  };
};

const discoverSalesJournal = async (
  credentials: OdooCredentials,
  companyId: number
): Promise<number | undefined> => {
  const journals = await odooJson2CallWithRetries<Array<{ id: number; name?: string; code?: string }>>(
    credentials,
    "account.journal",
    "search_read",
    {
      domain: [["type", "=", "sale"]],
      fields: ["id", "name", "code"],
      limit: 5,
    },
    companyId
  );
  return journals[0]?.id;
};

export const discoverOdooAccountingConfig = async (): Promise<OdooAccountingConfig> => {
  const credentials = getOdooCredentials();
  if (!credentials) {
    throw new Error("ODOO_API_URL and ODOO_API_KEY must be set");
  }

  const cacheKey = `${credentials.baseUrl}:${credentials.apiKey.slice(0, 12)}`;
  if (discoveryCache && discoveryCache.key === cacheKey && discoveryCache.expiresAt > Date.now()) {
    return discoveryCache.config;
  }

  const { accountId: incomeAccountId, companyId } = await discoverIncomeAccount(credentials);
  const { taxIdsByRate, defaultTaxId, reverseChargeTaxId } = await discoverSaleTaxes(credentials, companyId);
  const salesJournalId = await discoverSalesJournal(credentials, companyId);

  const config: OdooAccountingConfig = {
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    companyId,
    incomeAccountId,
    salesJournalId,
    defaultTaxId,
    reverseChargeTaxId,
    autoPost: process.env.ODOO_AUTO_POST === "true",
    taxIdsByRate,
  };

  discoveryCache = {
    key: cacheKey,
    config,
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
  };

  return config;
};

export const resolveOdooAccountingConfig = async (): Promise<OdooAccountingConfig | null> => {
  try {
    return await discoverOdooAccountingConfig();
  } catch (error) {
    console.error("Odoo accounting discovery failed:", error);
    return null;
  }
};
