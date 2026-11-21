import { describe, expect, it, vi } from 'vitest';
import {
  GenerationScheduler,
  type GenerationEntry,
} from '../src/main/modules/inference/generation-scheduler';
import type {
  GenerationResult,
  InferenceErrorCode,
} from '../src/shared/contracts';

function entry(
  priority: GenerationEntry['execution']['priority'] = 'normal',
  overrides: Partial<GenerationEntry> = {},
): GenerationEntry {
  return {
    callerModule: 'interviews',
    providerId: 'mock',
    modelId: 'mock-static',
    messages: [{ role: 'user', content: 'private canary' }],
    execution: { priority },
    ...overrides,
  };
}

function outcome(
  e: GenerationEntry,
  code?: InferenceErrorCode,
): GenerationResult {
  return {
    requestId: e.requestId!,
    providerId: e.providerId,
    modelId: e.modelId,
    status: code ? 'failed' : 'completed',
    output: code ? null : 'private answer',
    toolCalls: [],
    usage: null,
    ...(code ? { error: { code, message: 'safe' } } : {}),
  };
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('inference priority scheduler', () => {
  it('accepts existing camelCase domain identifiers such as cvImports and jobDiscovery', async () => {
    const dispatch = vi.fn(async (e: GenerationEntry) => outcome(e));
    const scheduler = new GenerationScheduler(dispatch);
    for (const callerModule of ['cvImports', 'jobDiscovery']) {
      expect(
        (await scheduler.submit(entry('background', { callerModule }))).status,
      ).toBe('completed');
    }
    expect(dispatch).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
  it('never preempts active work, overtakes queued work and preserves FIFO within priority', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    const scheduler = new GenerationScheduler(async (e) => {
      started.push(e.messages[0].content);
      active++;
      expect(active).toBe(1);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return outcome(e);
    });
    const submit = (
      priority: GenerationEntry['execution']['priority'],
      name: string,
    ) =>
      scheduler.submit(
        entry(priority, { messages: [{ role: 'user', content: name }] }),
      );
    const first = submit('background', 'running');
    const normal = submit('normal', 'normal');
    const high1 = submit('interactive', 'high1');
    const high2 = submit('interactive', 'high2');
    const low = submit('background', 'low');
    expect(started).toEqual(['running']);
    for (const name of ['high1', 'high2', 'normal', 'low']) {
      releases.shift()!();
      await tick();
      expect(started.at(-1)).toBe(name);
    }
    releases.shift()!();
    expect(
      (await Promise.all([first, normal, high1, high2, low])).every(
        (r) => r.status === 'completed',
      ),
    ).toBe(true);
    scheduler.stop();
  });

  it('cancels queued submissions without dispatch and propagates active abort once', async () => {
    let activeSignal: AbortSignal | undefined;
    const dispatch = vi.fn(async (e: GenerationEntry, signal: AbortSignal) => {
      activeSignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return outcome(e);
    });
    const scheduler = new GenerationScheduler(dispatch);
    const id = crypto.randomUUID();
    const first = scheduler.submit(entry('normal', { requestId: id }));
    const queuedId = crypto.randomUUID();
    const second = scheduler.submit(
      entry('interactive', { requestId: queuedId }),
    );
    expect(scheduler.cancel(queuedId).outcome).toBe('cancelled');
    expect((await second).status).toBe('cancelled');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(scheduler.cancel(id).outcome).toBe('cancelled');
    expect(activeSignal?.aborted).toBe(true);
    expect((await first).status).toBe('cancelled');
    scheduler.stop();
  });

  it.each([0, 1, 2] as const)(
    'exhausts exactly %i configured retries',
    async (maxRetries) => {
      const dispatch = vi.fn(async (e: GenerationEntry) =>
        outcome(e, 'PROVIDER_UNAVAILABLE'),
      );
      const scheduler = new GenerationScheduler(dispatch);
      const result = await scheduler.submit(
        entry('normal', {
          execution: { priority: 'normal', retry: { maxRetries } },
        }),
      );
      expect(dispatch).toHaveBeenCalledTimes(maxRetries + 1);
      expect(result).toMatchObject({
        status: 'failed',
        attemptsMade: maxRetries + 1,
        maxRetries,
        lastErrorCode: 'PROVIDER_UNAVAILABLE',
        error: { code: 'RETRIES_EXHAUSTED' },
      });
      scheduler.stop();
    },
  );

  it('retries transient worker failure, but not terminal errors or any tool-enabled attempt', async () => {
    const dispatch = vi.fn(async (e: GenerationEntry) =>
      outcome(
        e,
        dispatch.mock.calls.length === 1 ? 'WORKER_EXITED' : undefined,
      ),
    );
    const scheduler = new GenerationScheduler(dispatch);
    expect(await scheduler.submit(entry())).toMatchObject({
      status: 'completed',
      attemptsMade: 2,
    });
    for (const code of [
      'CAPABILITY_UNSUPPORTED',
      'INVALID_SCHEMA',
      'MODEL_NOT_FOUND',
    ] as const) {
      const terminal = vi.fn(async (e: GenerationEntry) => outcome(e, code));
      const single = new GenerationScheduler(terminal);
      expect((await single.submit(entry())).error?.code).toBe(code);
      expect(terminal).toHaveBeenCalledTimes(1);
      single.stop();
    }
    const tool = vi.fn(async (e: GenerationEntry) =>
      outcome(e, 'WORKER_EXITED'),
    );
    const guarded = new GenerationScheduler(tool);
    expect(
      (
        await guarded.submit(
          entry('normal', { toolNames: ['examples.write_note'] }),
        )
      ).error?.code,
    ).toBe('WORKER_EXITED');
    expect(tool).toHaveBeenCalledTimes(1);
    guarded.stop();
    scheduler.stop();
  });

  it('cancels backoff and shutdown clears queued work', async () => {
    const dispatch = vi.fn(async (e: GenerationEntry) =>
      outcome(e, 'PROVIDER_UNAVAILABLE'),
    );
    const scheduler = new GenerationScheduler(dispatch);
    const id = crypto.randomUUID();
    const first = scheduler.submit(entry('normal', { requestId: id }));
    await tick();
    const second = scheduler.submit(entry());
    scheduler.cancel(id);
    scheduler.stop();
    expect((await first).status).toBe('cancelled');
    expect((await second).status).toBe('cancelled');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('counts queue time in the deadline and never dispatches an expired entry', async () => {
    let release!: () => void;
    const dispatch = vi.fn(async (e: GenerationEntry) => {
      if (dispatch.mock.calls.length === 1)
        await new Promise<void>((r) => {
          release = r;
        });
      return outcome(e);
    });
    const scheduler = new GenerationScheduler(dispatch);
    const first = scheduler.submit(entry());
    const queued = scheduler.submit(
      entry('interactive', { limits: { timeoutMs: 100 } }),
    );
    expect(await queued).toMatchObject({
      status: 'failed',
      attemptsMade: 0,
      error: { code: 'TIMEOUT' },
    });
    release();
    expect((await first).status).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('keeps terminal events single and ordered even when a transient attempt fails', async () => {
    const events: string[] = [];
    let attempts = 0;
    const scheduler = new GenerationScheduler(async (e, _signal, onEvent) => {
      attempts++;
      onEvent?.({
        kind: 'delta',
        requestId: e.requestId!,
        seq: 1,
        at: new Date().toISOString(),
        text: 'answer',
      });
      return outcome(e, attempts === 1 ? 'PROVIDER_UNAVAILABLE' : undefined);
    });
    const result = await scheduler.submit(
      entry('normal', {
        execution: {
          priority: 'normal',
          onEvent: (event) => events.push(`${event.seq}:${event.kind}`),
        },
      }),
    );
    expect(result).toMatchObject({ status: 'completed', attemptsMade: 2 });
    expect(events).toEqual(['1:delta', '2:delta', '3:completed']);
    expect(scheduler.cancel(result.requestId).outcome).toBe('already_finished');
    scheduler.stop();
  });

  it('settles cancellation only once when a provider ignores abort and returns success late', async () => {
    let release!: () => void;
    const events: string[] = [];
    const dispatch = vi.fn(async (e: GenerationEntry) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return outcome(e);
    });
    const scheduler = new GenerationScheduler(dispatch);
    const id = crypto.randomUUID();
    const result = scheduler.submit(
      entry('normal', {
        requestId: id,
        execution: {
          priority: 'normal',
          onEvent: (event) => events.push(event.kind),
        },
      }),
    );
    const queued = scheduler.submit(entry('background'));
    expect(scheduler.cancel(id).outcome).toBe('cancelled');
    expect(scheduler.cancel(id).outcome).toBe('already_finished');
    expect((await result).status).toBe('cancelled');
    scheduler.stop();
    expect((await queued).status).toBe('cancelled');
    release();
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['cancelled']);
  });
});
