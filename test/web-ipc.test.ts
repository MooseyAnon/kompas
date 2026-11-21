import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import type { Dispatcher } from '../src/main/ipc/dispatcher';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { AdapterRegistry } from '../src/main/modules/web/adapter-registry';
import type { WebAdapter } from '../src/main/modules/web/capabilities';
import { WebService } from '../src/main/modules/web/web.service';
import { WebError } from '../src/main/modules/web/web.error';
import { DDS_ADAPTER_ID } from '../src/main/modules/web/preferences';
import type {
  ResponseEnvelope,
  SearchResult,
  WebBrowsersListOutput,
} from '../src/shared/contracts';

let workDir: string;
let logFile: string;
let storage: Storage;
let telemetry: TelemetryService;

function buildDispatcher(adapters: WebAdapter[]): Dispatcher {
  const registry = new AdapterRegistry(adapters);
  const web = new WebService({ registry, telemetry });
  return createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry,
    web,
  });
}

function buildDispatcherWith(web: WebService): Dispatcher {
  return createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry,
    web,
  });
}

const PLAYWRIGHT_ID = 'playwright';

function readerAdapter(readPage: WebAdapter['readPage']): WebAdapter {
  return { id: PLAYWRIGHT_ID, capabilities: ['readPage'], readPage };
}

function okAdapter(results: SearchResult[]): WebAdapter {
  return {
    id: DDS_ADAPTER_ID,
    capabilities: ['search'],
    search: async () => results,
  };
}

