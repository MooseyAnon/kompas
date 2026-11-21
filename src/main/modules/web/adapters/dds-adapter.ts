import { search as ddgSearch, SafeSearchType } from 'duck-duck-scrape';
import type { SearchResult } from '../../../../shared/contracts';
import { isHttpUrl, WEB_LIMITS } from '../../../../shared/contracts';
import type { CapabilityContext, WebAdapter } from '../capabilities';
import { DDS_ADAPTER_ID } from '../preferences';
import { isWebError, WebError } from '../web.error';

type DdsSearch = typeof ddgSearch;

type DdsResponse = Awaited<ReturnType<DdsSearch>>;

/** Upstream message fragments that indicate rate limiting / anomaly blocking. */
const RATE_LIMIT_MARKERS = [
  'anomaly',
  'rate limit',
  '429',
  'too many requests',
];

/**
 * App-controlled default request headers for the search provider. These are
 * **not** renderer- or user-controlled (the public `web.search` input is only a
 * query): they present a realistic, stable desktop browser identity so the
 * upstream endpoint is less likely to reject the request as an automated
 * anomaly. Because our adapter always supplies `needleOptions`, these also
 * replace the library's own defaults (which `duck-duck-scrape` otherwise drops
 * for its VQD request as soon as any options object is passed).
 */
export const DEFAULT_SEARCH_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="129", "Not=A?Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

export interface DdsAdapterOptions {
  /** Injectable search fn so tests exercise mapping/classification without network. */
  searchFn?: DdsSearch;
  /**
   * Override the app-controlled request headers. Not reachable from the
   * renderer; used by composition/tests only.
   */
  headers?: Record<string, string>;
}

/**
 * Search adapter backed by the `duck-duck-scrape` TypeScript library. This is
 * the *only* place the library is imported. It normalizes provider results into
 * the neutral {@link SearchResult} shape and translates upstream failures into
 * typed {@link WebError}s — never claiming success with zero results when
 * extraction actually failed.
 */
export function createDdsSearchAdapter(
  options: DdsAdapterOptions = {},
): WebAdapter {
  const searchFn = options.searchFn ?? ddgSearch;
  const headers = options.headers ?? DEFAULT_SEARCH_HEADERS;

  return {
    id: DDS_ADAPTER_ID,
    capabilities: ['search'],
    async search(
      query: string,
      ctx: CapabilityContext,
    ): Promise<SearchResult[]> {
      throwIfCancelled(ctx);
      const remaining = ctx.deadline - Date.now();
      if (remaining <= 0) {
        throw new WebError('TIMEOUT');
      }

      const raw = await runSearch(query, ctx, remaining);

      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.results)) {
        // Shape we cannot trust: treat as an extraction/parser failure, not empty.
        throw new WebError('PROVIDER_FAILURE', { retryable: true });
      }

      if (raw.noResults === true) {
        return [];
      }

      return normalizeResults(raw.results);
    },
  };

  /** Call the provider within budget, translating failures to WebErrors. */
  async function runSearch(
    query: string,
    ctx: CapabilityContext,
    remaining: number,
  ): Promise<DdsResponse> {
    const request = searchFn(
      query,
      { safeSearch: SafeSearchType.MODERATE },
      {
        response_timeout: remaining,
        open_timeout: remaining,
        headers: { ...headers },
      },
    );

    try {
      return await withBudget(request, ctx, remaining);
    } catch (error) {
      if (isWebError(error)) {
        throw error;
      }

      throw classifyError(error);
    }
  }
}

function normalizeResults(
  rawResults: ReadonlyArray<{
    title?: unknown;
    url?: unknown;
    description?: unknown;
  }>,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of rawResults) {
    if (results.length >= WEB_LIMITS.maxResults) {
      break;
    }

    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!isHttpUrl(url) || url.length > WEB_LIMITS.maxUrlChars) {
      continue;
    }
    const title = stripHtml(asString(entry.title)).slice(
      0,
      WEB_LIMITS.maxTitleChars,
    );
    if (title.length === 0) {
      continue;
    }

    const snippetText = stripHtml(asString(entry.description)).slice(
      0,
      WEB_LIMITS.maxSnippetChars,
    );

    const result: SearchResult = {
      title,
      url,
      rank: results.length + 1,
    };
    if (snippetText.length > 0) {
      result.snippet = snippetText;
    }
    results.push(result);
  }
  return results;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Remove HTML tags (e.g. DDG's `<b>` highlights) and collapse whitespace. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyError(error: unknown): WebError {
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  if (message.includes('query cannot be empty')) {
    return new WebError('INVALID_INPUT');
  }

  if (RATE_LIMIT_MARKERS.some((marker) => message.includes(marker))) {
    return new WebError('RATE_LIMITED', { retryable: true });
  }

  // Provider-level timeouts, network errors and parser/VQD mismatches are all
  // retryable provider failures; the resolver's deadline still bounds time.
  return new WebError('PROVIDER_FAILURE', { retryable: true });
}

/**
 * Race a provider promise against cancellation and the remaining time budget.
 * On cancel/timeout the in-flight request is abandoned (result ignored); the
 * underlying library has no AbortSignal hook, which we document honestly.
 */
function withBudget<T>(
  promise: Promise<T>,
  ctx: CapabilityContext,
  remainingMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => finish(() => reject(new WebError('CANCELLED')));
    const timer = setTimeout(
      () => finish(() => reject(new WebError('TIMEOUT'))),
      Math.max(0, remainingMs),
    );
    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    };

    ctx.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function throwIfCancelled(ctx: CapabilityContext): void {
  if (ctx.signal.aborted) {
    throw new WebError('CANCELLED');
  }
}
