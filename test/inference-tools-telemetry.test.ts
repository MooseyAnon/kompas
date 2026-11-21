import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { ToolRegistry } from '../src/main/core/tools/tool-registry';
import { ToolBroker } from '../src/main/core/tools/tool-broker';
import {
  EXAMPLE_TOOL_NAMES,
  registerExampleTools,
} from '../src/main/core/tools/example-tools';

const CANARY = 'ZZTOOLARGCANARY42';

let workDir: string;
let logFile: string;
let storage: Storage;
let telemetry: TelemetryService;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tools-'));
  logFile = path.join(workDir, 'app.jsonl');
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(logFile),
  });
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('tool telemetry privacy', () => {
  it('records safe tool metadata but never raw arguments or results', async () => {
    const registry = new ToolRegistry();
    registerExampleTools(registry);
    const broker = new ToolBroker({ registry, telemetry });

    const runId = crypto.randomUUID();
    broker.openRun({
      runId,
      callerModule: 'examples',
      requestedToolNames: [EXAMPLE_TOOL_NAMES.echo],
    });
    const result = await broker.execute(runId, {
      toolCallId: 'c0',
      toolName: EXAMPLE_TOOL_NAMES.echo,
      version: 1,
      arguments: { text: CANARY },
    });
    broker.closeRun(runId);

    // The tool ran and returned a validated result derived from the canary...
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ length: CANARY.length });

    // ...but neither the JSONL log nor the DB contains the canary argument.
    const logText = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8')
      : '';
    expect(logText).not.toContain(CANARY);
    expect(logText).toContain('tool.execute');

    const rows = storage.db
      .prepare('SELECT * FROM operation_runs')
      .all() as Array<Record<string, unknown>>;
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(CANARY);

    // A tool-execution run was recorded with owner attribution.
    const toolRun = rows.find(
      (r) => r.operation === 'tool.execute' && r.module_id === 'examples',
    );
    expect(toolRun).toBeDefined();
    expect(String(toolRun?.outcome)).toBe('success');
    // runId correlation is carried in the JSONL log (never personal content).
    expect(logText).toContain(runId);
  });
});
