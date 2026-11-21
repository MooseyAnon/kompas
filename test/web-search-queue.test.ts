import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../src/main/modules/web/adapter-registry';
import { SearchQueue } from '../src/main/modules/web/search-queue';
import { WebService } from '../src/main/modules/web/web.service';
import { WebError } from '../src/main/modules/web/web.error';
import type { WebAdapter } from '../src/main/modules/web/capabilities';
import type { SearchPolicy } from '../src/main/modules/web/search-policy';
import type {
  RecordRunInput,
  TelemetryService,
} from '../src/main/modules/telemetry/telemetry.service';

const policy: SearchPolicy = {
  minGapMs: 5_000,
  maxGapMs: 65_000,
  maxQueued: 2,
  maxWaitMs: 120_000,
  attemptTimeoutMs: 20_000,
};
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('shared search attempt queue', () => {
  it('serializes manual and Discovery searches and requeues fallback behind older callers', async () => {
    const calls: string[] = [];
    let active = 0;
    let maximum = 0;
    const gate = deferred<void>();
    const primary: WebAdapter = {
      id: 'primary',
      capabilities: ['search'],
      async search(query) {
        active++;
        maximum = Math.max(maximum, active);
        calls.push(`primary:${query}:${Date.now()}`);
        if (query === 'first') await gate.promise;
        active--;
        if (query === 'first') throw new WebError('PROVIDER_FAILURE');
        return [];
      },
    };
    const fallback: WebAdapter = {
      id: 'fallback',
      capabilities: ['search'],
      async search(query) {
        active++;
        maximum = Math.max(maximum, active);
        calls.push(`fallback:${query}:${Date.now()}`);
        active--;
        return [];
      },
    };
    const web = new WebService({
      registry: new AdapterRegistry([primary, fallback]),
      preferences: { search: ['primary', 'fallback'], readPage: [] },
      searchPolicy: { ...policy, maxQueued: 3 },
      queueDeps: { random: () => 0 },
    });
    const first = web.search('first', { ownerId: 'discovery' });
    await tick(0);
    const manual = web.search('manual');
    const later = web.search('later', { ownerId: 'another-run' });
    expect(web.searchProgress('another-run')).toMatchObject({
      queueLength: 2,
      position: 2,
      state: 'waiting',
      nextEligibleAt: null,
    });
    gate.resolve();
    await tick(0);
    expect(calls).toHaveLength(1);
    await tick(5_000);
    await manual;
    await tick(5_000);
    await later;
    await tick(5_000);
    await first;
    expect(
      calls.map((call) => call.split(':')[0] + ':' + call.split(':')[1]),
    ).toEqual([
      'primary:first',
      'primary:manual',
      'primary:later',
      'fallback:first',
    ]);
    expect(maximum).toBe(1);
  });

  it.each([
    [0, 5_000],
    [1, 65_000],
  ])(
    'retains the %i jitter boundary across an empty queue',
    async (random, gap) => {
      const starts: number[] = [];
      const queue = new SearchQueue({
        now: Date.now,
        random: () => random,
        policy,
      });
      await queue.run(async () => {
        starts.push(Date.now());
      });
      await tick(1_000);
      const next = queue.run(
        async () => {
          starts.push(Date.now());
        },
        { ownerId: 'next' },
      );
      expect(queue.progress('next').nextEligibleAt).toBe(
        new Date(starts[0] + gap).toISOString(),
      );
      await tick(gap - 1_001);
      expect(starts).toHaveLength(1);
      await tick(1);
      await next;
      expect(starts[1] - starts[0]).toBe(gap);
    },
  );

  it('removes cancelled and expired entries, refuses excess capacity and never invokes them', async () => {
    const gate = deferred<void>();
    let calls = 0;
    const queue = new SearchQueue({ now: Date.now, random: () => 0, policy });
    const active = queue.run(() => gate.promise);
    await tick(0);
    const controller = new AbortController();
    const cancelled = queue.run(
      async () => {
        calls++;
      },
      { signal: controller.signal, ownerId: 'cancelled' },
    );
    const expired = queue.run(
      async () => {
        calls++;
      },
      { deadline: Date.now() + 1_000, ownerId: 'expired' },
    );
    const expiredCheck = expect(expired).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await expect(
      queue.run(async () => {
        calls++;
      }),
    ).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(queue.progress('expired')).toMatchObject({
      queueLength: 1,
      position: 1,
      nextEligibleAt: null,
    });
    await tick(1_000);
    await expiredCheck;
    gate.resolve();
    await active;
    expect(calls).toBe(0);
  });

  it('starts each 20-second network budget after waiting and bounds an uncooperative adapter', async () => {
    const queue = new SearchQueue({ now: Date.now, random: () => 0, policy });
    await queue.runAttempt(async () => 'first');
    const second = queue.runAttempt(async (ctx) => ctx.deadline - Date.now());
    await tick(4_999);
    expect(queue.progress('none').queueLength).toBe(1);
    await tick(1);
    expect(await second).toBe(20_000);
    const stuck = queue.runAttempt(async () => new Promise<void>(() => {}));
    const timeoutCheck = expect(stuck).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await tick(5_000);
    await tick(20_000);
    await timeoutCheck;
  });

  it('honours an outer deadline during network execution even without a caller signal', async () => {
    const queue = new SearchQueue({ now: Date.now, random: () => 0, policy });
    const expires = queue.runAttempt(async () => new Promise<void>(() => {}), {
      deadline: Date.now() + 1_500,
    });
    const check = expect(expires).rejects.toMatchObject({ code: 'TIMEOUT' });
    await tick(1_499);
    expect(queue.progress('none').queueLength).toBe(0);
    await tick(1);
    await check;
  });

  it('stops on rate limits and records only safe queue metadata', async () => {
    const records: RecordRunInput[] = [];
    const telemetry = {
      record: (input: RecordRunInput) => {
        records.push(input);
      },
    } as TelemetryService;
    let fallbackCalls = 0;
    const web = new WebService({
      registry: new AdapterRegistry([
        {
          id: 'primary',
          capabilities: ['search'],
          search: async () => {
            throw new WebError('RATE_LIMITED');
          },
        },
        {
          id: 'secondary',
          capabilities: ['search'],
          search: async () => {
            fallbackCalls++;
            return [];
          },
        },
      ]),
      preferences: { search: ['primary', 'secondary'], readPage: [] },
      searchPolicy: policy,
      telemetry,
    });
    await expect(web.search('PRIVATE_QUERY')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(fallbackCalls).toBe(0);
    expect(records).toMatchObject([
      {
        moduleId: 'web',
        operation: 'search',
        outcome: 'failure',
        errorCode: 'RATE_LIMITED',
        detail: { queuedAttempts: 1, queueWaitMs: 0, adapterId: 'primary' },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain('PRIVATE_QUERY');
  });

  it('records elapsed queue wait on cancellation without persisting the search text', async () => {
    const gate = deferred<void>();
    const records: RecordRunInput[] = [];
    const telemetry = {
      record: (input: RecordRunInput) => {
        records.push(input);
      },
    } as TelemetryService;
    const web = new WebService({
      registry: new AdapterRegistry([
        {
          id: 'test',
          capabilities: ['search'],
          search: async (query) => {
            if (query === 'first') await gate.promise;
            return [];
          },
        },
      ]),
      preferences: { search: ['test'], readPage: [] },
      telemetry,
      searchPolicy: policy,
    });
    const first = web.search('first');
    await tick(0);
    const controller = new AbortController();
    const cancelled = web.search('PRIVATE_PENDING', {
      signal: controller.signal,
    });
    const cancelledCheck = expect(cancelled).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await tick(1_234);
    controller.abort();
    await cancelledCheck;
    const failed = records.find((record) => record.outcome === 'cancelled');
    expect(failed?.detail).toMatchObject({
      queueWaitMs: 1_234,
      queuePeak: 2,
      queuedAttempts: 1,
      adapterId: 'none',
    });
    expect(JSON.stringify(records)).not.toContain('PRIVATE_PENDING');
    gate.resolve();
    await first;
  });
});
