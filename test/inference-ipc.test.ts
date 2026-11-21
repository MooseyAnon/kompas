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
import { ProviderManager } from '../src/main/modules/inference/provider-manager';
import { WorkerSupervisor } from '../src/main/modules/inference/worker-supervisor';
import { InMemoryTransport } from '../src/main/modules/inference/transport';
import { InferenceService } from '../src/main/modules/inference/inference.service';
import { MOCK_MODELS } from '../src/main/modules/inference/mock-provider';
import type {
  GenerationEvent,
  ResponseEnvelope,
} from '../src/shared/contracts';

const SECRET_PROMPT = 'ZZSECRETINTERVIEWPROMPT';

let workDir: string;
let logFile: string;
let storage: Storage;
let telemetry: TelemetryService;
let service: InferenceService;
let dispatcher: Dispatcher;

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-inference-'));
  logFile = path.join(workDir, 'app.jsonl');
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(logFile),
  });

  const providers = new ProviderManager();
  providers.register({
    providerId: 'mock',
    kind: 'mock',
    configured: true,
    dev: true,
  });
  const supervisor = new WorkerSupervisor({
    createTransport: () => new InMemoryTransport(),
    providerConfigs: providers.workerConfigs(),
    telemetry,
    startupTimeoutMs: 1000,
    statusTimeoutMs: 500,
  });
  service = new InferenceService({
    supervisor,
    providers,
    hardwareProbeDir: workDir,
    telemetry,
  });
  await service.start();

  dispatcher = createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry,
    inference: { service, devActions: true },
  });
});

afterEach(async () => {
  await service.stop();
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function send<T = unknown>(
  action: string,
  payload: unknown = {},
): Promise<ResponseEnvelope<T>> {
  return dispatcher.dispatch({
    requestId: crypto.randomUUID(),
    module: 'inference',
    version: 1,
    action,
    payload,
  }) as Promise<ResponseEnvelope<T>>;
}

describe('inference public IPC surface', () => {
  it('reports worker + provider status', async () => {
    const res = await send<{
      worker: { state: string; protocolVersion: number };
      providers: Array<{ providerId: string; state: string }>;
    }>('status.get');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.worker.state).toBe('ready');
      expect(res.data.worker.protocolVersion).toBe(1);
      expect(res.data.providers[0]).toMatchObject({
        providerId: 'mock',
        state: 'ready',
      });
    }
  });

  it('returns a hardware profile', async () => {
    const res = await send<{ profile: { platform: string } }>('hardware.get');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.profile.platform).toBe(process.platform);
    }
  });

  it('lists providers', async () => {
    const res = await send<{ items: Array<{ providerId: string }> }>(
      'providers.list',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items.map((p) => p.providerId)).toContain('mock');
    }
  });

  it('does NOT expose a generic generate action to the renderer', async () => {
    const res = await send('generate', {
      providerId: 'mock',
      modelId: 'mock-static',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NOT_FOUND');
    }
  });

  it('runs an end-to-end generation through the dev self-test action', async () => {
    const res = await send<{ status: string; output: string | null }>(
      '__dev.selfTest',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.status).toBe('completed');
      expect(res.data.output).toBe('echo:ping');
    }
  });

  it('retains separate reasoning and answer events through the scheduled service', async () => {
    for (const thinking of [true, false]) {
      const events: GenerationEvent[] = [];
      const result = await service.generate({
        callerModule: 'interviews',
        execution: { priority: 'interactive', onEvent: (e) => events.push(e) },
        providerId: 'mock',
        modelId: MOCK_MODELS.thinking,
        thinking,
        messages: [{ role: 'user', content: 'sample' }],
      });
      expect(result.status).toBe('completed');
      expect(events.some((e) => e.kind === 'thinking_delta')).toBe(thinking);
      expect(events.some((e) => e.kind === 'delta')).toBe(true);
      expect(events.at(-1)?.kind).toBe('completed');
      expect(events.map((e) => e.seq)).toEqual(
        events.map((e) => e.seq).sort((a, b) => a - b),
      );
      expect(String(result.output)).not.toContain('thinking');
    }
    const stored = JSON.stringify(
      storage.db.prepare('SELECT * FROM operation_runs').all(),
    );
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    expect(stored + log).not.toContain('mock reasoning');
    expect(stored + log).not.toContain('echo:sample');
  });
});

describe('inference telemetry privacy', () => {
  it('never records prompt or completion content', async () => {
    const result = await service.generate({
      callerModule: 'inference',
      execution: { priority: 'normal' },
      providerId: 'mock',
      modelId: 'mock-static',
      messages: [{ role: 'user', content: SECRET_PROMPT }],
    });
    expect(result.status).toBe('completed');
    // The echoed output itself contains the prompt; it must not be logged.
    expect(String(result.output)).toContain(SECRET_PROMPT);

    const logText = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8')
      : '';
    expect(logText).not.toContain(SECRET_PROMPT);

    const rows = storage.db
      .prepare('SELECT * FROM operation_runs')
      .all() as Array<Record<string, unknown>>;
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(SECRET_PROMPT);

    // A generation run was recorded with safe metadata only.
    const genRun = rows.find(
      (r) => r.module_id === 'inference' && r.operation === 'generation',
    );
    expect(genRun).toBeDefined();
    expect(String(genRun?.outcome)).toBe('success');
    const schedulerRuns = rows.filter((r) =>
      String(r.operation).startsWith('scheduler.'),
    );
    expect(schedulerRuns.map((r) => r.operation)).toEqual([
      'scheduler.queued',
      'scheduler.dispatched',
      'scheduler.completed',
    ]);
    const detail = JSON.parse(String(schedulerRuns[2].detail_json));
    expect(detail).toMatchObject({
      callerModule: 'inference',
      priority: 'normal',
      attemptsMade: 1,
      retriesUsed: 0,
      queueDepth: 0,
    });
  });
});
