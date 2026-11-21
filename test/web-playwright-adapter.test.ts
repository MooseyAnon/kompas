import { describe, expect, it, vi } from 'vitest';
import type { PageReadResult } from '../src/shared/contracts';
import { WEB_LIMITS } from '../src/shared/contracts';
import { createPlaywrightAdapter } from '../src/main/modules/web/adapters/playwright/playwright-adapter';
import type {
  BrowserEngine,
  BrowserInventory,
  OpenPageOptions,
  PageHandle,
  SearchExtraction,
} from '../src/main/modules/web/adapters/playwright/types';
import type { CapabilityContext } from '../src/main/modules/web/capabilities';
import { isWebError, WebError } from '../src/main/modules/web/web.error';

/** Typed helpers over the capability-neutral (`Promise<unknown>`) adapter methods. */
function readPage(
  adapter: {
    readPage?: (url: string, ctx: CapabilityContext) => Promise<unknown>;
  },
  url: string,
  c: CapabilityContext,
): Promise<PageReadResult> {
  return adapter.readPage!(url, c) as Promise<PageReadResult>;
}

async function errorOf(promise: Promise<unknown>): Promise<WebError> {
  return promise.then(() => null).catch((e) => e) as Promise<WebError>;
}

interface FakePageSpec {
  browserId?: 'chrome' | 'msedge';
  finalUrl?: string;
  status?: number | null;
  title?: string;
  content?: string;
  visibleText?: string;
  extraction?: SearchExtraction;
}

function fakeEngine(spec: {
  page?: FakePageSpec;
  openError?: Error;
  inventory?: BrowserInventory;
  onOpen?: (url: string, options: OpenPageOptions) => void;
}): {
  engine: BrowserEngine;
  closed: () => number;
  lastOptions: () => OpenPageOptions | undefined;
} {
  let closedCount = 0;
  let lastOptions: OpenPageOptions | undefined;
  const engine: BrowserEngine = {
    async inventory() {
      return spec.inventory ?? { browsers: [] };
    },
    async open(url, options) {
      lastOptions = options;
      spec.onOpen?.(url, options);
      if (spec.openError) {
        throw spec.openError;
      }
      const p = spec.page ?? {};
      const handle: PageHandle = {
        browserId: p.browserId ?? 'chrome',
        requestedUrl: url,
        finalUrl: p.finalUrl ?? url,
        status: p.status ?? 200,
        title: async () => p.title ?? 'Title',
        content: async () => p.content ?? '<html></html>',
        visibleText: async () => p.visibleText ?? 'visible',
        extractSearch: async () =>
          p.extraction ?? { status: 'empty', items: [] },
        close: async () => {
          closedCount += 1;
        },
      };
      return handle;
    },
  };
  return {
    engine,
    closed: () => closedCount,
    lastOptions: () => lastOptions,
  };
}

function ctx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
    ...overrides,
  };
}

