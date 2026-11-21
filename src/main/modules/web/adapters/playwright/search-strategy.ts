import type { SearchResult } from '../../../../../shared/contracts';
import { isHttpUrl, WEB_LIMITS } from '../../../../../shared/contracts';
import type { RawSearchItem, SearchExtraction } from './types';

/**
 * Versioned, DuckDuckGo-first browser-search strategy for the Playwright
 * adapter. The engine loads {@link buildSearchUrl}, waits for render, then runs
 * {@link DUCKDUCKGO_EXTRACTION} in the page. The DOM shape of a search engine
 * changes over time, so the extraction is versioned and a missing results
 * region is reported as a `layout` outcome (retryable), never a silent empty.
 *
 * DuckDuckGo is chosen as the default engine: it needs no account, exposes a
 * stable `?q=` query, and (unlike some engines) does not obfuscate result
 * links behind opaque redirectors on the rendered page. If a different browser
 * defaults to another engine, the installed browser follows that engine's own
 * redirects; we only control the URL we navigate to, which is DuckDuckGo here.
 */
export const SEARCH_ENGINE_ID = 'duckduckgo';
export const SEARCH_STRATEGY_VERSION = 1;

/**
 * Selector that signals the results view is ready. For the results case this
 * targets the result **title anchor** (not just its container), so extraction
 * never runs against a half-rendered result whose link/title are not yet
 * populated. It also matches the explicit no-results and challenge views. The
 * engine waits (bounded) for this before running {@link DUCKDUCKGO_EXTRACTION},
 * because the SPA fetches results via XHR after `domcontentloaded`.
 */
export const SEARCH_READY_SELECTOR =
  'a[data-testid="result-title-a"], a.result__a, ' +
  '[data-testid="no-results"], #challenge-form, .anomaly-modal__title';

/**
 * Build the DuckDuckGo results URL. Mirrors a real browser query
 * (`https://duckduckgo.com/?t=ffab&q=...&ia=web`); `t=ffab` is a stable,
 * non-identifying source tag and `ia=web` requests the web results tab.
 */
export function buildSearchUrl(query: string): string {
  const url = new URL('https://duckduckgo.com/');
  url.searchParams.set('t', 'ffab');
  url.searchParams.set('q', query);
  url.searchParams.set('ia', 'web');
  return url.toString();
}

/**
 * In-page extraction executed via `page.evaluate`. Must be fully self-contained
 * (no external references) because Playwright serializes it into the browser.
 * It reads the rendered result DOM and reports a coarse status so the adapter
 * can distinguish a genuine empty page from a challenge wall or a layout change.
 */
export function DUCKDUCKGO_EXTRACTION(): SearchExtraction {
  const text = (document.body?.innerText ?? '').toLowerCase();
  const challengePattern = new RegExp(
    'unfortunately, bots use duckduckgo too|verify you are human|' +
      'are you a robot|detected unusual|challenge-platform',
  );
  const challenged = challengePattern.test(text);

  const nodes = Array.from(
    document.querySelectorAll(
      'article[data-testid="result"], li[data-layout="organic"], ' +
        'div.result__body',
    ),
  );

  if (nodes.length === 0) {
    const explicitlyEmpty =
      document.querySelector('[data-testid="no-results"]') !== null ||
      /no results found|no web results/.test(text);
    if (challenged) {
      return { status: 'challenge', items: [] };
    }
    return { status: explicitlyEmpty ? 'empty' : 'layout', items: [] };
  }

  const items: RawSearchItem[] = [];
  for (const node of nodes) {
    const anchor =
      node.querySelector<HTMLAnchorElement>(
        'a[data-testid="result-title-a"]',
      ) ?? node.querySelector<HTMLAnchorElement>('a.result__a');
    if (!anchor) {
      continue;
    }
    const url = anchor.getAttribute('href') ?? '';
    const title = (anchor.textContent ?? '').trim();
    const snippetEl = node.querySelector(
      '[data-result="snippet"], [data-testid="result-snippet"], ' +
        '.result__snippet',
    );
    const snippet = (snippetEl?.textContent ?? '').trim();
    if (url && title) {
      items.push(snippet ? { title, url, snippet } : { title, url });
    }
  }

  return { status: items.length > 0 ? 'ok' : 'empty', items };
}

/**
 * Normalize raw scraped items into neutral {@link SearchResult}s: unwrap
 * DuckDuckGo `l/?uddg=` redirector links, resolve protocol-relative URLs, drop
 * non-http(s) and over-length links, strip markup/whitespace, de-duplicate by
 * URL, cap the count and assign a dense 1-based rank.
 */
export function normalizeSearchItems(items: RawSearchItem[]): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (results.length >= WEB_LIMITS.maxResults) {
      break;
    }

    const url = resolveResultUrl(item.url);
    if (!url || url.length > WEB_LIMITS.maxUrlChars || seen.has(url)) {
      continue;
    }
    const title = clean(item.title).slice(0, WEB_LIMITS.maxTitleChars);
    if (title.length === 0) {
      continue;
    }

    seen.add(url);
    const snippet = clean(item.snippet ?? '').slice(
      0,
      WEB_LIMITS.maxSnippetChars,
    );
    const result: SearchResult = { title, url, rank: results.length + 1 };
    if (snippet.length > 0) {
      result.snippet = snippet;
    }
    results.push(result);
  }

  return results;
}

/** Resolve a rendered result href to an absolute public http(s) URL, or ''. */
function resolveResultUrl(raw: string): string {
  let href = raw.trim();
  if (href.length === 0) {
    return '';
  }

  // Protocol-relative (`//duckduckgo.com/l/?uddg=...`).
  if (href.startsWith('//')) {
    href = `https:${href}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return '';
  }

  // Unwrap DuckDuckGo's redirector to the real target.
  if (
    /(^|\.)duckduckgo\.com$/.test(parsed.hostname) &&
    parsed.pathname === '/l/'
  ) {
    const target = parsed.searchParams.get('uddg');
    if (target) {
      try {
        parsed = new URL(target);
      } catch {
        return '';
      }
    }
  }

  const out = parsed.toString();
  return isHttpUrl(out) ? out : '';
}

/** Strip any residual markup and collapse whitespace. */
function clean(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
