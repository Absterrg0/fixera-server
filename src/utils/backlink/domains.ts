import type { IBacklinkConfig } from '../../models/backlinkConfig';

function domainsFromEnv(): string[] {
  const url = process.env.FRONTEND_URL;
  if (!url) return [];
  try {
    const { hostname } = new URL(url);
    const hosts = [hostname.toLowerCase()];
    if (!hostname.startsWith('www.')) hosts.push(`www.${hostname.toLowerCase()}`);
    return hosts;
  } catch {
    return [];
  }
}

/**
 * Allowed backlink target hosts = FRONTEND_URL host(s) plus any domains
 * the admin added in config. FRONTEND_URL is always the baseline default;
 * the DB list starts empty and is owned by admin.
 */
export function getEffectiveAllowedDomains(config: IBacklinkConfig): string[] {
  const fromDb = (config.allowedTargetDomains ?? []).map((d) => d.toLowerCase());
  const fromEnv = domainsFromEnv();
  const domains = Array.from(new Set([...fromEnv, ...fromDb]));
  if (domains.length === 0) {
    console.warn(
      "[backlinks] No allowed target domains: set FRONTEND_URL or add domains in admin backlink settings."
    );
  }
  return domains;
}

/** True when the hostname is one of Fixtract's own domains (not a valid external submission). */
export function isFixtractDomain(domain: string, config: IBacklinkConfig): boolean {
  return getEffectiveAllowedDomains(config).includes(domain.toLowerCase());
}
