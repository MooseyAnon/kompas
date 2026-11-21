import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../src/shared/contracts';
import { AdapterRegistry } from '../src/main/modules/web/adapter-registry';
import type {
  CapabilityContext,
  WebAdapter,
} from '../src/main/modules/web/capabilities';
import { resolveCapability } from '../src/main/modules/web/resolver';
import { isWebError, WebError } from '../src/main/modules/web/web.error';

interface FakeOptions {
  id: string;
  results?: SearchResult[];
  throws?: WebError;
  available?: boolean;
  onCall?: () => void;
}

function fakeSearch(opts: FakeOptions): WebAdapter & { calls: number } {
  const adapter = {
    id: opts.id,
    capabilities: ['search'] as const,
    calls: 0,
    isAvailable: () => opts.available ?? true,
    async search(_query: string, _ctx: CapabilityContext) {
      adapter.calls += 1;
      opts.onCall?.();
      if (opts.throws) {
        throw opts.throws;
      }
      return opts.results ?? [];
    },
  };
  return adapter;
}

const result = (rank: number): SearchResult => ({
  title: `r${rank}`,
  url: `https://example.com/${rank}`,
  rank,
});

const OPTS = { timeoutMs: 1000, maxAttempts: 4 } as const;

function run(adapter: WebAdapter, ctx: CapabilityContext) {
  return adapter.search!('q', ctx);
}

describe('capability resolver', () => {
  it('picks the first preferred capable adapter', async () => {
    const primary = fakeSearch({ id: 'a', results: [result(1)] });
    const secondary = fakeSearch({ id: 'b', results: [result(1)] });
    const registry = new AdapterRegistry([primary, secondary]);

    const out = await resolveCapability(
      'search',
      registry,
      ['a', 'b'],
      run,
      OPTS,
    );
    expect(out.providerId).toBe('a');
    expect(secondary.calls).toBe(0);
  });

  it('honours preference order without changing the caller', async () => {
    const a = fakeSearch({ id: 'a', results: [result(1)] });
    const b = fakeSearch({ id: 'b', results: [result(1)] });
    const registry = new AdapterRegistry([a, b]);

    const first = await resolveCapability(
      'search',
      registry,
      ['a', 'b'],
      run,
      OPTS,
    );
    const second = await resolveCapability(
      'search',
      registry,
      ['b', 'a'],
      run,
      OPTS,
    );
    expect(first.providerId).toBe('a');
    expect(second.providerId).toBe('b');
  });

  it('throws NO_CAPABLE_PROVIDER when nothing supports the capability', async () => {
    const registry = new AdapterRegistry([]);
    await expect(
      resolveCapability('search', registry, ['a'], run, OPTS),
    ).rejects.toMatchObject({ code: 'NO_CAPABLE_PROVIDER' });
  });

  it('skips an unavailable primary and uses the secondary', async () => {
    const primary = fakeSearch({ id: 'a', available: false });
    const secondary = fakeSearch({ id: 'b', results: [result(1)] });
    const registry = new AdapterRegistry([primary, secondary]);

    const out = await resolveCapability(
      'search',
      registry,
      ['a', 'b'],
      run,
      OPTS,
    );
    expect(out.providerId).toBe('b');
    expect(primary.calls).toBe(0);
    expect(out.attempts[0]).toMatchObject({
      providerId: 'a',
      outcome: 'unavailable',
    });
  });

  it('falls back on a retryable failure', async () => {
    const primary = fakeSearch({
      id: 'a',
      throws: new WebError('PROVIDER_FAILURE', { retryable: true }),
    });
    const secondary = fakeSearch({ id: 'b', results: [result(1)] });
    const registry = new AdapterRegistry([primary, secondary]);

    const out = await resolveCapability(
      'search',
      registry,
      ['a', 'b'],
      run,
      OPTS,
    );
    expect(out.providerId).toBe('b');
    expect(out.attempts).toEqual([
      { providerId: 'a', outcome: 'retryable', errorCode: 'PROVIDER_FAILURE' },
      { providerId: 'b', outcome: 'ok' },
    ]);
  });

  it('does NOT fall back on a non-retryable failure', async () => {
    const primary = fakeSearch({
      id: 'a',
      throws: new WebError('INVALID_INPUT'),
    });
    const secondary = fakeSearch({ id: 'b', results: [result(1)] });
    const registry = new AdapterRegistry([primary, secondary]);

    await expect(
      resolveCapability('search', registry, ['a', 'b'], run, OPTS),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(secondary.calls).toBe(0);
  });

  it('does NOT fall back on a valid empty result', async () => {
    const primary = fakeSearch({ id: 'a', results: [] });
    const secondary = fakeSearch({ id: 'b', results: [result(1)] });
    const registry = new AdapterRegistry([primary, secondary]);

    const out = await resolveCapability(
      'search',
      registry,
      ['a', 'b'],
      run,
      OPTS,
    );
    expect(out.providerId).toBe('a');
    expect(out.value).toEqual([]);
    expect(secondary.calls).toBe(0);
  });

  it('stops immediately on a pre-aborted signal without calling providers', async () => {
    const primary = fakeSearch({ id: 'a', results: [result(1)] });
    const registry = new AdapterRegistry([primary]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveCapability('search', registry, ['a'], run, {
        ...OPTS,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(primary.calls).toBe(0);
  });

  it('stops at a rate-limited search provider without using another adapter', async () => {
    const a = fakeSearch({
      id: 'a',
      throws: new WebError('RATE_LIMITED', { retryable: true }),
    });
    const b = fakeSearch({
      id: 'b',
      throws: new WebError('PROVIDER_FAILURE', { retryable: true }),
    });
    const registry = new AdapterRegistry([a, b]);

    const error = await resolveCapability(
      'search',
      registry,
      ['a', 'b'],
      run,
      OPTS,
    )
      .then(() => null)
      .catch((e) => e);
    expect(isWebError(error)).toBe(true);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.attempts).toHaveLength(1);
    expect(b.calls).toBe(0);
  });

  it('wraps unknown adapter errors as retryable provider failures', async () => {
    const a: WebAdapter = {
      id: 'a',
      capabilities: ['search'],
      async search() {
        throw new Error('raw upstream detail that must not leak');
      },
    };
    const b = fakeSearch({ id: 'b', results: [result(1)] });
    const registry = new AdapterRegistry([a, b]);

    const out = await resolveCapability(
      'search',
      registry,
      ['a', 'b'],
      run,
      OPTS,
    );
    expect(out.providerId).toBe('b');
    expect(out.attempts[0]).toMatchObject({
      outcome: 'retryable',
      errorCode: 'PROVIDER_FAILURE',
    });
  });
});
