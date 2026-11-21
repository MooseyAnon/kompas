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
import {
  DOCUMENT_MAX_BYTES,
  type ResponseEnvelope,
} from '../src/shared/contracts';

let workDir: string;
let fixtureDir: string;
let storage: Storage;
let dispatcher: Dispatcher;
let telemetry: TelemetryService;

/** Mutable picker/opener fakes so each test controls the native boundary. */
let pickResult: string | null;
let openResult: string;
let openedPaths: string[];

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-docs-'));
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fixtures-'));
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(path.join(workDir, 'app.jsonl')),
  });
  pickResult = null;
  openResult = '';
  openedPaths = [];
  dispatcher = buildDispatcher();
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function buildDispatcher(): Dispatcher {
  return createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry,
    storage: { db: storage.db, fileStore: storage.fileStore },
    documentsPlatform: {
      pickFile: async () => pickResult,
      openPath: async (absolutePath: string) => {
        openedPaths.push(absolutePath);
        return openResult;
      },
    },
  });
}

async function send<T = unknown>(
  action: string,
  payload: unknown,
): Promise<ResponseEnvelope<T>> {
  return dispatcher.dispatch({
    requestId: crypto.randomUUID(),
    module: 'documents',
    version: 1,
    action,
    payload,
  }) as Promise<ResponseEnvelope<T>>;
}

function ok<T>(response: ResponseEnvelope<T>): T {
  if (!response.ok) {
    throw new Error(`expected ok, got ${response.error.code}`);
  }
  return response.data;
}

function writePdfFixture(name = 'resume.pdf'): string {
  const file = path.join(fixtureDir, name);
  fs.writeFileSync(file, Buffer.from('%PDF-1.4\n%fake pdf body\n', 'latin1'));
  return file;
}

function writeDocxFixture(name = 'letter.docx'): string {
  const file = path.join(fixtureDir, name);
  const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  fs.writeFileSync(file, Buffer.concat([zipHeader, Buffer.from('docx body')]));
  return file;
}

interface ImportData {
  cancelled: boolean;
  item?: {
    id: string;
    originalName: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
  };
}

describe('documents import lifecycle', () => {
  it('imports a PDF, stores it with a checksum and lists it (no internal path)', async () => {
    const fixture = writePdfFixture();
    pickResult = fixture;

    const data = await send<ImportData>('import', { category: 'cv' });
    const result = ok(data);
    expect(result.cancelled).toBe(false);
    const item = result.item!;
    expect(item.originalName).toBe('resume.pdf');
    expect(item.mediaType).toBe('application/pdf');
    expect(item.sizeBytes).toBe(fs.statSync(fixture).size);
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item).not.toHaveProperty('relativePath');
    expect(item).not.toHaveProperty('relative_path');

    const list = ok(
      await send<{ items: Array<{ id: string }> }>('list', {}),
    ).items;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(item.id);

    // A real managed file exists on disk under the originals root.
    const originals = fs.readdirSync(storage.layout.documentsOriginalsDir);
    expect(originals).toHaveLength(1);

    const runs = telemetry.list();
    expect(runs.find((r) => r.moduleId === 'documents')?.outcome).toBe(
      'success',
    );
  });

  it('imports a DOCX via magic-byte validation', async () => {
    pickResult = writeDocxFixture();
    const result = ok(await send<ImportData>('import', { category: 'other' }));
    expect(result.item?.mediaType).toContain('wordprocessingml');
  });

  it('treats picker cancellation as a non-error', async () => {
    pickResult = null;
    const result = ok(await send<ImportData>('import', { category: 'cv' }));
    expect(result.cancelled).toBe(true);
    const runs = telemetry.list();
    const docRun = runs.find((r) => r.moduleId === 'documents');
    expect(docRun?.outcome).toBe('cancelled');
  });

  it('opens a stored document by id through the OS opener', async () => {
    pickResult = writePdfFixture();
    const item = ok(await send<ImportData>('import', { category: 'cv' })).item!;

    const opened = ok(await send<{ opened: true }>('open', { id: item.id }));
    expect(opened.opened).toBe(true);
    expect(openedPaths).toHaveLength(1);
    expect(openedPaths[0]).toContain(storage.layout.documentsOriginalsDir);
  });

  it('reports a meaningful error when the managed file is missing', async () => {
    pickResult = writePdfFixture();
    const item = ok(await send<ImportData>('import', { category: 'cv' })).item!;

    // Simulate an externally deleted managed file.
    for (const entry of fs.readdirSync(storage.layout.documentsOriginalsDir)) {
      fs.rmSync(path.join(storage.layout.documentsOriginalsDir, entry));
    }

    const response = await send('open', { id: item.id });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('IO_ERROR');
    }
  });

  it('removes a document and deletes the managed file', async () => {
    pickResult = writePdfFixture();
    const item = ok(await send<ImportData>('import', { category: 'cv' })).item!;

    const removed = ok(
      await send<{ removed: true }>('remove', { id: item.id }),
    );
    expect(removed.removed).toBe(true);

    const list = ok(await send<{ items: unknown[] }>('list', {})).items;
    expect(list).toHaveLength(0);
    expect(fs.readdirSync(storage.layout.documentsOriginalsDir)).toHaveLength(
      0,
    );
  });
});

describe('documents validation', () => {
  it('rejects an unsupported file type', async () => {
    const file = path.join(fixtureDir, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    pickResult = file;
    const response = await send('import', { category: 'other' });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects a file whose content does not match its extension', async () => {
    const file = path.join(fixtureDir, 'fake.pdf');
    fs.writeFileSync(file, 'this is not a pdf');
    pickResult = file;
    const response = await send('import', { category: 'cv' });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects a file larger than the import limit', async () => {
    const file = path.join(fixtureDir, 'big.pdf');
    fs.writeFileSync(file, Buffer.from('%PDF-1.4', 'latin1'));
    // Sparse-truncate past the limit without writing all the bytes.
    fs.truncateSync(file, DOCUMENT_MAX_BYTES + 1);
    pickResult = file;
    const response = await send('import', { category: 'cv' });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('returns NOT_FOUND for opening or removing an unknown id', async () => {
    const open = await send('open', { id: crypto.randomUUID() });
    const remove = await send('remove', { id: crypto.randomUUID() });
    expect(open.ok).toBe(false);
    expect(remove.ok).toBe(false);
    if (!open.ok) {
      expect(open.error.code).toBe('NOT_FOUND');
    }
    if (!remove.ok) {
      expect(remove.error.code).toBe('NOT_FOUND');
    }
  });
});
