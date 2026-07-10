import type { ScrapeResult } from '../firecrawlClient';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface FoundLink {
  href: string;
  anchorText?: string;
  rel?: string;
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Extract all links from crawl output that point to any of the allowed
 * target domains.
 *
 * Strategy (priority order — results merged and deduped by href):
 *  1. Parse <a href="…"> from HTML — highest fidelity, preserves anchorText + rel
 *  2. Regex over markdown — catches [text](url) and bare https:// references
 *  3. Firecrawl's links[] array — plain hrefs, no anchor context
 *
 * When requireFollow is true, only HTML <a> tags are used so rel="nofollow"
 * can be evaluated reliably.
 *
 * @param content        - Raw output from firecrawlClient.scrapePageForLinks
 * @param allowedDomains - Hostnames to accept (e.g. from FRONTEND_URL + admin config)
 * @param requireFollow  - If true, links carrying rel="nofollow" are excluded
 */
export function extractFixtractLinks(
  content: ScrapeResult,
  allowedDomains: string[],
  requireFollow: boolean,
): FoundLink[] {
  const domainSet = new Set(allowedDomains.map((d) => d.toLowerCase()));
  const seen = new Set<string>();
  const results: FoundLink[] = [];

  function tryAdd(link: FoundLink): void {
    const normalised = link.href.toLowerCase().replace(/\/$/, '');
    if (seen.has(normalised)) return;
    if (!isAllowedDomain(link.href, domainSet)) return;
    if (requireFollow && isNoFollow(link.rel)) return;
    seen.add(normalised);
    results.push(link);
  }

  // ── 1. HTML <a> tags ─────────────────────────────────────────────
  if (content.html) {
    for (const match of content.html.matchAll(
      /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>([\s\S]*?)<\/a>/gi,
    )) {
      const beforeHref = match[1] ?? '';
      const href = match[2] ?? '';
      const afterHref = match[3] ?? '';
      const innerHtml = match[4] ?? '';

      const relMatch = (beforeHref + afterHref).match(/rel=["']([^"']+)["']/i);
      const rel = relMatch?.[1];
      const anchorText = innerHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || undefined;

      tryAdd({ href, anchorText, rel });
    }
  }

  if (requireFollow) {
    return results;
  }

  // ── 2. Markdown links ────────────────────────────────────────────
  if (content.markdown) {
    // [text](url)
    for (const match of content.markdown.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g)) {
      tryAdd({ href: match[2], anchorText: match[1] || undefined });
    }
    // Bare https:// not inside parentheses
    for (const match of content.markdown.matchAll(/(?<!\()(https?:\/\/[^\s)\]]+)/g)) {
      tryAdd({ href: match[1] });
    }
  }

  // ── 3. Firecrawl links[] ─────────────────────────────────────────
  if (content.links) {
    for (const href of content.links) {
      tryAdd({ href });
    }
  }

  return results;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isAllowedDomain(href: string, domainSet: Set<string>): boolean {
  try {
    const { hostname } = new URL(href);
    return domainSet.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isNoFollow(rel: string | undefined): boolean {
  if (!rel) return false;
  return rel.toLowerCase().split(/\s+/).includes('nofollow');
}
