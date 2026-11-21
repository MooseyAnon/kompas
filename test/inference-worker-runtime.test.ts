import { describe, expect, it } from 'vitest';
import { WorkerRuntime } from '../src/main/modules/inference/worker-runtime';
import type { WorkerToMainMessage } from '../src/shared/contracts/inference-worker';

const uuid = () => crypto.randomUUID();

function makeRuntime() {
  const sent: WorkerToMainMessage[] = [];
  const runtime = new WorkerRuntime({
    send: (m) => sent.push(m),
    now: () => 'T',
  });
  return { runtime, sent };
}

function init(runtime: WorkerRuntime) {
  runtime.handle({
    protocolVersion: 1,
    kind: 'worker.init',
    lifecycleId: uuid(),
    payload: { providers: [{ providerId: 'mock', kind: 'mock', dev: true }] },
  });
}

function events(sent: WorkerToMainMessage[], requestId: string) {
  return sent.filter(
    (m): m is Extract<WorkerToMainMessage, { kind: 'generation.event' }> =>
      m.kind === 'generation.event' && m.requestId === requestId,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('condition not met in time');
}

function startGeneration(
  runtime: WorkerRuntime,
  requestId: string,
  overrides: Record<string, unknown> = {},
) {
  runtime.handle({
    protocolVersion: 1,
    kind: 'generation.start',
    requestId,
    seq: 0,
    payload: {
      providerId: 'mock',
      modelId: 'mock-static',
      messages: [{ role: 'user', content: 'hi' }],
      ...overrides,
    },
  });
}

describe('WorkerRuntime lifecycle', () => {
  it('replies worker.ready to worker.init', () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    expect(sent.some((m) => m.kind === 'worker.ready')).toBe(true);
  });

  it('answers provider.status for a registered provider', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    runtime.handle({
      protocolVersion: 1,
      kind: 'provider.status',
      requestId,
      payload: { providerId: 'mock' },
    });
    await waitFor(() => sent.some((m) => m.kind === 'provider.status.result'));
    const result = sent.find((m) => m.kind === 'provider.status.result');
    expect(result).toBeTruthy();
    if (result && result.kind === 'provider.status.result') {
      expect(result.payload.state).toBe('ready');
      expect(result.payload.capabilities.tools).toBe('unsupported');
    }
  });

  it('emits a safe worker.failure for a malformed message', () => {
    const { runtime, sent } = makeRuntime();
    runtime.handle({ nonsense: true });
    expect(sent.some((m) => m.kind === 'worker.failure')).toBe(true);
  });
});

describe('WorkerRuntime generation', () => {
  it('streams ordered deltas then a single terminal completed event', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId);

    await waitFor(() =>
      events(sent, requestId).some((e) => e.payload.eventKind === 'completed'),
    );

    const evs = events(sent, requestId);
    const kinds = evs.map((e) => e.payload.eventKind);
    expect(kinds[0]).toBe('started');
    expect(kinds[kinds.length - 1]).toBe('completed');
    expect(kinds.filter((k) => k === 'completed')).toHaveLength(1);

    // Monotonic seq.
    const seqs = evs.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    const completed = evs.at(-1);
    if (completed && completed.payload.eventKind === 'completed') {
      expect(completed.payload.output).toBe('echo:hi');
    }
  });

  it('emits thinking_delta events separately from the answer', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId, { modelId: 'mock-thinking' });

    await waitFor(() =>
      events(sent, requestId).some((e) => e.payload.eventKind === 'completed'),
    );

    const evs = events(sent, requestId);
    const thinking = evs.flatMap((e) =>
      e.payload.eventKind === 'thinking_delta' ? [e.payload.text] : [],
    );
    const answer = evs.flatMap((e) =>
      e.payload.eventKind === 'delta' ? [e.payload.text] : [],
    );
    expect(thinking.join('')).toBe('mock reasoning');
    expect(answer.join('')).toBe('echo:hi');

    const completed = evs.at(-1);
    expect(completed?.payload.eventKind).toBe('completed');
    if (completed && completed.payload.eventKind === 'completed') {
      expect(completed.payload.output).toBe('echo:hi');
    }
  });

  it('validates structured output against the requested schema', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId, {
      modelId: 'mock-json',
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

    await waitFor(() =>
      events(sent, requestId).some(
        (e) =>
          e.payload.eventKind === 'completed' ||
          e.payload.eventKind === 'failed',
      ),
    );
    const completed = events(sent, requestId).at(-1);
    expect(completed?.payload.eventKind).toBe('completed');
    if (completed && completed.payload.eventKind === 'completed') {
      expect(completed.payload.output).toMatchObject({ score: 7 });
    }
  });

  it('fails with INVALID_SCHEMA when structured output does not match', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId, {
      modelId: 'mock-fault-invalid-json',
      responseFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
      },
    });
    await waitFor(() =>
      events(sent, requestId).some((e) => e.payload.eventKind === 'failed'),
    );
    const failed = events(sent, requestId).at(-1);
    if (failed && failed.payload.eventKind === 'failed') {
      expect(failed.payload.error.code).toBe('INVALID_SCHEMA');
    }
  });

  it('fails with PROVIDER_UNAVAILABLE for an unknown provider', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId, { providerId: 'ghost' });
    await waitFor(() =>
      events(sent, requestId).some((e) => e.payload.eventKind === 'failed'),
    );
    const failed = events(sent, requestId).at(-1);
    if (failed && failed.payload.eventKind === 'failed') {
      expect(failed.payload.error.code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('cancels an in-flight generation', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId, { modelId: 'mock-slow' });
    await waitFor(() =>
      events(sent, requestId).some((e) => e.payload.eventKind === 'started'),
    );
    runtime.handle({
      protocolVersion: 1,
      kind: 'generation.cancel',
      requestId,
      payload: {},
    });
    await waitFor(() =>
      events(sent, requestId).some((e) => e.payload.eventKind === 'cancelled'),
    );
    const terminal = events(sent, requestId).at(-1);
    expect(terminal?.payload.eventKind).toBe('cancelled');
  });
});

