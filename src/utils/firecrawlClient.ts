import { Firecrawl, type Document, type DocumentMetadata } from 'firecrawl';

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

/**
 * The subset of a crawled page we actually use for link verification.
 * Mapped directly from the SDK's `Document` type — no `as any` needed.
 */
export interface ScrapeResult {
  html: Document['html'];
  markdown: Document['markdown'];
  links: Document['links'];
  metadata: Pick<DocumentMetadata, 'title' | 'statusCode'> | undefined;
}

export class FirecrawlError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FirecrawlError';
  }
}

// ------------------------------------------------------------------
// Lazy singleton — constructed only when the API key is available
// ------------------------------------------------------------------

let _client: Firecrawl | null = null;

function getClient(): Firecrawl {
  if (_client) return _client;

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new FirecrawlError(
      'FIRECRAWL_API_KEY is not set — cannot crawl pages',
    );
  }

  _client = new Firecrawl({ apiKey });
  return _client;
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Wraps a promise with a timeout—rejects if the inner promise does not
 * resolve within `ms` milliseconds. The error will have name "TimeoutError".
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(message || `Operation timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Scrape `url` via Firecrawl and return its HTML, markdown, links and
 * page metadata.  Throws `FirecrawlError` on any failure or timeout.
 *
 * @param url       - The external page to crawl
 * @param timeoutMs - Max wait in ms (sourced from BacklinkConfig.crawlTimeoutMs)
 */
export async function scrapePageForLinks(
  url: string,
  timeoutMs: number,
): Promise<ScrapeResult> {
  const client = getClient();
  try {
    const doc: Document = await withTimeout(
      client.scrape(url, {
        formats: ['html', 'markdown', 'links'],
        timeout: timeoutMs,
      }),
      timeoutMs,
      `Crawl timed out after ${timeoutMs}ms for URL: ${url}`,
    );

    return {
      html: doc.html,
      markdown: doc.markdown,
      links: doc.links,
      metadata: doc.metadata
        ? { title: doc.metadata.title, statusCode: doc.metadata.statusCode }
        : undefined,
    };
  } catch (err: unknown) {
    if (err instanceof FirecrawlError) throw err;

    const isTimeout =
      err instanceof Error && err.name === 'TimeoutError';

    if (isTimeout) {
      throw new FirecrawlError(
        err.message,
        err
      );
    }

    throw new FirecrawlError(
      `Firecrawl request failed for URL: ${url} — ${(err as Error).message ?? err}`,
      err,
    );
  }
}
