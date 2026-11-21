import { describe, expect, it } from 'vitest';
import type {
  PageReadResult,
  SearchResult,
  WebCapability,
} from '../src/shared/contracts';
import { AdapterRegistry } from '../src/main/modules/web/adapter-registry';
import { CAPABILITY_PREFERENCES } from '../src/main/modules/web/preferences';
import type { WebAdapter } from '../src/main/modules/web/capabilities';
import { WebService } from '../src/main/modules/web/web.service';
import { WebError } from '../src/main/modules/web/web.error';
import type { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import type { RecordRunInput } from '../src/main/modules/telemetry/telemetry.service';

function recorder() {
  const runs: RecordRunInput[] = [];
  const telemetry = {
    record: (input: RecordRunInput) => runs.push(input),
  } as unknown as TelemetryService;
  return { runs, telemetry };
}

function adapter(
  id: string,
  impl: Partial<Pick<WebAdapter, 'search' | 'isAvailable'>>,
): WebAdapter {
  return {
    id,
    capabilities: ['search'],
    search: impl.search ?? (async () => []),
    isAvailable: impl.isAvailable,
  };
}

const prefs = (order: string[]): Record<WebCapability, readonly string[]> => ({
  search: order,
  readPage: [],
});

const result = (
  title: string,
  url: string,
  snippet?: string,
): SearchResult => ({
  title,
  url,
  rank: 1,
  ...(snippet ? { snippet } : {}),
});

describe('WebService.search', () => {
  it('returns normalized results with the actual provider and safe telemetry', async () => {
    const { runs, telemetry } = recorder();
    const registry = new AdapterRegistry([
      adapter('dds', {
        search: async () => [result('T', 'https://e.com/a', 'snip')],
      }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: prefs(['dds']),
    });

    const out = await service.search('hello');
    expect(out.providerId).toBe('dds');
    expect(out.results).toHaveLength(1);
    expect(out.attempts).toEqual([{ providerId: 'dds', outcome: 'ok' }]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      moduleId: 'web',
      operation: 'search',
      outcome: 'success',
      detail: { adapterId: 'dds', resultCount: 1, attempts: 1, retries: 0 },
    });
  });

  it('never records the query or result content in telemetry (privacy canary)', async () => {
    const QUERY = 'ZZSECRETQUERY';
    const TITLE = 'QQSECRETTITLE';
    const URLSECRET = 'https://secret.example/WWSECRETPATH';
    const SNIP = 'VVSECRETSNIPPET';
    const { runs, telemetry } = recorder();
    const registry = new AdapterRegistry([
      adapter('dds', { search: async () => [result(TITLE, URLSECRET, SNIP)] }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: prefs(['dds']),
    });

    await service.search(QUERY);
    const serialized = JSON.stringify(runs);
    for (const secret of [QUERY, TITLE, 'WWSECRETPATH', SNIP]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('changes the chosen provider when preferences are reordered (caller unchanged)', async () => {
    const registry = new AdapterRegistry([
      adapter('a', { search: async () => [result('A', 'https://a.com')] }),
      adapter('b', { search: async () => [result('B', 'https://b.com')] }),
    ]);
    const first = new WebService({ registry, preferences: prefs(['a', 'b']) });
    const second = new WebService({ registry, preferences: prefs(['b', 'a']) });
    expect((await first.search('q')).providerId).toBe('a');
    expect((await second.search('q')).providerId).toBe('b');
  });

  it('reports a valid empty result as empty provenance without fallback', async () => {
    const { runs, telemetry } = recorder();
    const registry = new AdapterRegistry([
      adapter('a', { search: async () => [] }),
      adapter('b', { search: async () => [result('B', 'https://b.com')] }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: prefs(['a', 'b']),
    });

    const out = await service.search('q');
    expect(out.providerId).toBe('a');
    expect(out.results).toEqual([]);
    expect(out.attempts).toEqual([{ providerId: 'a', outcome: 'empty' }]);
    expect(runs[0].detail).toMatchObject({ resultCount: 0 });
    expect(runs[0].outcome).toBe('success');
  });

  it('rejects a blank query with INVALID_INPUT and records a failure', async () => {
    const { runs, telemetry } = recorder();
    const registry = new AdapterRegistry([
      adapter('a', { search: async () => [result('A', 'https://a.com')] }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: prefs(['a']),
    });

    const error = await service
      .search('   ')
      .then(() => null)
      .catch((e) => e);
    expect(error).toBeInstanceOf(WebError);
    expect(error.code).toBe('INVALID_INPUT');
    expect(runs[0]).toMatchObject({
      outcome: 'failure',
      errorCode: 'INVALID_INPUT',
    });
  });

  it('records a cancellation distinctly', async () => {
    const { runs, telemetry } = recorder();
    const controller = new AbortController();
    controller.abort();
    const registry = new AdapterRegistry([
      adapter('a', { search: async () => [result('A', 'https://a.com')] }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: prefs(['a']),
    });

    const error = await service
      .search('q', { signal: controller.signal })
      .then(() => null)
      .catch((e) => e);
    expect(error.code).toBe('CANCELLED');
    expect(runs[0].outcome).toBe('cancelled');
  });

  it('surfaces a provider failure and records its code', async () => {
    const { runs, telemetry } = recorder();
    const registry = new AdapterRegistry([
      adapter('a', {
        search: async () => {
          throw new WebError('RATE_LIMITED', { retryable: true });
        },
      }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: prefs(['a']),
    });

    const error = await service
      .search('q')
      .then(() => null)
      .catch((e) => e);
    expect(error.code).toBe('RATE_LIMITED');
    expect(runs[0]).toMatchObject({
      outcome: 'failure',
      errorCode: 'RATE_LIMITED',
      detail: { adapterId: 'a', retries: 0 },
    });
  });
});

const pageResult = (
  overrides: Partial<PageReadResult> = {},
): PageReadResult => ({
  requestedUrl: 'https://example.org/',
  url: 'https://example.org/',
  title: 'Example',
  status: 200,
  html: '<html></html>',
  text: 'text',
  providerId: 'playwright',
  browserId: 'chrome',
  truncated: { html: false, text: false },
  ...overrides,
});

function searchAndReadAdapter(
  id: string,
  impl: {
    search?: WebAdapter['search'];
    readPage?: WebAdapter['readPage'];
  },
): WebAdapter {
  const capabilities: WebCapability[] = [];
  if (impl.search) capabilities.push('search');
  if (impl.readPage) capabilities.push('readPage');
  return { id, capabilities, ...impl };
}

describe('WebService.readPage', () => {
  it('normalizes any reader after acquisition and keeps raw output on parse failure', async () => {
    const { runs, telemetry } = recorder();
    const html =
      '<main><h1>Generic</h1><p>Reader text</p><script>PRIVATE_JS_CANARY</script></main>';
    const registry = new AdapterRegistry([
      searchAndReadAdapter('generic-reader', {
        readPage: async () =>
          pageResult({ html, providerId: 'generic-reader' }),
      }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: { search: [], readPage: ['generic-reader'] },
    });
    const success = await service.readPage('https://example.org/');
    expect(success.structured?.content.blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
    ]);
    expect(success.html).toBe(html);
    expect(JSON.stringify(runs)).not.toContain('PRIVATE_JS_CANARY');
    const badRegistry = new AdapterRegistry([
      searchAndReadAdapter('generic-reader', {
        readPage: async () => pageResult({ html: '', text: 'still readable' }),
      }),
    ]);
    const bad = await new WebService({
      registry: badRegistry,
      preferences: { search: [], readPage: ['generic-reader'] },
    }).readPage('https://example.org/');
    expect(bad).toMatchObject({
      html: '',
      text: 'still readable',
      structureError: 'EXTRACTION_FAILED',
    });
    expect(bad.structured).toBeUndefined();
  });
  it('returns the reader result and records safe telemetry (no URL/content)', async () => {
    const { runs, telemetry } = recorder();
    const SECRET = 'SECRETPATH12345';
    const registry = new AdapterRegistry([
      searchAndReadAdapter('playwright', {
        readPage: async () =>
          pageResult({
            requestedUrl: `https://example.org/${SECRET}`,
            url: `https://example.org/${SECRET}`,
            html: `<html>${SECRET}</html>`,
            text: SECRET,
          }),
      }),
    ]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: { search: [], readPage: ['playwright'] },
    });

    const out = await service.readPage(`https://example.org/${SECRET}`);
    expect(out.providerId).toBe('playwright');
    expect(out.browserId).toBe('chrome');

    expect(runs[0]).toMatchObject({
      moduleId: 'web',
      operation: 'readPage',
      outcome: 'success',
      detail: { adapterId: 'playwright', browserId: 'chrome', status: 200 },
    });
    expect(JSON.stringify(runs)).not.toContain(SECRET);
  });

  it('rejects an invalid URL with INVALID_INPUT before touching an adapter', async () => {
    const registry = new AdapterRegistry([
      searchAndReadAdapter('playwright', {
        readPage: async () => pageResult(),
      }),
    ]);
    const service = new WebService({
      registry,
      preferences: { search: [], readPage: ['playwright'] },
    });
    const error = await service
      .readPage('not-a-url')
      .then(() => null)
      .catch((e) => e);
    expect(error.code).toBe('INVALID_INPUT');
  });

  it.each([
    'BROWSER_UNAVAILABLE',
    'TIMEOUT',
    'CANCELLED',
    'NAVIGATION_FAILED',
  ] as const)('propagates %s from the reader adapter', async (code) => {
    const registry = new AdapterRegistry([
      searchAndReadAdapter('playwright', {
        readPage: async () => {
          throw new WebError(code);
        },
      }),
    ]);
    const service = new WebService({
      registry,
      preferences: { search: [], readPage: ['playwright'] },
    });
    const error = await service
      .readPage('https://example.org/')
      .then(() => null)
      .catch((e) => e);
    expect(error.code).toBe(code);
  });
});

describe('WebService search fallback across two real adapters', () => {
  it('falls back from a retryable DDS failure to the Playwright adapter', async () => {
    const registry = new AdapterRegistry([
      searchAndReadAdapter('duck-duck-scrape', {
        search: async () => {
          throw new WebError('PROVIDER_FAILURE', { retryable: true });
        },
      }),
      searchAndReadAdapter('playwright', {
        search: async () => [result('From Browser', 'https://b.example/r')],
        readPage: async () => pageResult(),
      }),
    ]);
    const service = new WebService({
      registry,
      searchPolicy: {
        minGapMs: 0,
        maxGapMs: 0,
        maxQueued: 32,
        maxWaitMs: 600_000,
        attemptTimeoutMs: 20_000,
      },
      preferences: {
        search: ['duck-duck-scrape', 'playwright'],
        readPage: ['playwright'],
      },
    });
    const out = await service.search('q');
    expect(out.providerId).toBe('playwright');
    expect(out.results).toHaveLength(1);
    expect(out.attempts).toEqual([
      {
        providerId: 'duck-duck-scrape',
        outcome: 'retryable',
        errorCode: 'PROVIDER_FAILURE',
      },
      { providerId: 'playwright', outcome: 'ok' },
    ]);
  });

  it('does NOT fall back when DDS returns a valid empty result', async () => {
    let playwrightCalled = false;
    const registry = new AdapterRegistry([
      searchAndReadAdapter('duck-duck-scrape', { search: async () => [] }),
      searchAndReadAdapter('playwright', {
        search: async () => {
          playwrightCalled = true;
          return [result('X', 'https://x.example/')];
        },
        readPage: async () => pageResult(),
      }),
    ]);
    const service = new WebService({
      registry,
      preferences: {
        search: ['duck-duck-scrape', 'playwright'],
        readPage: ['playwright'],
      },
    });
    const out = await service.search('q');
    expect(out.providerId).toBe('duck-duck-scrape');
    expect(out.results).toEqual([]);
    expect(playwrightCalled).toBe(false);
  });

  it('prefers Playwright, then falls back to DDS when no browser is installed', async () => {
    const registry = new AdapterRegistry([
      searchAndReadAdapter('duck-duck-scrape', {
        search: async () => [result('From DDS', 'https://dds.example/r')],
      }),
      searchAndReadAdapter('playwright', {
        search: async () => {
          throw new WebError('BROWSER_UNAVAILABLE');
        },
        readPage: async () => pageResult(),
      }),
    ]);
    const service = new WebService({
      registry,
      searchPolicy: {
        minGapMs: 0,
        maxGapMs: 0,
        maxQueued: 32,
        maxWaitMs: 600_000,
        attemptTimeoutMs: 20_000,
      },
      preferences: {
        search: ['playwright', 'duck-duck-scrape'],
        readPage: ['playwright'],
      },
    });
    const out = await service.search('q');
    expect(out.providerId).toBe('duck-duck-scrape');
    expect(out.results).toHaveLength(1);
    expect(out.attempts).toEqual([
      {
        providerId: 'playwright',
        outcome: 'retryable',
        errorCode: 'BROWSER_UNAVAILABLE',
      },
      { providerId: 'duck-duck-scrape', outcome: 'ok' },
    ]);
  });

  it('uses the browser-backed Playwright search first by default policy', async () => {
    expect(CAPABILITY_PREFERENCES.search[0]).toBe('playwright');
    expect(CAPABILITY_PREFERENCES.search).toContain('duck-duck-scrape');
    const registry = new AdapterRegistry([
      searchAndReadAdapter('duck-duck-scrape', {
        search: async () => [result('From DDS', 'https://dds.example/r')],
      }),
      searchAndReadAdapter('playwright', {
        search: async () => [result('From Browser', 'https://b.example/r')],
        readPage: async () => pageResult(),
      }),
    ]);
    // No explicit preferences => the central default policy is used.
    const service = new WebService({ registry });
    const out = await service.search('q');
    expect(out.providerId).toBe('playwright');
  });
});

describe('WebService.listBrowsers', () => {
  it('returns an empty inventory when no reader is wired', async () => {
    const service = new WebService({ registry: new AdapterRegistry([]) });
    expect(await service.listBrowsers()).toEqual({ browsers: [] });
  });

  it('delegates to the injected browser inventory', async () => {
    const service = new WebService({
      registry: new AdapterRegistry([]),
      browserInventory: async () => ({
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
      }),
    });
    const out = await service.listBrowsers();
    expect(out.selectedId).toBe('chrome');
    expect(out.browsers).toHaveLength(1);
  });
});
