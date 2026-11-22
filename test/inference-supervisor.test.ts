import { describe, expect, it } from 'vitest';
import { WorkerSupervisor } from '../src/main/modules/inference/worker-supervisor';
import { InMemoryTransport } from '../src/main/modules/inference/transport';
import type { GenerationEvent } from '../src/shared/contracts';
import type { MainToWorkerMessage } from '../src/shared/contracts/inference-worker';

function makeSupervisor(
  overrides: Partial<ConstructorParameters<typeof WorkerSupervisor>[0]> = {},
) {
  const transports: InMemoryTransport[] = [];
  const supervisor = new WorkerSupervisor({
    createTransport: () => {
      const transport = new InMemoryTransport();
      transports.push(transport);
      return transport;
    },
    providerConfigs: [{ providerId: 'mock', kind: 'mock', dev: true }],
    startupTimeoutMs: 1000,
    statusTimeoutMs: 500,
    ...overrides,
  });
  return { supervisor, transports };
}

const userMessages = [{ role: 'user' as const, content: 'hi' }];

describe('WorkerSupervisor lifecycle and generation', () => {
  it('queries adapter model details through the validated worker boundary', async () => {
    const { supervisor } = makeSupervisor();
    expect(await supervisor.queryModelDetails('mock', 'mock-static')).toEqual({
      maxContextTokens: 32_768,
      configuredContextTokens: 32_768,
      supportsContextOverride: true,
    });
    expect(await supervisor.queryModelDetails('mock', 'missing')).toBeNull();
    expect(
      await supervisor.queryModelDetails('unregistered', 'model'),
    ).toBeNull();
    await supervisor.stop();
  });

  it('settles pending detail queries on worker exit', async () => {
    let transport!: InMemoryTransport;
    const { supervisor } = makeSupervisor({
      createTransport: () => {
        transport = new InMemoryTransport({
          createProvider: () => ({
            id: 'mock',
            status: () => ({
              state: 'ready',
              capabilities: {
                text: 'supported',
                streaming: 'supported',
                tools: 'unknown',
                structuredOutput: 'supported',
              },
            }),
            getModelDetails: () => new Promise(() => {}),
            generate: async () => ({ status: 'cancelled' }),
          }),
        });
        return transport;
      },
    });
    await supervisor.start();
    const pending = supervisor.queryModelDetails('mock', 'local');
    await Promise.resolve();
    await Promise.resolve();
    transport.simulateExit();
    expect(await pending).toBeNull();
    await supervisor.stop();
  });

  it('starts, reaches ready and reports provider status', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();
    expect(supervisor.getState()).toBe('ready');

    const observation = await supervisor.queryProviderStatus('mock');
    expect(observation?.state).toBe('ready');
    await supervisor.stop();
  });

  it('completes a mock generation with ordered, single-terminal events', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();

    const events: GenerationEvent[] = [];
    const result = await supervisor.generate(
      { providerId: 'mock', modelId: 'mock-static', messages: userMessages },
      { onEvent: (e) => events.push(e) },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toBe('echo:hi');

    expect(events[0].kind).toBe('started');
    expect(events.at(-1)?.kind).toBe('completed');
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(1);
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    await supervisor.stop();
  });

  it('returns validated structured output', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();
    const result = await supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-json',
      messages: userMessages,
      responseFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            score: { type: 'integer' },
          },
          required: ['title', 'score'],
        },
      },
    });
    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({ title: 'Mock structured result' });
    await supervisor.stop();
  });

  it('validates and forwards explicit thinking while omission stays absent', async () => {
    const sent: MainToWorkerMessage[] = [];
    class TrackingTransport extends InMemoryTransport {
      override send(message: MainToWorkerMessage): void {
        sent.push(message);
        super.send(message);
      }
    }
    const { supervisor } = makeSupervisor({
      createTransport: () => new TrackingTransport(),
    });
    await supervisor.start();
    for (const thinking of [false, true, undefined]) {
      const result = await supervisor.generate({
        providerId: 'mock',
        modelId: 'mock-static',
        messages: userMessages,
        ...(thinking === undefined ? {} : { thinking }),
      });
      expect(result.status).toBe('completed');
    }
    const starts = sent.filter(
      (message) => message.kind === 'generation.start',
    );
    expect(starts.map((message) => message.payload.thinking)).toEqual([
      false,
      true,
      undefined,
    ]);
    const invalid = await supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-static',
      messages: userMessages,
      thinking: 'no' as never,
    });
    expect(invalid.error?.code).toBe('INTERNAL');
    expect(
      sent.filter((message) => message.kind === 'generation.start'),
    ).toHaveLength(3);
    await supervisor.stop();
  });

  it('forwards reasoning as thinking_delta events and omits it when thinking is off', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();

    const withThinking: GenerationEvent[] = [];
    const result = await supervisor.generate(
      { providerId: 'mock', modelId: 'mock-thinking', messages: userMessages },
      { onEvent: (e) => withThinking.push(e) },
    );
    expect(result.status).toBe('completed');
    expect(result.output).toBe('echo:hi');
    const reasoning = withThinking.flatMap((e) =>
      e.kind === 'thinking_delta' ? [e.text] : [],
    );
    const answer = withThinking.flatMap((e) =>
      e.kind === 'delta' ? [e.text] : [],
    );
    expect(reasoning.join('')).toBe('mock reasoning');
    expect(answer.join('')).toBe('echo:hi');

    const withoutThinking: GenerationEvent[] = [];
    const off = await supervisor.generate(
      {
        providerId: 'mock',
        modelId: 'mock-thinking',
        messages: userMessages,
        thinking: false,
      },
      { onEvent: (e) => withoutThinking.push(e) },
    );
    expect(off.output).toBe('echo:hi');
    expect(withoutThinking.some((e) => e.kind === 'thinking_delta')).toBe(
      false,
    );
    await supervisor.stop();
  });

  it('times out a slow generation with a TIMEOUT error', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();
    const result = await supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-slow',
      messages: userMessages,
      limits: { timeoutMs: 100 },
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TIMEOUT');
    await supervisor.stop();
  });
});

