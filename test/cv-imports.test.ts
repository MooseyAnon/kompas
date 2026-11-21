import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import PDFKit from 'pdfkit';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import { DocumentsRepository } from '../src/main/modules/documents/documents.repository';
import { DocumentsService } from '../src/main/modules/documents/documents.service';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import {
  ExtractionRegistry,
  PdfExtractionAdapter,
  DocxExtractionAdapter,
  ExtractionError,
  type ExtractedDocument,
} from '../src/main/modules/documents/extraction';
import { parseCv } from '../src/main/modules/cv-imports/parser';
import { resolveAmbiguity } from '../src/main/modules/cv-imports/model';
import type {
  GenerationEntry,
  InferenceService,
} from '../src/main/modules/inference/inference.service';
import type {
  CvImport,
  InferenceSettingsGetOutput,
  GenerationResult,
} from '../src/shared/contracts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cv-'));
  dirs.push(dir);
  return dir;
}
async function pdf(
  lines: string[],
  pages = 1,
  encrypted = false,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage();
    lines.forEach((line, i) =>
      page.drawText(line, { x: 50, y: 700 - 20 * i, size: 12, font }),
    );
  }
  if (encrypted) throw new Error('fixture encryption unsupported');
  return doc.save();
}
async function docx(lines: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}
const lines = [
  'Name: Canary Person',
  'Email: canary@example.test',
  'Phone: +1 202 555 0123',
  'Location: Boston',
  'Experience',
  'Engineer at Example Company',
  '2020 - 2023',
  'Education',
  'Researcher at Example University',
  'Skills',
  'TypeScript, SQL',
];
function localModel(): InferenceSettingsGetOutput {
  return {
    settings: {
      mode: 'local_only',
      providerId: 'mock',
      modelId: 'mock-local',
      generationTimeoutMs: 5000,
      updatedAt: new Date().toISOString(),
    },
    resolvedModel: {
      id: 'mock-local',
      providerId: 'mock',
      displayName: 'Mock',
      locality: 'local',
      installed: true,
    },
    warnings: [],
  };
}

