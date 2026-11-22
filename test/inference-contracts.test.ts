import { describe, expect, it } from 'vitest';
import {
  generationRequestSchema,
  generationResultSchema,
  generationEventSchema,
  hardwareProfileSchema,
  providerStatusSchema,
  inferenceStatusGetOutputSchema,
  INFERENCE_PROTOCOL_VERSION,
  INFERENCE_LIMITS,
} from '../src/shared/contracts';
import {
  mainToWorkerMessageSchema,
  workerToMainMessageSchema,
} from '../src/shared/contracts/inference-worker';
import {
  validateAgainstJsonSchema,
  safeParseJson,
} from '../src/main/modules/inference/json-schema';

const uuid = () => crypto.randomUUID();

describe('inference request/result/event contracts', () => {
  it('validates capacity metadata and positive context overrides at the worker boundary', () => {
    const reply = {
      protocolVersion: INFERENCE_PROTOCOL_VERSION,
      kind: 'provider.modelDetails.result',
      requestId: uuid(),
      payload: {
        providerId: 'adapter',
        modelId: 'local',
        details: {
          maxContextTokens: 131_072,
          configuredContextTokens: null,
          supportsContextOverride: true,
        },
      },
    };
    expect(workerToMainMessageSchema.safeParse(reply).success).toBe(true);
    reply.payload.details.maxContextTokens = -1;
    expect(workerToMainMessageSchema.safeParse(reply).success).toBe(false);
    for (const contextTokens of [0, -1, 1.5, '8000']) {
      expect(
        generationRequestSchema.safeParse({
          requestId: uuid(),
          providerId: 'adapter',
          modelId: 'local',
          messages: [{ role: 'user', content: 'job' }],
          limits: { contextTokens },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts a well-formed generation request', () => {
    const parsed = generationRequestSchema.safeParse({
      requestId: uuid(),
      providerId: 'mock',
      modelId: 'mock-static',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a request with no messages', () => {
    const parsed = generationRequestSchema.safeParse({
      requestId: uuid(),
      providerId: 'mock',
      modelId: 'mock-static',
      messages: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an out-of-range timeout', () => {
    const parsed = generationRequestSchema.safeParse({
      requestId: uuid(),
      providerId: 'mock',
      modelId: 'mock-static',
      messages: [{ role: 'user', content: 'hi' }],
      limits: { timeoutMs: INFERENCE_LIMITS.maxTimeoutMs + 1 },
    });
    expect(parsed.success).toBe(false);
  });

  it('validates a completed result and a discriminated event union', () => {
    const rid = uuid();
    expect(
      generationResultSchema.safeParse({
        requestId: rid,
        providerId: 'mock',
        modelId: 'mock-static',
        status: 'completed',
        output: 'echo:hi',
        toolCalls: [],
        usage: null,
      }).success,
    ).toBe(true);

    expect(
      generationEventSchema.safeParse({
        kind: 'delta',
        requestId: rid,
        seq: 2,
        at: new Date().toISOString(),
        text: 'ec',
      }).success,
    ).toBe(true);

    expect(
      generationEventSchema.safeParse({
        kind: 'delta',
        requestId: rid,
        seq: 2,
        at: new Date().toISOString(),
        // missing text
      }).success,
    ).toBe(false);
  });

  it('accepts a thinking_delta event and bounds its text', () => {
    const base = {
      kind: 'thinking_delta',
      requestId: uuid(),
      seq: 3,
      at: new Date().toISOString(),
    };
    expect(
      generationEventSchema.safeParse({ ...base, text: 'considering' }).success,
    ).toBe(true);
    expect(
      generationEventSchema.safeParse({ ...base, text: 'x'.repeat(500_000) })
        .success,
    ).toBe(false);
  });
});

describe('worker transport protocol v1', () => {
  it('accepts a valid generation.start envelope', () => {
    const parsed = mainToWorkerMessageSchema.safeParse({
      protocolVersion: 1,
      kind: 'generation.start',
      requestId: uuid(),
      seq: 0,
      payload: {
        providerId: 'mock',
        modelId: 'mock-static',
        messages: [{ role: 'user', content: 'ping' }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a wrong protocol version', () => {
    const parsed = mainToWorkerMessageSchema.safeParse({
      protocolVersion: 2,
      kind: 'generation.cancel',
      requestId: uuid(),
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a worker.ready lifecycle message', () => {
    const parsed = workerToMainMessageSchema.safeParse({
      protocolVersion: 1,
      kind: 'worker.ready',
      lifecycleId: uuid(),
      payload: { protocolVersion: 1 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a bounded thinking_delta generation event', () => {
    const envelope = (text: string) => ({
      protocolVersion: 1,
      kind: 'generation.event',
      requestId: uuid(),
      seq: 2,
      payload: { eventKind: 'thinking_delta', text },
    });
    expect(
      workerToMainMessageSchema.safeParse(envelope('considering')).success,
    ).toBe(true);
    expect(
      workerToMainMessageSchema.safeParse(envelope('x'.repeat(24_001))).success,
    ).toBe(false);
  });

  it('rejects an unknown worker message kind', () => {
    const parsed = workerToMainMessageSchema.safeParse({
      protocolVersion: 1,
      kind: 'worker.explode',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });
});

describe('hardware + status contracts', () => {
  it('validates a hardware profile and a status snapshot', () => {
    const profile = {
      platform: 'darwin',
      architecture: 'arm64',
      cpuLogicalCount: 8,
      totalMemoryBytes: 1,
      freeMemoryBytes: 1,
      freeDiskBytes: null,
      capturedAt: new Date().toISOString(),
      gpuName: null,
      gpuMemoryBytes: null,
      acceleration: 'metal' as const,
      notes: [],
    };
    expect(hardwareProfileSchema.safeParse(profile).success).toBe(true);

    expect(
      inferenceStatusGetOutputSchema.safeParse({
        worker: { state: 'ready', protocolVersion: INFERENCE_PROTOCOL_VERSION },
        providers: [],
      }).success,
    ).toBe(true);
  });

  it('validates a provider status with capabilities', () => {
    expect(
      providerStatusSchema.safeParse({
        providerId: 'mock',
        kind: 'mock',
        configured: true,
        reachable: true,
        lastCheckedAt: new Date().toISOString(),
        state: 'ready',
        capabilities: {
          text: 'supported',
          streaming: 'supported',
          structuredOutput: 'supported',
          tools: 'unsupported',
        },
      }).success,
    ).toBe(true);
  });
});

describe('bounded JSON Schema subset validator', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const },
      score: { type: 'integer' as const },
      ready: { type: 'boolean' as const },
      tags: { type: 'array' as const, items: { type: 'string' as const } },
    },
    required: ['title', 'score'],
  };

  it('accepts a conforming object', () => {
    const result = validateAgainstJsonSchema(
      { title: 'ok', score: 7, ready: true, tags: ['a', 'b'] },
      schema,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a missing required field', () => {
    const result = validateAgainstJsonSchema({ title: 'ok' }, schema);
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong scalar type', () => {
    const result = validateAgainstJsonSchema(
      { title: 'ok', score: 'seven' },
      schema,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects prototype-polluting JSON', () => {
    const parsed = safeParseJson('{"__proto__": {"polluted": true}}');
    expect(parsed).toBeUndefined();
  });

  it('parses ordinary JSON safely', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseJson('not json')).toBeUndefined();
  });
});
