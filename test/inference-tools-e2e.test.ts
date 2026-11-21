import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WorkerSupervisor } from '../src/main/modules/inference/worker-supervisor';
import { InMemoryTransport } from '../src/main/modules/inference/transport';
import { InferenceService } from '../src/main/modules/inference/inference.service';
import { ProviderManager } from '../src/main/modules/inference/provider-manager';
import { MOCK_MODELS } from '../src/main/modules/inference/mock-provider';
import { ToolRegistry } from '../src/main/core/tools/tool-registry';
import { ToolBroker } from '../src/main/core/tools/tool-broker';
import { registerExampleTools } from '../src/main/core/tools/example-tools';
import type { ToolExecutor } from '../src/main/core/tools/tool-broker';
import type { GenerationEvent, ToolResult } from '../src/shared/contracts';

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('condition not met in time');
}

function makeService(
  opts: { executor?: ToolExecutor; registry?: ToolRegistry } = {},
) {
  const transports: InMemoryTransport[] = [];
  const registry = opts.registry ?? new ToolRegistry();
  if (!opts.registry) {
    registerExampleTools(registry);
  }
  const broker = new ToolBroker({ registry });
  const providers = new ProviderManager();
  providers.register({
    providerId: 'mock',
    kind: 'mock',
    configured: true,
    dev: true,
  });
  const supervisor = new WorkerSupervisor({
    createTransport: () => {
      const transport = new InMemoryTransport();
      transports.push(transport);
      return transport;
    },
    providerConfigs: providers.workerConfigs(),
    startupTimeoutMs: 1000,
    statusTimeoutMs: 500,
    toolExecutor: opts.executor ?? broker,
  });
  const service = new InferenceService({
    supervisor,
    providers,
    toolBroker: broker,
  });
  return { service, supervisor, transports, broker, registry };
}

const user = [{ role: 'user' as const, content: 'go' }];