describe('WorkerSupervisor cancellation', () => {
  it('cancels before start when the signal is already aborted', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();
    const controller = new AbortController();
    controller.abort();
    const result = await supervisor.generate(
      { providerId: 'mock', modelId: 'mock-static', messages: userMessages },
      { signal: controller.signal },
    );
    expect(result.status).toBe('cancelled');
    await supervisor.stop();
  });

  it('cancels a mid-stream generation via AbortSignal', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();
    const controller = new AbortController();
    const pending = supervisor.generate(
      { providerId: 'mock', modelId: 'mock-slow', messages: userMessages },
      {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.kind === 'started') controller.abort();
        },
      },
    );
    const result = await pending;
    expect(result.status).toBe('cancelled');
    await supervisor.stop();
  });

  it('reports idempotent cancel outcomes after completion', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();
    const result = await supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-static',
      messages: userMessages,
    });
    const after = await supervisor.cancel(result.requestId);
    expect(after.outcome).toBe('already_finished');
    const unknown = await supervisor.cancel(crypto.randomUUID());
    expect(unknown.outcome).toBe('not_found');
    await supervisor.stop();
  });
});

describe('WorkerSupervisor capacity and resilience', () => {
  it('rejects beyond the bounded queue with OVER_CAPACITY', async () => {
    const { supervisor } = makeSupervisor({
      maxInFlightPerProvider: 1,
      maxQueued: 1,
    });
    await supervisor.start();

    const slow1 = supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-slow',
      messages: userMessages,
    });
    const slow2 = supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-slow',
      messages: userMessages,
    });
    const overflow = await supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-slow',
      messages: userMessages,
    });
    expect(overflow.status).toBe('failed');
    expect(overflow.error?.code).toBe('OVER_CAPACITY');

    await supervisor.stop();
    await Promise.allSettled([slow1, slow2]);
  });

  it('fails pending calls on crash and recovers on the next request', async () => {
    const { supervisor, transports } = makeSupervisor();
    await supervisor.start();

    const events: GenerationEvent[] = [];
    const pending = supervisor.generate(
      { providerId: 'mock', modelId: 'mock-slow', messages: userMessages },
      { onEvent: (e) => events.push(e) },
    );
    // Let the generation start before the worker dies.
    await new Promise((r) => setTimeout(r, 10));
    transports[0].simulateExit(1);

    const crashed = await pending;
    expect(crashed.status).toBe('failed');
    expect(crashed.error?.code).toBe('WORKER_EXITED');
    expect(events.some((e) => e.kind === 'completed')).toBe(false);

    // Next request transparently restarts the worker.
    const recovered = await supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-static',
      messages: userMessages,
    });
    expect(recovered.status).toBe('completed');
    expect(supervisor.getState()).toBe('ready');
    expect(transports.length).toBeGreaterThanOrEqual(2);
    await supervisor.stop();
  });

  it('refuses generation after an explicit shutdown', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start();
    await supervisor.stop();
    expect(supervisor.getState()).toBe('stopped');
    const result = await supervisor.generate({
      providerId: 'mock',
      modelId: 'mock-static',
      messages: userMessages,
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('WORKER_UNAVAILABLE');
  });
});
