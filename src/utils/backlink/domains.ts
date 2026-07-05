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
 * Union of admin-configured domains and FRONTEND_URL host(s).
 * The env var is always included so the live domain matches even if the DB list is cleared.
 */
export function getEffectiveAllowedDomains(config: IBacklinkConfig): string[] {
  const fromDb = config.allowedTargetDomains.map((d) => d.toLowerCase());
  const fromEnv = domainsFromEnv();
  return Array.from(new Set([...fromDb, ...fromEnv]));
}

/** True when the hostname is one of Fixera's own domains (not a valid external submission). */
export function isFixeraDomain(domain: string, config: IBacklinkConfig): boolean {
  return getEffectiveAllowedDomains(config).includes(domain.toLowerCase());
}