describe('WorkerRuntime tool loop', () => {
  const addTool = {
    name: 'examples.add_numbers',
    version: 1,
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  };

  function toolRequests(sent: WorkerToMainMessage[], requestId: string) {
    return sent.filter(
      (
        m,
      ): m is Extract<
        WorkerToMainMessage,
        { kind: 'tool.execution.request' }
      > => m.kind === 'tool.execution.request' && m.requestId === requestId,
    );
  }

  it('emits a tool.execution.request and resumes once a result arrives', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId, {
      modelId: 'mock-tools-add',
      tools: [addTool],
      toolPolicy: { maxSteps: 3, maxToolCalls: 4, maxCallsPerTool: 3 },
    });

    await waitFor(() => toolRequests(sent, requestId).length === 1);
    const req = toolRequests(sent, requestId)[0];
    expect(req.payload.invocation).toMatchObject({
      toolName: 'examples.add_numbers',
      version: 1,
    });

    // Simulate the main-process broker returning a validated result.
    runtime.handle({
      protocolVersion: 1,
      kind: 'tool.execution.result',
      requestId,
      payload: {
        result: {
          toolCallId: req.payload.invocation.toolCallId,
          toolName: req.payload.invocation.toolName,
          ok: true,
          data: { sum: 5 },
          durationMs: 1,
        },
      },
    });

    await waitFor(() =>
      events(sent, requestId).some((e) => e.payload.eventKind === 'completed'),
    );
    const evs = events(sent, requestId).map((e) => e.payload.eventKind);
    expect(evs).toContain('tool_request');
    expect(evs).toContain('tool_result');
    const completed = events(sent, requestId).at(-1);
    if (completed && completed.payload.eventKind === 'completed') {
      expect(completed.payload.output).toBe('sum=5');
    }
  });

  it('terminates with LIMIT_EXCEEDED when the step budget is exceeded', async () => {
    const { runtime, sent } = makeRuntime();
    init(runtime);
    const requestId = uuid();
    startGeneration(runtime, requestId, {
      modelId: 'mock-tools-loop',
      tools: [addTool],
      toolPolicy: { maxSteps: 2, maxToolCalls: 8, maxCallsPerTool: 3 },
    });

    // Answer every tool request so the loop is only bounded by maxSteps.
    const answered = new Set<string>();
    await waitFor(() => {
      for (const req of toolRequests(sent, requestId)) {
        const id = req.payload.invocation.toolCallId;
        if (!answered.has(id)) {
          answered.add(id);
          runtime.handle({
            protocolVersion: 1,
            kind: 'tool.execution.result',
            requestId,
            payload: {
              result: {
                toolCallId: id,
                toolName: req.payload.invocation.toolName,
                ok: true,
                data: { sum: 2 },
                durationMs: 1,
              },
            },
          });
        }
      }
      return events(sent, requestId).some(
        (e) => e.payload.eventKind === 'failed',
      );
    });

    const failed = events(sent, requestId).at(-1);
    if (failed && failed.payload.eventKind === 'failed') {
      expect(failed.payload.error.code).toBe('LIMIT_EXCEEDED');
    }
  });
});
