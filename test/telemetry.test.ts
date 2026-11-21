import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/core/db/database';
import type { SqliteDatabase } from '../src/main/core/db/connection';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { createAppDispatcher } from '../src/main/core/registry';

let workDir: string;
let db: SqliteDatabase;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-telemetry-'));
  db = openDatabase(path.join(workDir, 'app.sqlite')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function makeService(): { service: TelemetryService; logFile: string } {
  const logFile = path.join(workDir, 'app.jsonl');
  const service = new TelemetryService({
    repository: new TelemetryRepository(db),
    logger: new JsonlLogger(logFile),
  });
  return { service, logFile };
}

interface DetailRow {
  detail_json: string | null;
}

describe('TelemetryService.record', () => {
  it('records a run to SQLite and a JSONL line', () => {
    const { service, logFile } = makeService();
    service.record({
      moduleId: 'system',
      operation: 'boot',
      outcome: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.120Z',
      correlationId: 'corr-1',
    });

    const runs = service.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      moduleId: 'system',
      operation: 'boot',
      outcome: 'success',
      durationMs: 120,
      errorCode: null,
    });

    const logLines = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(logLines).toHaveLength(1);
    const parsed = JSON.parse(logLines[0]);
    expect(parsed).toMatchObject({
      module: 'system',
      operation: 'boot',
      outcome: 'success',
      correlationId: 'corr-1',
    });
  });

  it('lists newest first and does not expose detail_json', () => {
    const { service } = makeService();
    service.record({
      moduleId: 'a',
      operation: 'one',
      outcome: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    });
    service.record({
      moduleId: 'b',
      operation: 'two',
      outcome: 'failure',
      startedAt: '2026-01-02T00:00:00.000Z',
      finishedAt: '2026-01-02T00:00:00.500Z',
      errorCode: 'IO_ERROR',
    });

    const runs = service.list();
    expect(runs.map((r) => r.operation)).toEqual(['two', 'one']);
    expect(runs[0]).not.toHaveProperty('detailJson');
    expect(runs[0]).not.toHaveProperty('detail_json');
  });

  it('stores safe detail but drops oversized detail', () => {
    const { service } = makeService();
    service.record({
      moduleId: 'docs',
      operation: 'import',
      outcome: 'success',
      detail: { sizeBytes: 1024, category: 'cv' },
    });
    service.record({
      moduleId: 'docs',
      operation: 'import',
      outcome: 'success',
      detail: { blob: 'x'.repeat(5000) },
    });

    const rows = db
      .prepare('SELECT detail_json FROM operation_runs ORDER BY rowid')
      .all() as DetailRow[];
    expect(JSON.parse(rows[0].detail_json ?? 'null')).toEqual({
      sizeBytes: 1024,
      category: 'cv',
    });
    expect(rows[1].detail_json).toBeNull();
  });

  it('never throws from record even without a repository', () => {
    const service = new TelemetryService({});
    expect(() =>
      service.record({ moduleId: 'x', operation: 'y', outcome: 'success' }),
    ).not.toThrow();
    expect(service.list()).toEqual([]);
  });
});

describe('telemetry.runs.list via dispatcher', () => {
  function dispatcherWithTelemetry() {
    const { service } = makeService();
    const dispatcher = createAppDispatcher({
      getAppVersion: () => '1.0.0',
      isStorageReady: () => true,
      telemetry: service,
    });
    return { dispatcher, service };
  }

  function envelope(overrides: Record<string, unknown> = {}) {
    return {
      requestId: crypto.randomUUID(),
      module: 'telemetry',
      version: 1,
      action: 'runs.list',
      payload: {},
      ...overrides,
    };
  }

  it('returns recorded runs with only safe fields', async () => {
    const { dispatcher, service } = dispatcherWithTelemetry();
    service.record({
      moduleId: 'system',
      operation: 'boot',
      outcome: 'success',
    });

    const response = await dispatcher.dispatch(envelope());
    expect(response.ok).toBe(true);
    if (response.ok) {
      const data = response.data as { items: unknown[] };
      expect(data.items).toHaveLength(1);
      const item = data.items[0] as Record<string, unknown>;
      expect(item).toHaveProperty('moduleId', 'system');
      expect(item).not.toHaveProperty('detailJson');
    }
  });

  it('accepts a valid limit', async () => {
    const { dispatcher } = dispatcherWithTelemetry();
    const response = await dispatcher.dispatch(
      envelope({ payload: { limit: 10 } }),
    );
    expect(response.ok).toBe(true);
  });

  it('rejects a non-positive, non-integer or too-large limit', async () => {
    const { dispatcher } = dispatcherWithTelemetry();
    for (const bad of [0, -1, 2.5, 101]) {
      const response = await dispatcher.dispatch(
        envelope({ payload: { limit: bad } }),
      );
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error.code).toBe('INVALID_INPUT');
      }
    }
  });

  it('rejects unexpected payload fields', async () => {
    const { dispatcher } = dispatcherWithTelemetry();
    const response = await dispatcher.dispatch(
      envelope({ payload: { unexpected: true } }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('records a sanitised failure row when an IPC request fails', async () => {
    const { dispatcher, service } = dispatcherWithTelemetry();
    const response = await dispatcher.dispatch(
      envelope({ module: 'ghost', action: 'nope', version: 1 }),
    );
    expect(response.ok).toBe(false);

    const runs = service.list();
    const failure = runs.find((r) => r.moduleId === 'ghost');
    expect(failure).toBeDefined();
    expect(failure?.outcome).toBe('failure');
    expect(failure?.errorCode).toBe('NOT_FOUND');
  });
});