describe('Playwright adapter readPage', () => {
  it('returns a normalized PageReadResult and closes the page', async () => {
    const f = fakeEngine({
      page: {
        browserId: 'chrome',
        finalUrl: 'https://example.org/final',
        status: 200,
        title: 'Example',
        content: '<html><body>hi</body></html>',
        visibleText: 'hi there',
      },
    });
    const { adapter } = createPlaywrightAdapter({
      engine: f.engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    const result = await readPage(adapter, 'https://example.org/', ctx());
    expect(result).toMatchObject({
      requestedUrl: 'https://example.org/',
      url: 'https://example.org/final',
      title: 'Example',
      status: 200,
      html: '<html><body>hi</body></html>',
      text: 'hi there',
      providerId: 'playwright',
      browserId: 'chrome',
      truncated: { html: false, text: false },
    });
    expect(f.closed()).toBe(1);
    expect(f.lastOptions()?.settleMs).toBe(WEB_LIMITS.readPageRenderSettleMs);
  });

  it.each([0, 75])(
    'preserves the %i ms test override for reads and searches',
    async (settleMs) => {
      const f = fakeEngine({});
      const { adapter } = createPlaywrightAdapter({
        engine: f.engine,
        settleMs,
        validateReadUrl: async (url) => ({ ok: true, url }),
      });
      await readPage(adapter, 'https://example.org/', ctx());
      expect(f.lastOptions()?.settleMs).toBe(settleMs);
      await adapter.search!('role', ctx());
      expect(f.lastOptions()?.settleMs).toBe(settleMs);
    },
  );

  it.each(['CANCELLED', 'TIMEOUT'] as const)(
    'does not extract if opening finishes with %s',
    async (code) => {
      const controller = new AbortController();
      const context = ctx({ signal: controller.signal });
      const f = fakeEngine({});
      const page = await f.engine.open('https://example.org/', context);
      const title = vi.spyOn(page, 'title');
      const content = vi.spyOn(page, 'content');
      const visibleText = vi.spyOn(page, 'visibleText');
      vi.spyOn(f.engine, 'open').mockImplementation(async () => {
        if (code === 'CANCELLED') controller.abort();
        else context.deadline = Date.now();
        return page;
      });
      const { adapter } = createPlaywrightAdapter({
        engine: f.engine,
        validateReadUrl: async (url) => ({ ok: true, url }),
      });

      await expect(
        readPage(adapter, 'https://example.org/', context),
      ).rejects.toMatchObject({ code });
      expect(title).not.toHaveBeenCalled();
      expect(content).not.toHaveBeenCalled();
      expect(visibleText).not.toHaveBeenCalled();
      expect(f.closed()).toBe(1);
    },
  );

  it('truncates oversize html and text with honest flags', async () => {
    const bigHtml = 'x'.repeat(WEB_LIMITS.maxHtmlBytes + 500);
    const bigText = 'y'.repeat(WEB_LIMITS.maxTextChars + 500);
    const f = fakeEngine({ page: { content: bigHtml, visibleText: bigText } });
    const { adapter } = createPlaywrightAdapter({
      engine: f.engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    const result = await readPage(adapter, 'https://example.org/', ctx());
    expect(result.truncated).toEqual({ html: true, text: true });
    expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(
      WEB_LIMITS.maxHtmlBytes,
    );
    expect(result.text.length).toBe(WEB_LIMITS.maxTextChars);
  });

  it('rejects an unsafe URL before opening a browser', async () => {
    const f = fakeEngine({});
    const openSpy = vi.spyOn(f.engine, 'open');
    const { adapter } = createPlaywrightAdapter({
      engine: f.engine,
      validateReadUrl: async () => ({ ok: false, reason: 'PRIVATE_HOST' }),
    });
    const error = await errorOf(readPage(adapter, 'https://localhost/', ctx()));
    expect(isWebError(error)).toBe(true);
    expect(error.code).toBe('UNSAFE_URL');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('propagates BROWSER_UNAVAILABLE from the engine', async () => {
    const f = fakeEngine({ openError: new WebError('BROWSER_UNAVAILABLE') });
    const { adapter } = createPlaywrightAdapter({
      engine: f.engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    const error = await errorOf(
      readPage(adapter, 'https://example.org/', ctx()),
    );
    expect(error.code).toBe('BROWSER_UNAVAILABLE');
  });

  it('fails fast with TIMEOUT when the budget is already spent', async () => {
    const f = fakeEngine({});
    const { adapter } = createPlaywrightAdapter({
      engine: f.engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    const error = await errorOf(
      readPage(
        adapter,
        'https://example.org/',
        ctx({ deadline: Date.now() - 1 }),
      ),
    );
    expect(error.code).toBe('TIMEOUT');
  });

  it('fails with CANCELLED when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fakeEngine({});
    const { adapter } = createPlaywrightAdapter({
      engine: f.engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    const error = await errorOf(
      readPage(
        adapter,
        'https://example.org/',
        ctx({ signal: controller.signal }),
      ),
    );
    expect(error.code).toBe('CANCELLED');
  });

  it('only passes the loopback exception to the engine when explicitly enabled', async () => {
    const def = fakeEngine({});
    const { adapter: a1 } = createPlaywrightAdapter({
      engine: def.engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    await readPage(a1, 'https://example.org/', ctx());
    expect(def.lastOptions()?.allowLoopback).toBe(false);

    const loop = fakeEngine({});
    const { adapter: a2 } = createPlaywrightAdapter({
      engine: loop.engine,
      allowLoopback: true,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    await readPage(a2, 'http://127.0.0.1/', ctx());
    expect(loop.lastOptions()?.allowLoopback).toBe(true);
  });

  it('never grants the loopback exception to search (only readPage can)', async () => {
    const searcher = fakeEngine({
      page: { extraction: { status: 'empty', items: [] } },
    });
    // Even when the loopback smoke exception is enabled, search must not use it.
    const { adapter } = createPlaywrightAdapter({
      engine: searcher.engine,
      allowLoopback: true,
    });
    await adapter.search!('q', ctx());
    expect(searcher.lastOptions()?.allowLoopback).toBe(false);
  });
});

describe('Playwright adapter search', () => {
  it('normalizes extracted results (status ok)', async () => {
    const f = fakeEngine({
      page: {
        extraction: {
          status: 'ok',
          items: [{ title: 'Role', url: 'https://jobs.example/role' }],
        },
      },
    });
    const { adapter } = createPlaywrightAdapter({ engine: f.engine });
    const results = await adapter.search!('role', ctx());
    expect(f.lastOptions()?.settleMs).toBe(WEB_LIMITS.renderSettleMs);
    expect(results).toEqual([
      { title: 'Role', url: 'https://jobs.example/role', rank: 1 },
    ]);
    expect(f.closed()).toBe(1);
  });

  it('returns an empty array (no error) for a valid empty results page', async () => {
    const f = fakeEngine({
      page: { extraction: { status: 'empty', items: [] } },
    });
    const { adapter } = createPlaywrightAdapter({ engine: f.engine });
    expect(await adapter.search!('q', ctx())).toEqual([]);
  });

  it('raises a retryable PROVIDER_FAILURE on a layout change', async () => {
    const f = fakeEngine({
      page: { extraction: { status: 'layout', items: [] } },
    });
    const { adapter } = createPlaywrightAdapter({ engine: f.engine });
    const error = await errorOf(adapter.search!('q', ctx()));
    expect(error.code).toBe('PROVIDER_FAILURE');
    expect(error.retryable).toBe(true);
    expect(f.closed()).toBe(1);
  });

  it('raises NAVIGATION_FAILED (non-retryable) on a challenge wall', async () => {
    const f = fakeEngine({
      page: { extraction: { status: 'challenge', items: [] } },
    });
    const { adapter } = createPlaywrightAdapter({ engine: f.engine });
    const error = await errorOf(adapter.search!('q', ctx()));
    expect(error.code).toBe('NAVIGATION_FAILED');
    expect(error.retryable).toBe(false);
  });
});

describe('Playwright adapter inventory', () => {
  it('delegates browser inventory to the engine with launch verification', async () => {
    const inventory: BrowserInventory = {
      browsers: [
        {
          id: 'chrome',
          displayName: 'Google Chrome',
          detected: true,
          supported: true,
          launchVerified: true,
        },
      ],
      selectedId: 'chrome',
    };
    const f = fakeEngine({ inventory });
    const invSpy = vi.spyOn(f.engine, 'inventory');
    const pw = createPlaywrightAdapter({ engine: f.engine });
    expect(await pw.inventory()).toEqual(inventory);
    expect(invSpy).toHaveBeenCalledWith({ verifyLaunch: true });
  });
});
