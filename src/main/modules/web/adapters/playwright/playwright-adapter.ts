import {
  WEB_LIMITS,
  type PageReadResult,
  type SearchResult,
  type WebBrowserId,
} from '../../../../../shared/contracts';
import { classifyReadUrl, type ReadUrlSafety } from '../../url-safety';
import { PLAYWRIGHT_ADAPTER_ID } from '../../preferences';
import type { CapabilityContext, WebAdapter } from '../../capabilities';
import { WebError } from '../../web.error';
import { buildSearchUrl, normalizeSearchItems } from './search-strategy';
import type {
  BrowserEngine,
  BrowserInventory,
  OpenPageOptions,
  PageHandle,
  SearchExtraction,
} from './types';

type CappedText = { value: string; truncated: boolean };

const KNOWN_BROWSER_IDS: ReadonlySet<string> = new Set<WebBrowserId>([
  'chrome',
  'msedge',
  'firefox',
  'safari',
]);

export interface PlaywrightAdapterDeps {
  engine: BrowserEngine;
  /**
   * URL validator for `readPage`. Defaults to {@link classifyReadUrl}. Tests
   * and the packaged smoke harness inject a loopback-permitting validator; the
   * production composition never does.
   */
  validateReadUrl?: (url: string) => Promise<ReadUrlSafety>;
  /**
   * Smoke-only. When true, loopback request URLs are permitted for `readPage`
   * so a packaged test can read a local fixture. Never set on production IPC.
   */
  allowLoopback?: boolean;
  /** Render-settle override for reads and searches (tests); zero disables the wait. */
  settleMs?: number;
}

export interface PlaywrightAdapter {
  adapter: WebAdapter;
  /** Diagnostic browser inventory for `web.browsers.list`. */
  inventory(): Promise<BrowserInventory>;
}

/**
 * Playwright-backed adapter implementing **two** capabilities — `readPage` and
 * `search` — behind the same neutral {@link WebAdapter} contract. All browser
 * process concerns live in the injected {@link BrowserEngine}; this module owns
 * validation, bounded content caps, provenance and typed error mapping, and
 * never imports `playwright-core`.
 */
export function createPlaywrightAdapter(
  deps: PlaywrightAdapterDeps,
): PlaywrightAdapter {
  const { engine } = deps;
  const allowLoopback = deps.allowLoopback === true;
  const validateReadUrl =
    deps.validateReadUrl ??
    ((url: string) => classifyReadUrl(url, { allowLoopback }));

  const adapter: WebAdapter = {
    id: PLAYWRIGHT_ADAPTER_ID,
    capabilities: ['search', 'readPage'],

    async search(query, ctx) {
      throwIfCancelled(ctx);
      ensureBudget(ctx);

      const page = await engine.open(
        buildSearchUrl(query),
        openOptions(ctx, {
          loopback: false,
          settleMs: WEB_LIMITS.renderSettleMs,
        }),
      );
      try {
        return searchResults(await page.extractSearch());
      } finally {
        await safeClose(page);
      }
    },

    async readPage(url, ctx): Promise<PageReadResult> {
      throwIfCancelled(ctx);
      ensureBudget(ctx);

      const safety = await validateReadUrl(url);
      if (!safety.ok) {
        throw new WebError('UNSAFE_URL');
      }
      throwIfCancelled(ctx);

      const page = await engine.open(
        safety.url,
        openOptions(ctx, {
          loopback: allowLoopback,
          settleMs: WEB_LIMITS.readPageRenderSettleMs,
        }),
      );
      try {
        throwIfCancelled(ctx);
        ensureBudget(ctx);

        return await readSnapshot(page, url);
      } finally {
        await safeClose(page);
      }
    },
  };

  return {
    adapter,
    inventory: () => engine.inventory({ verifyLaunch: true }),
  };

  function openOptions(
    ctx: CapabilityContext,
    opts: { loopback: boolean; settleMs: number },
  ): OpenPageOptions {
    return {
      signal: ctx.signal,
      deadline: ctx.deadline,
      settleMs: deps.settleMs ?? opts.settleMs,
      allowLoopback: opts.loopback,
    };
  }
}

/** Map an extraction outcome to results or a typed (fallback-aware) error. */
function searchResults(extraction: SearchExtraction): SearchResult[] {
  switch (extraction.status) {
    case 'challenge':
      throw new WebError('NAVIGATION_FAILED');
    case 'layout':
      throw new WebError('PROVIDER_FAILURE', { retryable: true });
    case 'empty':
    case 'ok':
    default:
      return normalizeSearchItems(extraction.items);
  }
}

/** Read the rendered page and apply the bounded content caps. */
async function readSnapshot(
  page: PageHandle,
  requestedUrl: string,
): Promise<PageReadResult> {
  const [rawTitle, rawHtml, rawText] = await Promise.all([
    page.title(),
    page.content(),
    page.visibleText(),
  ]);
  const html = capBytes(rawHtml, WEB_LIMITS.maxHtmlBytes);
  const text = capChars(rawText, WEB_LIMITS.maxTextChars);

  return {
    requestedUrl,
    url: page.finalUrl,
    title: (rawTitle ?? '').slice(0, WEB_LIMITS.maxPageTitleChars),
    status: page.status,
    html: html.value,
    text: text.value,
    providerId: PLAYWRIGHT_ADAPTER_ID,
    browserId: sanitizeBrowserId(page.browserId),
    truncated: { html: html.truncated, text: text.truncated },
  };
}

function throwIfCancelled(ctx: CapabilityContext): void {
  if (ctx.signal.aborted) {
    throw new WebError('CANCELLED');
  }
}

function ensureBudget(ctx: CapabilityContext): void {
  if (ctx.deadline - Date.now() <= 0) {
    throw new WebError('TIMEOUT');
  }
}

async function safeClose(page: PageHandle): Promise<void> {
  try {
    await page.close();
  } catch {
    // Cleanup failures are swallowed; the engine also guards process teardown.
  }
}

/** Only known ids cross the boundary; defend against an unexpected engine value. */
function sanitizeBrowserId(id: string): WebBrowserId {
  return isKnownBrowserId(id) ? id : 'chrome';
}

function isKnownBrowserId(id: string): id is WebBrowserId {
  return KNOWN_BROWSER_IDS.has(id);
}

function capBytes(value: string, maxBytes: number): CappedText {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { value, truncated: false };
  }

  // Trim to the byte budget without splitting a multi-byte character.
  const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  return { value: buf.toString('utf8'), truncated: true };
}

function capChars(value: string, maxChars: number): CappedText {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars), truncated: true };
}
