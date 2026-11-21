import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { InferenceSettingsRepository } from '../src/main/modules/inference/settings.repository';
import type {
  InferenceSettingsGetOutput,
  InferenceOperationSummary,
  InferenceTestSnapshot,
  ResponseEnvelope,
} from '../src/shared/contracts';
import { INFERENCE_LIMITS } from '../src/shared/contracts';

let workDir: string;
let logFile: string;
let storage: Storage;
let service: InferenceService;
let supervisor: WorkerSupervisor;
let dispatcher: Dispatcher;

function buildStack(dir: string, log: string) {
  const store = openStorage(dir);
  const tel = new TelemetryService({
    repository: new TelemetryRepository(store.db),
    logger: new JsonlLogger(log),
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
    telemetry: tel,
    startupTimeoutMs: 1000,
    statusTimeoutMs: 500,
  });
  const svc = new InferenceService({
    supervisor,
    providers,
    hardwareProbeDir: dir,
    settingsRepository: new InferenceSettingsRepository(store.db),
    diagnostics: tel,
  });
  const disp = createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry: tel,
    inference: { service: svc, devActions: true },
  });
  return { store, tel, svc, disp, supervisor };
}

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-'));
  logFile = path.join(workDir, 'app.jsonl');
  const stack = buildStack(workDir, logFile);
  storage = stack.store;
  service = stack.svc;
  supervisor = stack.supervisor;
  dispatcher = stack.disp;
  await service.start();
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

function unwrap<T>(res: ResponseEnvelope<T>): T {
  if (!res.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  }
  return res.data;
}

