import { describe, expect, it } from 'vitest';
import {
  createDdsSearchAdapter,
  DEFAULT_SEARCH_HEADERS,
} from '../src/main/modules/web/adapters/dds-adapter';
import type { CapabilityContext } from '../src/main/modules/web/capabilities';
import { isWebError } from '../src/main/modules/web/web.error';

function ctx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 5000,
    ...overrides,
  };
}

// Minimal DDS-shaped fixture (fields the adapter reads).
function ddsResult(partial: Record<string, unknown>) {
  return {
    hostname: 'example.com',
    url: 'https://example.com',
    title: 'Title',
    description: 'Description',
    rawDescription: 'Description',
    icon: '',
    ...partial,
  };
}

async function callError(adapter: ReturnType<typeof createDdsSearchAdapter>) {
  return adapter.search!('query', ctx())
    .then(() => null)
    .catch((e) => e);
}

describe('duck-duck-scrape adapter', () => {
  it('normalizes title/url/snippet/rank and strips highlight tags', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () =>
        ({
          noResults: false,
          vqd: 'x',
          results: [
            ddsResult({
              title: 'GPU <b>Engineer</b>',
              url: 'https://jobs.example.org/gpu',
              description: 'Great <b>role</b>   with   spacing',
            }),
            ddsResult({
              title: 'Second',
              url: 'http://example.net/2',
              description: '',
            }),
          ],
        }) as never,
    });

    const results = await adapter.search!('gpu', ctx());
    expect(results).toEqual([
      {
        title: 'GPU Engineer',
        url: 'https://jobs.example.org/gpu',
        snippet: 'Great role with spacing',
        rank: 1,
      },
      { title: 'Second', url: 'http://example.net/2', rank: 2 },
    ]);
  });

  it('drops results with non-http(s) or missing titles and reranks', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () =>
        ({
          noResults: false,
          vqd: 'x',
          results: [
            ddsResult({ url: 'javascript:alert(1)', title: 'Bad' }),
            ddsResult({ url: 'https://ok.example/a', title: '' }),
            ddsResult({
              url: 'https://ok.example/b',
              title: 'Good',
              description: '',
            }),
          ],
        }) as never,
    });

    const results = await adapter.search!('q', ctx());
    expect(results).toEqual([
      { title: 'Good', url: 'https://ok.example/b', rank: 1 },
    ]);
  });

  it('returns an empty array for a valid noResults response', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () =>
        ({ noResults: true, vqd: 'x', results: [] }) as never,
    });
    expect(await adapter.search!('q', ctx())).toEqual([]);
  });

  it('treats a malformed provider shape as a provider failure, not empty', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () => ({ weird: true }) as never,
    });
    const error = await callError(adapter);
    expect(isWebError(error)).toBe(true);
    expect(error.code).toBe('PROVIDER_FAILURE');
    expect(error.retryable).toBe(true);
  });

  it('classifies an empty-query library error as INVALID_INPUT (non-retryable)', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () => {
        throw new Error('Query cannot be empty!');
      },
    });
    const error = await callError(adapter);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.retryable).toBe(false);
  });

  it('classifies an anomaly/rate-limit error as RATE_LIMITED (retryable)', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () => {
        throw new Error('A spam/anomaly was detected (429)');
      },
    });
    const error = await callError(adapter);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryable).toBe(true);
  });

  it('classifies a network error as a retryable provider failure', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () => {
        const err = new Error('getaddrinfo ENOTFOUND') as Error & {
          code?: string;
        };
        err.code = 'ENOTFOUND';
        throw err;
      },
    });
    const error = await callError(adapter);
    expect(error.code).toBe('PROVIDER_FAILURE');
    expect(error.retryable).toBe(true);
  });

  it('fails with TIMEOUT when the budget is already exhausted', async () => {
    const adapter = createDdsSearchAdapter({
      searchFn: async () => ({}) as never,
    });
    const error = await adapter.search!('q', ctx({ deadline: Date.now() - 1 }))
      .then(() => null)
      .catch((e) => e);
    expect(error.code).toBe('TIMEOUT');
  });

  it('rejects with CANCELLED when the signal aborts in flight', async () => {
    const controller = new AbortController();
    const adapter = createDdsSearchAdapter({
      searchFn: () => new Promise(() => {}) as never, // never settles
    });
    const promise = adapter.search!('q', ctx({ signal: controller.signal }));
    controller.abort();
    const error = await promise.then(() => null).catch((e) => e);
    expect(error.code).toBe('CANCELLED');
  });

  it('does not leak raw upstream messages in the typed error', async () => {
    const secret = 'RAWUPSTREAMSECRET';
    const adapter = createDdsSearchAdapter({
      searchFn: async () => {
        throw new Error(secret);
      },
    });
    const error = await callError(adapter);
    expect(error.message).not.toContain(secret);
  });

  it('forwards app-controlled headers and time budget to the provider request', async () => {
    const calls: unknown[][] = [];
    const adapter = createDdsSearchAdapter({
      searchFn: (async (...args: unknown[]) => {
        calls.push(args);
        return { noResults: true, vqd: 'x', results: [] };
      }) as never,
    });

    await adapter.search!('q', ctx());
    expect(calls).toHaveLength(1);
    const needleOptions = calls[0][2] as {
      headers?: Record<string, string>;
      response_timeout?: number;
      open_timeout?: number;
    };
    expect(needleOptions.headers).toMatchObject(DEFAULT_SEARCH_HEADERS);
    expect(needleOptions.headers?.['User-Agent']).toContain('Chrome/');
    expect(typeof needleOptions.response_timeout).toBe('number');
    expect(typeof needleOptions.open_timeout).toBe('number');
  });

  it('lets composition override the request headers', async () => {
    const calls: unknown[][] = [];
    const adapter = createDdsSearchAdapter({
      headers: { 'User-Agent': 'Custom/1.0' },
      searchFn: (async (...args: unknown[]) => {
        calls.push(args);
        return { noResults: true, vqd: 'x', results: [] };
      }) as never,
    });

    await adapter.search!('q', ctx());
    const needleOptions = calls[0][2] as { headers?: Record<string, string> };
    expect(needleOptions.headers).toEqual({ 'User-Agent': 'Custom/1.0' });
  });
});
