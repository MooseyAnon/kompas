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
import type { ResponseEnvelope } from '../src/shared/contracts';

// Markers that would reveal personal/profile/document content if ever logged.
const SECRET_NAME = 'ZZTOPSECRETNAME';
const SECRET_SUMMARY = 'QQSENSITIVESUMMARYTEXT';
const SECRET_ROLE = 'WWCONFIDENTIALTARGETROLE';
const SECRET_FILENAME = 'VVPRIVATE_CV_FILENAME.pdf';
const SECRET_PDF_BODY = 'UUSECRETDOCUMENTBODYCONTENT';

let workDir: string;
let fixtureDir: string;
let logFile: string;
let storage: Storage;
let dispatcher: Dispatcher;
let pickResult: string | null;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-privacy-'));
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-privacy-fx-'));
  logFile = path.join(workDir, 'app.jsonl');
  storage = openStorage(workDir);
  const telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(logFile),
  });
  pickResult = null;
  dispatcher = createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry,
    storage: { db: storage.db, fileStore: storage.fileStore },
    documentsPlatform: {
      pickFile: async () => pickResult,
      openPath: async () => '',
    },
  });
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

async function send<T = unknown>(
  module: string,
  action: string,
  payload: unknown,
): Promise<ResponseEnvelope<T>> {
  return dispatcher.dispatch({
    requestId: crypto.randomUUID(),
    module,
    version: 1,
    action,
    payload,
  }) as Promise<ResponseEnvelope<T>>;
}

function writeSecretPdf(): string {
  const file = path.join(fixtureDir, SECRET_FILENAME);
  fs.writeFileSync(
    file,
    Buffer.from(`%PDF-1.4\n${SECRET_PDF_BODY}\n`, 'latin1'),
  );
  return file;
}

describe('telemetry never records personal content', () => {
  it('scrubs profile text, target text, filenames and document bodies from logs', async () => {
    // Enter personal data and import a document through the real boundary.
    const profile = await send('identity', 'profile.update', {
      patch: { displayName: SECRET_NAME, summary: SECRET_SUMMARY },
    });
    expect(profile.ok).toBe(true);

    const target = await send('identity', 'targets.create', {
      roleTitle: SECRET_ROLE,
    });
    expect(target.ok).toBe(true);

    pickResult = writeSecretPdf();
    const imported = await send('documents', 'import', { category: 'cv' });
    expect(imported.ok).toBe(true);

    // Produce a failure run too (telemetry records failures by module/action/code).
    const bad = await send('documents', 'open', { id: 'does-not-exist' });
    expect(bad.ok).toBe(false);

    const secrets = [
      SECRET_NAME,
      SECRET_SUMMARY,
      SECRET_ROLE,
      SECRET_FILENAME,
      'VVPRIVATE_CV_FILENAME',
      SECRET_PDF_BODY,
    ];

    // 1) The JSONL operational log must contain no personal content.
    const logText = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8')
      : '';
    expect(logText.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(logText).not.toContain(secret);
    }

    // 2) The operation_runs table (incl. detail_json) must contain no personal content.
    const rows = storage.db
      .prepare('SELECT * FROM operation_runs')
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const serialisedRows = JSON.stringify(rows);
    for (const secret of secrets) {
      expect(serialisedRows).not.toContain(secret);
    }

    // Sanity: a document import success run was actually recorded.
    const importRun = rows.find(
      (r) => r.module_id === 'documents' && r.operation === 'import',
    );
    expect(importRun).toBeDefined();
    expect(String(importRun?.outcome)).toBe('success');
  });
});