async function send<T = unknown>(
  dispatcher: Dispatcher,
  action: string,
  payload: unknown,
  version = 1,
): Promise<ResponseEnvelope<T>> {
  return dispatcher.dispatch({
    requestId: crypto.randomUUID(),
    module: 'web',
    version,
    action,
    payload,
  }) as Promise<ResponseEnvelope<T>>;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-web-ipc-'));
  logFile = path.join(workDir, 'app.jsonl');
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(logFile),
  });
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('web.search IPC boundary', () => {
  it('cancels only the identified queued search through validated IPC', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queries: string[] = [];
    const web = new WebService({
      registry: new AdapterRegistry([
        {
          id: DDS_ADAPTER_ID,
          capabilities: ['search'],
          search: async (query) => {
            queries.push(query);
            if (query === 'first') await gate;
            return [];
          },
        },
      ]),
    });
    const dispatcher = buildDispatcherWith(web);
    const first = send(dispatcher, 'search', { query: 'first' });
    const searchId = crypto.randomUUID();
    const pending = send(dispatcher, 'search', { query: 'second', searchId });
    expect(
      await send(dispatcher, 'search.cancel', { searchId: 'not-an-id' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(
      await send(dispatcher, 'search.cancel', {
        searchId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true, data: { cancelled: false } });
    expect(await send(dispatcher, 'search.cancel', { searchId })).toMatchObject(
      { ok: true, data: { cancelled: true } },
    );
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    release();
    expect((await first).ok).toBe(true);
    expect(queries).toEqual(['first']);
  });
  it('returns normalized results for a valid query', async () => {
    const dispatcher = buildDispatcher([
      okAdapter([
        {
          title: 'Role',
          url: 'https://jobs.example/role',
          snippet: 's',
          rank: 1,
        },
      ]),
    ]);
    const res = await send(dispatcher, 'search', { query: 'engineer' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { providerId: string; results: unknown[] };
      expect(data.providerId).toBe(DDS_ADAPTER_ID);
      expect(data.results).toHaveLength(1);
    }
  });

  it('exposes web.search, web.readPage and web.browsers.list (no raw actions)', () => {
    const dispatcher = buildDispatcher([okAdapter([])]);
    for (const action of ['search', 'readPage', 'browsers.list']) {
      expect(dispatcher.has('web', action, 1)).toBe(true);
    }
    for (const action of ['open', 'fetch', 'executeSQL', 'navigate']) {
      expect(dispatcher.has('web', action, 1)).toBe(false);
    }
  });

  it('rejects a blank or missing query with INVALID_INPUT', async () => {
    const dispatcher = buildDispatcher([okAdapter([])]);
    for (const payload of [
      { query: '' },
      { query: '   ' },
      {},
      { foo: 'bar' },
    ]) {
      const res = await send(dispatcher, 'search', payload);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects an over-limit query with INVALID_INPUT', async () => {
    const dispatcher = buildDispatcher([okAdapter([])]);
    const res = await send(dispatcher, 'search', { query: 'x'.repeat(257) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_INPUT');
  });

  it('rejects an unsupported version', async () => {
    const dispatcher = buildDispatcher([okAdapter([])]);
    const res = await send(dispatcher, 'search', { query: 'x' }, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('VERSION_UNSUPPORTED');
  });

  it('converts a malformed adapter result into a safe INTERNAL error', async () => {
    // Adapter violates the result contract (non-http url, bad rank, giant snippet).
    const bad = buildDispatcher([
      okAdapter([
        {
          title: 'x',
          url: 'ftp://bad',
          rank: 0,
          snippet: 'y'.repeat(5000),
        } as never,
      ]),
    ]);
    const res = await send(bad, 'search', { query: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INTERNAL');
  });

  it('maps a provider failure to IO_ERROR and NO_CAPABLE_PROVIDER to NOT_FOUND', async () => {
    const failing = buildDispatcher([
      {
        id: DDS_ADAPTER_ID,
        capabilities: ['search'],
        search: async () => {
          throw new WebError('PROVIDER_FAILURE', { retryable: true });
        },
      },
    ]);
    const fail = await send(failing, 'search', { query: 'x' });
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.error.code).toBe('IO_ERROR');

    const none = buildDispatcher([]);
    const res = await send(none, 'search', { query: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('never writes the query, result URL or snippet to telemetry/logs', async () => {
    const QUERY = 'ZZSECRETQUERY';
    const URLSECRET = 'https://secret.example/WWSECRETPATH';
    const SNIP = 'VVSECRETSNIPPET';
    const dispatcher = buildDispatcher([
      okAdapter([{ title: 'T', url: URLSECRET, snippet: SNIP, rank: 1 }]),
    ]);
    await send(dispatcher, 'search', { query: QUERY });
    // A failing query too (records a failure run).
    await send(buildDispatcher([]), 'search', { query: `${QUERY}2` });

    const logText = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8')
      : '';
    const rows = JSON.stringify(
      storage.db.prepare('SELECT * FROM operation_runs').all(),
    );
    for (const secret of [QUERY, 'WWSECRETPATH', SNIP]) {
      expect(logText).not.toContain(secret);
      expect(rows).not.toContain(secret);
    }
    // Sanity: a web search run was actually recorded.
    expect(rows).toContain('"module_id":"web"');
    const searchDetails = storage.db
      .prepare(
        "SELECT detail_json FROM operation_runs WHERE module_id='web' AND outcome='success'",
      )
      .get() as { detail_json: string };
    const detail = JSON.parse(searchDetails.detail_json);
    expect(detail.queuedAttempts).toBe(1);
    // Even immediate dispatch can observe a millisecond of wall-clock wait.
    expect(detail.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(detail.queueWaitMs)).toBe(true);
  });
});

describe('web.readPage and web.browsers.list IPC boundary', () => {
  function readerService(
    readPage: WebAdapter['readPage'],
    browserInventory?: () => Promise<WebBrowsersListOutput>,
  ): WebService {
    const registry = new AdapterRegistry([readerAdapter(readPage)]);
    return new WebService({
      registry,
      telemetry,
      preferences: { search: [DDS_ADAPTER_ID], readPage: [PLAYWRIGHT_ID] },
      browserInventory,
    });
  }

  it('returns a validated PageReadResult for a public URL', async () => {
    const service = readerService(async (url) => ({
      requestedUrl: url,
      url,
      title: 'Doc',
      status: 200,
      html: '<html></html>',
      text: 'hello',
      providerId: PLAYWRIGHT_ID,
      browserId: 'chrome',
      truncated: { html: false, text: false },
    }));
    const res = await send(buildDispatcherWith(service), 'readPage', {
      url: 'https://example.org/docs',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { browserId: string; title: string };
      expect(data.browserId).toBe('chrome');
      expect(data.title).toBe('Doc');
    }
  });

  it('rejects a non-http readPage URL with INVALID_INPUT', async () => {
    const service = readerService(async () => {
      throw new Error('should not be called');
    });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'nope']) {
      const res = await send(buildDispatcherWith(service), 'readPage', { url });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects a loopback readPage URL in ordinary production IPC (no smoke exception)', async () => {
    // The adapter uses the default classifyReadUrl (allowLoopback: false here),
    // so a 127.0.0.1 target must be refused through the normal IPC path.
    const { createPlaywrightAdapter } =
      await import('../src/main/modules/web/adapters/playwright/playwright-adapter');
    const engine = {
      inventory: async () => ({ browsers: [] }),
      open: async () => {
        throw new Error('open must not be reached for a loopback URL');
      },
    };
    const pw = createPlaywrightAdapter({ engine });
    const registry = new AdapterRegistry([pw.adapter]);
    const service = new WebService({
      registry,
      telemetry,
      preferences: { search: [], readPage: [PLAYWRIGHT_ID] },
    });
    for (const url of [
      'http://127.0.0.1:8080/fixture',
      'http://localhost/fixture',
    ]) {
      const res = await send(buildDispatcherWith(service), 'readPage', { url });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('maps BROWSER_UNAVAILABLE to a safe IO_ERROR', async () => {
    const service = readerService(async () => {
      throw new WebError('BROWSER_UNAVAILABLE');
    });
    const res = await send(buildDispatcherWith(service), 'readPage', {
      url: 'https://example.org/',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('IO_ERROR');
  });

  it('lists browsers through the diagnostic action', async () => {
    const service = readerService(
      async () => {
        throw new WebError('BROWSER_UNAVAILABLE');
      },
      async () => ({
        browsers: [
          {
            id: 'chrome' as const,
            displayName: 'Google Chrome',
            detected: true,
            supported: true,
            launchVerified: true,
          },
          {
            id: 'safari' as const,
            displayName: 'Safari',
            detected: true,
            supported: false,
            launchVerified: null,
          },
        ],
        selectedId: 'chrome' as const,
      }),
    );
    const res = await send(buildDispatcherWith(service), 'browsers.list', {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as {
        browsers: unknown[];
        selectedId: string;
      };
      expect(data.selectedId).toBe('chrome');
      expect(data.browsers).toHaveLength(2);
    }
  });
});