async function waitForTest(
  testId: string,
  timeoutMs = 3000,
): Promise<InferenceTestSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await send<{ test: InferenceTestSnapshot }>('test.get', {
      testId,
    });
    const snapshot = unwrap(res).test;
    if (snapshot.status !== 'running' || Date.now() > deadline) {
      return snapshot;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('inference settings persistence', () => {
  it('returns defaults with no saved preference', async () => {
    const data = unwrap(await send<InferenceSettingsGetOutput>('settings.get'));
    expect(data.settings.mode).toBe('local_only');
    expect(data.settings.providerId).toBeNull();
    expect(data.settings.modelId).toBeNull();
    expect(data.resolvedModel).toBeNull();
    expect(data.warnings).toEqual([]);
  });

  it('saves and resolves a selected installed local model', async () => {
    const updated = unwrap(
      await send<{ settings: { providerId: string; modelId: string } }>(
        'settings.update',
        { patch: { providerId: 'mock', modelId: 'mock-static' } },
      ),
    );
    expect(updated.settings.providerId).toBe('mock');
    expect(updated.settings.modelId).toBe('mock-static');

    const snapshot = unwrap(
      await send<InferenceSettingsGetOutput>('settings.get'),
    );
    expect(snapshot.resolvedModel?.id).toBe('mock-static');
    expect(snapshot.resolvedModel?.locality).toBe('local');
    expect(snapshot.warnings).toEqual([]);
  });

  it('keeps a removed model saved but flags it unavailable', async () => {
    await send('settings.update', {
      patch: { providerId: 'mock', modelId: 'ghost-model' },
    });
    const snapshot = unwrap(
      await send<InferenceSettingsGetOutput>('settings.get'),
    );
    expect(snapshot.settings.modelId).toBe('ghost-model');
    expect(snapshot.resolvedModel).toBeNull();
    expect(snapshot.warnings.some((w) => w.includes('ghost-model'))).toBe(true);
  });

  it('rejects an unknown provider', async () => {
    const res = await send('settings.update', {
      patch: { providerId: 'ghost' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects an out-of-bounds generation timeout at the IPC boundary', async () => {
    const res = await send('settings.update', {
      patch: { generationTimeoutMs: 5 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('persists longer targets and rejects a value whose doubled timer would overflow', async () => {
    const saved = unwrap(
      await send<InferenceSettingsGetOutput>('settings.update', {
        patch: { generationTimeoutMs: 900_000 },
      }),
    );
    expect(saved.settings.generationTimeoutMs).toBe(900_000);
    const tooLong = await send('settings.update', {
      patch: {
        generationTimeoutMs: INFERENCE_LIMITS.maxConfigurableTimeoutMs + 1,
      },
    });
    expect(tooLong.ok).toBe(false);
    expect(
      unwrap(await send<InferenceSettingsGetOutput>('settings.get')).settings
        .generationTimeoutMs,
    ).toBe(900_000);
  });

  it('uses twice the saved target as the shared hard deadline, unless a caller sets a shorter one', async () => {
    const dispatch = vi.spyOn(supervisor, 'generate');
    const entry = {
      callerModule: 'identity',
      providerId: 'mock',
      modelId: 'mock-static',
      messages: [{ role: 'user' as const, content: 'ping' }],
      execution: { priority: 'interactive' as const },
    };

    expect((await service.generate(entry)).status).toBe('completed');
    expect(dispatch.mock.lastCall?.[0].limits?.timeoutMs).toBeGreaterThan(
      599_000,
    );
    expect(dispatch.mock.lastCall?.[0].limits?.timeoutMs).toBeLessThanOrEqual(
      600_000,
    );

    await send('settings.update', { patch: { generationTimeoutMs: 900_000 } });
    expect((await service.generate(entry)).status).toBe('completed');
    expect(dispatch.mock.lastCall?.[0].limits?.timeoutMs).toBeGreaterThan(
      1_799_000,
    );
    expect(dispatch.mock.lastCall?.[0].limits?.timeoutMs).toBeLessThanOrEqual(
      1_800_000,
    );
    expect(
      (await service.generate({ ...entry, limits: { timeoutMs: 4_000 } }))
        .status,
    ).toBe('completed');
    expect(dispatch.mock.lastCall?.[0].limits?.timeoutMs).toBeLessThanOrEqual(
      4_000,
    );
  });

  it('distinguishes an absent key from an explicit null', async () => {
    await send('settings.update', {
      patch: { providerId: 'mock', modelId: 'mock-static' },
    });
    // Explicit null clears only the model, keeping the provider.
    const cleared = unwrap(
      await send<{
        settings: { providerId: string | null; modelId: string | null };
      }>('settings.update', { patch: { modelId: null } }),
    );
    expect(cleared.settings.providerId).toBe('mock');
    expect(cleared.settings.modelId).toBeNull();

    const snapshot = unwrap(
      await send<InferenceSettingsGetOutput>('settings.get'),
    );
    expect(snapshot.warnings.some((w) => w.includes('No model'))).toBe(true);
  });

  it('survives a service/storage restart', async () => {
    await send('settings.update', {
      patch: {
        providerId: 'mock',
        modelId: 'mock-static',
        generationTimeoutMs: 900_000,
      },
    });
    await service.stop();
    storage.close();

    const stack = buildStack(workDir, logFile);
    storage = stack.store;
    service = stack.svc;
    supervisor = stack.supervisor;
    dispatcher = stack.disp;
    await service.start();

    const snapshot = unwrap(
      await send<InferenceSettingsGetOutput>('settings.get'),
    );
    expect(snapshot.settings.providerId).toBe('mock');
    expect(snapshot.settings.modelId).toBe('mock-static');
    expect(snapshot.settings.generationTimeoutMs).toBe(900_000);
    expect(snapshot.resolvedModel?.id).toBe('mock-static');
  });
});

describe('inference connectivity test', () => {
  it('runs a fixed-prompt test against the selected local model', async () => {
    await send('settings.update', {
      patch: { providerId: 'mock', modelId: 'mock-static' },
    });
    const run = unwrap(
      await send<{ testId: string; status: string }>('test.run'),
    );
    expect(run.status).toBe('started');

    const snapshot = await waitForTest(run.testId);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.passed).toBe(true);
    expect(snapshot.prompt).toBe('Reply with exactly: OK');
    expect(snapshot.replyPreview).toContain('Reply with exactly: OK');
    expect(snapshot.durationMs).not.toBeNull();
  });

  it('refuses to test when no suitable local model is selected', async () => {
    const res = await send('test.run');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('CONFLICT');
    }
  });

  it('cancels a running test and is idempotent afterwards', async () => {
    await send('settings.update', {
      patch: { providerId: 'mock', modelId: 'mock-slow' },
    });
    const run = unwrap(await send<{ testId: string }>('test.run'));

    const cancelled = unwrap(
      await send<{ cancelled: boolean }>('test.cancel', { testId: run.testId }),
    );
    expect(cancelled.cancelled).toBe(true);

    const snapshot = await waitForTest(run.testId);
    expect(snapshot.status).toBe('cancelled');

    // Cancelling an already-settled test is idempotent (returns false).
    const again = unwrap(
      await send<{ cancelled: boolean }>('test.cancel', { testId: run.testId }),
    );
    expect(again.cancelled).toBe(false);
  });

  it('returns NOT_FOUND for an unknown test id', async () => {
    const res = await send('test.get', { testId: crypto.randomUUID() });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('inference diagnostics', () => {
  it('projects safe metadata-only operation summaries', async () => {
    await send('settings.update', {
      patch: { providerId: 'mock', modelId: 'mock-static' },
    });
    const run = unwrap(await send<{ testId: string }>('test.run'));
    await waitForTest(run.testId);

    const diag = unwrap(
      await send<{ items: InferenceOperationSummary[] }>('diagnostics.list', {
        limit: 10,
      }),
    );
    const testOp = diag.items.find((op) => op.operation === 'test');
    expect(testOp).toBeDefined();
    expect(testOp?.modelId).toBe('mock-static');
    expect(testOp?.providerId).toBe('mock');
    expect(testOp?.status).toBe('success');

    // Allowlisted keys only — no free-form text fields leak through.
    const allowed = new Set([
      'id',
      'operation',
      'status',
      'startedAt',
      'finishedAt',
      'durationMs',
      'firstTokenMs',
      'providerId',
      'modelId',
      'inputTokens',
      'outputTokens',
      'toolCalls',
      'errorCode',
    ]);
    for (const op of diag.items) {
      for (const key of Object.keys(op)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it('never persists the fixed prompt or the model reply', async () => {
    await send('settings.update', {
      patch: { providerId: 'mock', modelId: 'mock-static' },
    });
    const run = unwrap(await send<{ testId: string }>('test.run'));
    const snapshot = await waitForTest(run.testId);
    // The live snapshot echoes the reply, proving the model actually ran.
    expect(snapshot.replyPreview).toContain('Reply with exactly: OK');

    const rows = storage.db
      .prepare('SELECT * FROM operation_runs')
      .all() as Array<Record<string, unknown>>;
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('Reply with exactly');
    expect(serialised).not.toContain('echo:');

    const logText = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8')
      : '';
    expect(logText).not.toContain('Reply with exactly');
    expect(logText).not.toContain('echo:');
  });
});
