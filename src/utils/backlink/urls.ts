import { isIP } from 'net';

export interface NormaliseResult {
  normalizedUrl: string;
  domain: string;
}

const TRACKING_QUERY_PARAMS = new Set([
  'ref',
  'source',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
]);

function stripTrackingQueryParams(parsed: URL): void {
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_QUERY_PARAMS.has(key) || key.startsWith('utm_')) {
      parsed.searchParams.delete(key);
    }
  }
}

function isBlockedHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost') return true;
  return isIP(bare) !== 0;
}

/**
 * Canonicalise a URL for deduplication:
 *  - Lowercase host
 *  - Strip hash fragment
 *  - Remove trailing slash from path
 *  - Strip common tracking query params
 *
 * Throws a plain Error with a user-facing message on invalid input.
 */
export function normaliseSubmissionUrl(raw: string): NormaliseResult {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Invalid URL — please include http:// or https://');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported');
  }

  if (isBlockedHost(parsed.hostname)) {
    throw new Error('localhost and IP addresses are not accepted');
  }

  if (raw.length > 2048) {
    throw new Error('URL exceeds maximum length of 2048 characters');
  }

  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  stripTrackingQueryParams(parsed);

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return {
    normalizedUrl: parsed.toString(),
    domain: parsed.hostname,
  };
}