describe('tool loop end-to-end (worker <-> main <-> broker <-> handler)', () => {
  it('runs an authorised tool and returns its validated result to the model', async () => {
    const { service } = makeService();
    await service.start();
    const events: GenerationEvent[] = [];
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsAdd,
      messages: user,
      callerModule: 'examples',
      execution: { priority: 'normal', onEvent: (e) => events.push(e) },
      toolNames: ['examples.add_numbers'],
    });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('sum=5');
    const toolResults = events.filter((e) => e.kind === 'tool_result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ ok: true });
    await service.stop();
  });

  it('handles multiple proposed tool calls in one turn', async () => {
    const { service } = makeService();
    await service.start();
    const events: GenerationEvent[] = [];
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsMulti,
      messages: user,
      callerModule: 'examples',
      execution: { priority: 'normal', onEvent: (e) => events.push(e) },
      toolNames: ['examples.add_numbers'],
    });
    expect(result.status).toBe('completed');
    expect(events.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
    await service.stop();
  });

  it('never executes a proposed tool that is not in the run allowlist', async () => {
    const spy = vi.fn(() => ({ sum: 999 }));
    const registry = new ToolRegistry();
    registry.register({
      name: 'examples.add_numbers',
      version: 1,
      ownerModule: 'examples',
      description: 'spy add',
      inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
      jsonInputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      outputSchema: z.object({ sum: z.number() }).strict(),
      effect: 'read',
      permission: 'automatic',
      timeoutMs: 1000,
      maxResultBytes: 256,
      maxCallsPerRun: 3,
      handle: spy,
    });
    registry.register({
      name: 'examples.echo',
      version: 1,
      ownerModule: 'examples',
      description: 'echo length',
      inputSchema: z.object({ text: z.string() }).strict(),
      jsonInputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      outputSchema: z.object({ length: z.number() }).strict(),
      effect: 'read',
      permission: 'automatic',
      timeoutMs: 1000,
      maxResultBytes: 256,
      maxCallsPerRun: 3,
      handle: (a) => ({ length: (a as { text: string }).text.length }),
    });
    const { service } = makeService({ registry });
    await service.start();
    // The model proposes add_numbers, but the run only authorises echo.
    const events: GenerationEvent[] = [];
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsAdd,
      messages: user,
      callerModule: 'examples',
      execution: { priority: 'normal', onEvent: (e) => events.push(e) },
      toolNames: ['examples.echo'],
    });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('tool-denied');
    expect(spy).not.toHaveBeenCalled();
    expect(events.filter((e) => e.kind === 'tool_result')).toMatchObject([
      { ok: false },
    ]);
    await service.stop();
  });

  it('denies an unknown proposed tool safely', async () => {
    const { service } = makeService();
    await service.start();
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsUnknown,
      execution: { priority: 'normal' },
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.add_numbers'],
    });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('tool-denied');
    await service.stop();
  });

  it('denies malformed tool arguments without executing the handler', async () => {
    const { service } = makeService();
    await service.start();
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsBadArgs,
      execution: { priority: 'normal' },
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.add_numbers'],
    });
    expect(result.output).toBe('tool-denied');
    await service.stop();
  });

  it('denies a write/approval_required tool without approval', async () => {
    const { service } = makeService();
    await service.start();
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsWrite,
      execution: { priority: 'normal' },
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.write_note'],
    });
    expect(result.output).toBe('tool-denied');
    await service.stop();
  });

  it('terminates deterministically when the step budget is exceeded', async () => {
    const { service } = makeService();
    await service.start();
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsLoop,
      execution: { priority: 'normal' },
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.add_numbers'],
      toolPolicy: { maxSteps: 2 },
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LIMIT_EXCEEDED');
    await service.stop();
  });

  it('honours a tool execution timeout end-to-end', async () => {
    const { service } = makeService();
    await service.start();
    const events: GenerationEvent[] = [];
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsSlow,
      execution: { priority: 'normal', onEvent: (e) => events.push(e) },
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.sleep'],
    });
    expect(result.status).toBe('completed');
    expect(events.filter((e) => e.kind === 'tool_result')).toMatchObject([
      { ok: false },
    ]);
    await service.stop();
  });

  it('reports an honest CAPABILITY_UNSUPPORTED for a tool-incapable model', async () => {
    const { service } = makeService();
    await service.start();
    const result = await service.generate({
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsUnsupported,
      execution: { priority: 'normal' },
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.add_numbers'],
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('CAPABILITY_UNSUPPORTED');
    await service.stop();
  });
});

describe('tool loop cancellation and worker crash', () => {
  it('cancels a run while a tool execution is in flight', async () => {
    let called = false;
    const hung: ToolExecutor = {
      execute: () => {
        called = true;
        return new Promise<ToolResult>(() => {});
      },
    };
    const { service } = makeService({ executor: hung });
    await service.start();
    const requestId = crypto.randomUUID();
    const promise = service.generate({
      requestId,
      execution: { priority: 'normal' },
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsAdd,
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.add_numbers'],
    });
    await waitFor(() => called);
    await service.cancel(requestId);
    const result = await promise;
    expect(result.status).toBe('cancelled');
    await service.stop();
  });

  it('fails in-flight tool runs when the worker crashes', async () => {
    let called = false;
    const hung: ToolExecutor = {
      execute: () => {
        called = true;
        return new Promise<ToolResult>(() => {});
      },
    };
    const { service, transports } = makeService({ executor: hung });
    await service.start();
    const requestId = crypto.randomUUID();
    const promise = service.generate({
      requestId,
      execution: { priority: 'normal', retry: { maxRetries: 0 } },
      providerId: 'mock',
      modelId: MOCK_MODELS.toolsAdd,
      messages: user,
      callerModule: 'examples',
      toolNames: ['examples.add_numbers'],
    });
    await waitFor(() => called);
    transports[0].simulateExit(1);
    const result = await promise;
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('WORKER_EXITED');
    await service.stop();
  });
});