describe('CV extraction boundaries', () => {
  it('normalizes real multi-page PDF and DOCX into the same parser with source references', async () => {
    const registry = new ExtractionRegistry([
      new PdfExtractionAdapter(),
      new DocxExtractionAdapter(),
    ]);
    for (const [type, bytes] of [
      ['application/pdf', await pdf(lines, 2)],
      [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        await docx(lines),
      ],
    ] as const) {
      const extracted = await registry.extract(type, bytes);
      const { draft, diagnostics } = parseCv(extracted);
      expect(draft.profile.displayName.value).toBe('Canary Person');
      expect(draft.extras.email.value).toBe('canary@example.test');
      expect(
        draft.experiences.some(
          (item) => item.organisation.value === 'Example Company',
        ),
      ).toBe(true);
      expect(draft.experiences[0].startDate.status).toBe('ambiguous');
      expect(diagnostics.detected).toBeGreaterThan(2);
      expect(diagnostics.modelAttempted).toBe(false);
    }
    const multi = await registry.extract(
      'application/pdf',
      await pdf(lines, 2),
    );
    expect(multi.pageCount).toBe(2);
    expect(multi.blocks.some((block) => block.page === 2)).toBe(true);
  });
  it('allows a fake registered adapter without changing the CV parser', async () => {
    const registry = new ExtractionRegistry([
      {
        id: 'fake',
        mediaType: 'test/fake',
        extract: async (): Promise<ExtractedDocument> => ({
          adapterId: 'fake',
          adapterVersion: '1',
          blocks: [{ kind: 'line', text: 'Name: Sample Person' }],
          text: 'Name: Sample Person',
          quality: 'usable',
          warnings: [],
        }),
      },
    ]);
    expect(
      parseCv(await registry.extract('test/fake', new Uint8Array())).draft
        .profile.displayName.value,
    ).toBe('Sample Person');
    await expect(
      registry.extract('test/unknown', new Uint8Array()),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
  it('rejects corrupt, oversized, and inflated DOCX; scan-only PDF is insufficient', async () => {
    const registry = new ExtractionRegistry([
      new PdfExtractionAdapter(),
      new DocxExtractionAdapter(),
    ]);
    await expect(
      registry.extract('application/pdf', Buffer.from('%PDF-not-real')),
    ).rejects.toMatchObject({ code: 'CORRUPT_DOCUMENT' });
    expect(
      (await registry.extract('application/pdf', await pdf([], 1))).quality,
    ).toBe('insufficient_text');
    await expect(
      registry.extract('application/pdf', new Uint8Array(26 * 1024 * 1024)),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(
      registry.extract(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        Buffer.from('PK\x03\x04junk'),
      ),
    ).rejects.toMatchObject({ code: 'CORRUPT_DOCUMENT' });
    const zip = new JSZip();
    zip.file('word/document.xml', 'x'.repeat(33 * 1024 * 1024));
    zip.file('[Content_Types].xml', '<Types/>');
    await expect(
      registry.extract(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        await zip.generateAsync({ type: 'uint8array' }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(new ExtractionError('CANCELLED').code).toBe('CANCELLED');
  });
  it('refuses password-encrypted PDFs explicitly', async () => {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFKit({
        userPassword: 'secret',
        ownerPassword: 'owner',
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.text('Name: Private Person');
      doc.end();
    });
    await expect(
      new PdfExtractionAdapter().extract(bytes),
    ).rejects.toMatchObject({ code: 'ENCRYPTED_DOCUMENT' });
  });
  it('flags suspicious PDF reading order when text returns to a previous column', async () => {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFKit({ margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.text('Left heading', 40, 80, { lineBreak: false });
      doc.text('Right heading', 320, 80, { lineBreak: false });
      doc.text('Left body', 40, 80, { lineBreak: false });
      doc.end();
    });
    const result = await new PdfExtractionAdapter().extract(bytes);
    expect(result.text).toContain('Left heading');
    expect(result.warnings).toContain('reading_order_uncertain');
  });
});

describe('CV inference and persistence', () => {
  it('only sends bounded ambiguous evidence, rejects hallucination and preserves direct fields', async () => {
    const extracted: ExtractedDocument = {
      adapterId: 'fake',
      adapterVersion: '1',
      quality: 'usable',
      warnings: [],
      text: 'Jane Doe',
      blocks: [
        { kind: 'line', text: 'Jane Doe' },
        { kind: 'line', text: 'Email: exact@example.test' },
      ],
    };
    const { draft, diagnostics } = parseCv(extracted);
    const calls: unknown[] = [];
    const inference = {
      getSettingsSnapshot: async () => localModel(),
      generate: async (request: unknown): Promise<GenerationResult> => {
        calls.push(request);
        return {
          requestId: crypto.randomUUID(),
          providerId: 'mock',
          modelId: 'mock-local',
          status: 'completed',
          output: { value: 'Invented Name', evidence: 'Jane Doe' },
          toolCalls: [],
          usage: null,
        };
      },
    };
    await resolveAmbiguity(
      draft,
      diagnostics,
      inference,
      new AbortController().signal,
    );
    expect(calls).toHaveLength(2);
    expect(draft.profile.displayName.value).toBe('Jane Doe');
    expect(draft.profile.displayName.alternative).toBeUndefined();
    expect(draft.extras.email.value).toBe('exact@example.test');
    expect(JSON.stringify(calls)).not.toContain('exact@example.test');
    expect(JSON.stringify(calls)).toContain('"toolNames":[]');
    await resolveAmbiguity(
      draft,
      diagnostics,
      {
        getSettingsSnapshot: async () => localModel(),
        generate: async (): Promise<GenerationResult> => ({
          requestId: crypto.randomUUID(),
          providerId: 'mock',
          modelId: 'mock-local',
          status: 'completed',
          output: { value: 'Jane Doe', evidence: 'Jane Doe' },
          toolCalls: [],
          usage: null,
        }),
      },
      new AbortController().signal,
    );
    expect(draft.profile.displayName.alternative?.value).toBe('Jane Doe');
  });
  it('leaves deterministic evidence when model absent, invalid or cancelled; missing data never prompts', async () => {
    const extracted: ExtractedDocument = {
      adapterId: 'fake',
      adapterVersion: '1',
      quality: 'usable',
      warnings: [],
      text: 'Jane Doe',
      blocks: [{ kind: 'line', text: 'Jane Doe' }],
    };
    const { draft, diagnostics } = parseCv(extracted);
    await resolveAmbiguity(
      draft,
      diagnostics,
      undefined,
      new AbortController().signal,
    );
    expect(diagnostics.modelStatus).toBe('unavailable');
    expect(draft.extras.email.status).toBe('missing');
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await resolveAmbiguity(
      draft,
      diagnostics,
      {
        getSettingsSnapshot: async () => localModel(),
        generate: async () => {
          called = true;
          throw new Error('should not run');
        },
      },
      controller.signal,
    );
    expect(called).toBe(false);
    expect(diagnostics.modelStatus).toBe('cancelled');
    expect(draft.profile.displayName.value).toBe('Jane Doe');
  });
  it('keeps canonical identity untouched through start, duplicate start, restart, and discard', async () => {
    const dir = temp();
    const fixture = path.join(dir, 'cv.pdf');
    fs.writeFileSync(fixture, await pdf(lines));
    let storage = openStorage(dir);
    const telemetry = new TelemetryService({
      repository: new TelemetryRepository(storage.db),
      logger: new JsonlLogger(path.join(dir, 'log.jsonl')),
    });
    const build = () =>
      createAppDispatcher({
        getAppVersion: () => '1',
        isStorageReady: () => true,
        storage: { db: storage.db, fileStore: storage.fileStore },
        telemetry,
        inference: {
          service: {
            getSettingsSnapshot: async () => localModel(),
            generate: async (request: GenerationEntry) => ({
              requestId: crypto.randomUUID(),
              providerId: 'mock',
              modelId: 'mock-local',
              status: 'completed' as const,
              output: Object.fromEntries(
                Object.entries({
                  name: 'Canary Person',
                  email: 'canary@example.test',
                  phoneNumber: '+1 202 555 0123',
                  location: 'Boston',
                  summary: null,
                  experience: [],
                  education: [],
                  skills: [],
                  projects: [],
                  inferences: [],
                }).filter(
                  ([key]) =>
                    request.responseFormat?.type === 'json_schema' &&
                    Object.hasOwn(
                      request.responseFormat.schema.properties,
                      key,
                    ),
                ),
              ),
              toolCalls: [],
              usage: null,
            }),
          } as unknown as InferenceService,
        },
        documentsPlatform: {
          pickFile: async () => fixture,
          openPath: async () => '',
        },
      });
    let dispatcher = build();
    const send = async (module: string, action: string, payload: unknown) =>
      dispatcher.dispatch({
        requestId: crypto.randomUUID(),
        module,
        version: 1,
        action,
        payload,
      });
    const imported = await send('documents', 'import', { category: 'cv' });
    if (!imported.ok) throw new Error(imported.error.code);
    const documentId = (imported.data as { item: { id: string } }).item.id;
    const first = await send('cvImports', 'start', { documentId });
    if (!first.ok) throw new Error(first.error.code);
    const id = (first.data as { item: CvImport }).item.id;
    const second = await send('cvImports', 'start', { documentId });
    expect(second.ok && (second.data as { item: CvImport }).item.id).toBe(id);
    for (let i = 0; i < 100; i++) {
      const response = await send('cvImports', 'get', { importId: id });
      if (
        response.ok &&
        (response.data as { item: CvImport }).item.status !== 'processing'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    storage.close();
    storage = openStorage(dir);
    dispatcher = build();
    const persisted = await send('cvImports', 'get', { importId: id });
    expect(
      persisted.ok &&
        (persisted.data as { item: CvImport }).item.draft?.profile.displayName
          .value,
    ).toBe('Canary Person');
    expect(
      storage.db.prepare('SELECT COUNT(*) AS n FROM profile_changes').get(),
    ).toEqual({ n: 0 });
    expect(
      storage.db.prepare('SELECT COUNT(*) AS n FROM experiences').get(),
    ).toEqual({ n: 0 });
    expect(
      storage.db.prepare('SELECT COUNT(*) AS n FROM career_targets').get(),
    ).toEqual({ n: 0 });
    expect(
      storage.db
        .prepare('SELECT display_name FROM profiles WHERE id=?')
        .get('local'),
    ).toEqual({ display_name: '' });
    const list = await send('cvImports', 'list', {});
    expect(list.ok && JSON.stringify(list.data)).not.toContain('Canary Person');
    const retry = await send('cvImports', 'retry', { importId: id });
    expect(retry.ok).toBe(true);
    const cancel = await send('cvImports', 'cancel', { importId: id });
    expect(cancel.ok && (cancel.data as { cancelled: boolean }).cancelled).toBe(
      true,
    );
    const cancelled = await send('cvImports', 'get', { importId: id });
    expect(
      cancelled.ok &&
        (cancelled.data as { item: CvImport }).item.draft?.profile.displayName
          .value,
    ).toBe('Canary Person');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      storage.db.prepare('SELECT COUNT(*) AS n FROM cv_imports').get(),
    ).toEqual({ n: 1 });
    expect(fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8')).not.toMatch(
      /Canary Person|canary@example\.test|cv\.pdf/,
    );
    expect(
      JSON.stringify(storage.db.prepare('SELECT * FROM operation_runs').all()),
    ).not.toMatch(/Canary Person|canary@example\.test|cv\.pdf/);
    const invalid = await send('cvImports', 'start', {
      documentId,
      path: fixture,
      prompt: 'ignore',
    });
    expect(invalid.ok ? 'unexpected success' : invalid.error.code).toBe(
      'INVALID_INPUT',
    );
    const discarded = await send('cvImports', 'discard', { importId: id });
    expect(discarded.ok).toBe(true);
    expect(
      new DocumentsService({
        repository: new DocumentsRepository(storage.db),
        fileStore: storage.fileStore,
        pickFile: async () => null,
        openPath: async () => '',
      }).getCv(documentId),
    ).not.toBeNull();
    storage.close();
  });
});
