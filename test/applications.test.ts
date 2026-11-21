import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, seedLocalProfile } from '../src/main/core/db/database';
import {
  openConnection,
  type SqliteDatabase,
} from '../src/main/core/db/connection';
import { runMigrations } from '../src/main/core/db/migrator';
import { MIGRATIONS } from '../src/main/core/db/migrations';
import { ApplicationsRepository } from '../src/main/modules/applications/applications.repository';
import { ApplicationsService } from '../src/main/modules/applications/applications.service';
import {
  DocumentsRepository,
  toPublicDocument,
} from '../src/main/modules/documents/documents.repository';
import { createAppDispatcher } from '../src/main/core/registry';
import { FileStore } from '../src/main/core/files/file-store';
import type { JobSnapshot, ResponseEnvelope } from '../src/shared/contracts';

let dir: string;
let db: SqliteDatabase;
let service: ApplicationsService;
const now = '2026-11-03T16:00:00.000Z';
const uuid = () => crypto.randomUUID();
const snapshot = (text = '<script>alert(1)</script>'): JobSnapshot => ({
  schemaVersion: 1,
  source: 'manual',
  capturedAt: now,
  sourceUrl: 'https://example.org/job',
  title: 'Engineer',
  company: 'Acme',
  location: null,
  descriptionText: text,
  contentBlocks: [],
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-apps-'));
  db = openDatabase(path.join(dir, 'app.sqlite')).db;
  service = new ApplicationsService(new ApplicationsRepository(db), {
    getMetadata: (id) => {
      const record = new DocumentsRepository(db).get(id);
      return record
        ? { profileId: record.profileId, document: toPublicDocument(record) }
        : null;
    },
  });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function document(profileId = 'local', name = 'same.pdf'): string {
  const id = uuid();
  db.prepare(`INSERT INTO documents (id,profile_id,category,original_name,media_type,relative_path,sha256,size_bytes,created_at)
    VALUES (? ,?,'cv',?,'application/pdf',?,'abc123',10,?)`).run(
    id,
    profileId,
    name,
    `originals/${id}.pdf`,
    now,
  );
  return id;
}
function create() {
  return service.create({
    companyName: 'Acme',
    roleTitle: 'Engineer',
    jobUrl: 'https://example.org/job',
  }).application.id;
}
function count(table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

describe('v9 migration on real v8 schema', () => {
  it('upgrades a populated v8 database, preserves every existing domain and is repeatable', () => {
    db.close();
    const file = path.join(dir, 'old.sqlite');
    db = openConnection(file);
    expect(runMigrations(db, MIGRATIONS.slice(0, 8)).currentVersion).toBe(8);
    seedLocalProfile(db);
    db.prepare(
      `UPDATE profiles SET display_name='Existing user' WHERE id='local'`,
    ).run();
    const doc = document();
    db.prepare(
      `INSERT INTO cv_imports (id,document_id,status,diagnostics_json,source_sha256,created_at,updated_at) VALUES (? ,?,'ready','{}','abc123',?,?)`,
    ).run(uuid(), doc, now, now);
    db.prepare(
      `INSERT INTO interview_sessions (id,profile_id,method,subject,status,created_at,updated_at) VALUES (?,'local','deep_loop','Practice','draft',?,?)`,
    ).run(uuid(), now, now);
    db.prepare(
      `INSERT INTO audio_recordings (id,profile_id,relative_path,sha256,size_bytes,duration_ms,media_type,codec,sample_rate,channels,created_at,updated_at) VALUES (?,'local',?, 'abc',44,1,'audio/wav','pcm_s16le',16000,1,?,?)`,
    ).run(uuid(), `originals/${uuid()}.wav`, now, now);
    expect(runMigrations(db, MIGRATIONS.slice(0, 9)).appliedVersions).toEqual([
      9,
    ]);
    expect(runMigrations(db, MIGRATIONS.slice(0, 9)).appliedVersions).toEqual(
      [],
    );
    for (const table of [
      'documents',
      'cv_imports',
      'interview_sessions',
      'audio_recordings',
    ])
      expect(count(table)).toBe(1);
    expect(
      (
        db
          .prepare(`SELECT display_name FROM profiles WHERE id='local'`)
          .get() as { display_name: string }
      ).display_name,
    ).toBe('Existing user');
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces snapshot provenance, immutability, stage ownership and append-only history in SQLite', () => {
    const first = create(),
      second = create();
    const stage = service.get(first).application.currentStage;
    const other = service.get(second).application.currentStage;
    expect(() =>
      db
        .prepare(
          `UPDATE job_applications SET job_snapshot_json='not json',job_snapshot_captured_at=?,job_snapshot_source='manual' WHERE id=?`,
        )
        .run(now, first),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE job_applications SET job_snapshot_json=?,job_snapshot_captured_at=?,job_snapshot_source='web' WHERE id=?`,
        )
        .run(JSON.stringify(snapshot()), now, first),
    ).toThrow();
    service.capture(first, snapshot());
    expect(() =>
      db
        .prepare(
          `UPDATE job_applications SET job_snapshot_json=NULL,job_snapshot_captured_at=NULL,job_snapshot_source=NULL WHERE id=?`,
        )
        .run(first),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE job_applications SET job_snapshot_source='web' WHERE id=?`,
        )
        .run(first),
    ).toThrow();
    expect(service.get(first).snapshot).toEqual(snapshot());
    expect(() =>
      db
        .prepare(
          `UPDATE job_applications SET current_stage_event_id=? WHERE id=?`,
        )
        .run(other.id, first),
    ).toThrow();
    expect(service.get(first).application.currentStage.id).toBe(stage.id);
    expect(() =>
      db
        .prepare(
          `INSERT INTO job_applications (id,profile_id,company_name,role_title,current_stage_event_id,created_at,updated_at) VALUES (?,'local','Wrong','Pointer',?,?,?)`,
        )
        .run(uuid(), other.id, now, now),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE application_stage_events SET stage_label='fake' WHERE id=?`,
        )
        .run(stage.id),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO application_stage_events (id,application_id,stage_label,occurred_at,recorded_at,source,corrects_event_id) VALUES (?,?, 'Wrong',?,?,'user',?)`,
        )
        .run(uuid(), first, now, now, other.id),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO application_notes (id,application_id,stage_event_id,body,source,created_at,updated_at) VALUES (?,?,?,'x','other',?,?)`,
        )
        .run(uuid(), first, other.id, now, now),
    ).toThrow();
    const note = service.createNote({
      applicationId: first,
      body: 'Valid',
      source: 'other',
    });
    expect(() =>
      db
        .prepare(`UPDATE application_notes SET stage_event_id=? WHERE id=?`)
        .run(other.id, note.id),
    ).toThrow();
  });

  it('retains document identity and permits profile cascades', () => {
    const id = create(),
      doc = document();
    const link = service.link({
      applicationId: id,
      documentId: doc,
      purpose: 'submitted_cv',
    });
    expect(() =>
      db
        .prepare(
          `UPDATE application_documents SET sha256_snapshot='false' WHERE id=?`,
        )
        .run(link.id),
    ).toThrow();
    service.unlink({ applicationId: id, id: link.id, reason: 'Wrong CV' });
    db.prepare(`DELETE FROM documents WHERE id=?`).run(doc);
    expect(service.get(id).documents[0]).toMatchObject({
      documentId: null,
      unavailable: true,
      sha256: 'abc123',
      originalName: 'same.pdf',
      unlinkReason: 'Wrong CV',
    });
    db.prepare(`DELETE FROM profiles WHERE id='local'`).run();
    expect(count('job_applications')).toBe(0);
    expect(count('application_stage_events')).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('Applications service and IPC', () => {
  it('creates initial stage atomically, supports duplicates, pagination, free stages, backdates and correction', () => {
    const id = create();
    const other = create();
    expect(count('job_applications')).toBe(2);
    expect(service.get(id).application.currentStage).toMatchObject({
      stageLabel: 'Saved',
      stageKind: 'saved',
    });
    expect(service.list({ limit: 1 }).nextCursor).toBeTruthy();
    const page = service.list({ limit: 1 });
    expect(
      service.list({ limit: 1, cursor: page.nextCursor! }).items,
    ).toHaveLength(1);
    expect(service.list({ search: 'ACME' }).items).toHaveLength(2);
    const first = service.record({
      applicationId: id,
      stageLabel: 'Onsite',
      stageKind: 'interview',
      occurredAt: now,
    });
    service.record({
      applicationId: id,
      stageLabel: 'Onsite',
      stageKind: 'interview',
      occurredAt: now,
    });
    service.record({
      applicationId: id,
      stageLabel: 'Back to phone',
      stageKind: 'screening',
      occurredAt: '2025-01-01T00:00:00.000Z',
    });
    const correction = service.correct({
      applicationId: id,
      stageLabel: 'Actually a custom stage',
    });
    expect(correction.correctsEventId).toBe(
      service.get(id).stages.find((s) => s.stageLabel === 'Back to phone')?.id,
    );
    expect(service.get(id).application.currentStage.id).toBe(correction.id);
    expect(service.get(id).stages[0].stageLabel).toBe('Back to phone');
    expect(
      service.get(id).stages.filter((s) => s.stageLabel === 'Onsite'),
    ).toHaveLength(2);
    expect(service.get(other).stages).toHaveLength(1);
    expect(service.list({ kind: 'interview' }).items).toHaveLength(0);
    expect(first.source).toBe('user');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back initial stage failure and transition pointer failure', () => {
    db.exec(
      `CREATE TRIGGER fail_stage BEFORE INSERT ON application_stage_events BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
    );
    expect(() => create()).toThrow();
    expect(count('job_applications')).toBe(0);
    db.exec('DROP TRIGGER fail_stage');
    const id = create(),
      current = service.get(id).application.currentStage.id;
    db.exec(
      `CREATE TRIGGER fail_pointer BEFORE UPDATE OF current_stage_event_id ON job_applications BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
    );
    expect(() =>
      service.record({ applicationId: id, stageLabel: 'Blocked' }),
    ).toThrow();
    expect(service.get(id).application.currentStage.id).toBe(current);
    expect(service.get(id).stages).toHaveLength(1);
  });

  it('captures immutable JD, edits metadata, archives and restores without losing history', () => {
    const id = create();
    expect(service.get(id).snapshot).toBeNull();
    service.capture(id, snapshot());
    service.update({
      id,
      patch: {
        companyName: 'Other company',
        jobUrl: 'https://example.org/new',
        appliedAt: '2026-11-02',
      },
    });
    expect(service.get(id).snapshot).toEqual(snapshot());
    expect(service.get(id).application.appliedAt).toBe('2026-11-02');
    service.archive(id, true);
    expect(service.list().items).toHaveLength(0);
    expect(service.list({ archived: true }).items).toHaveLength(1);
    service.archive(id, false);
    expect(service.get(id).stages).toHaveLength(1);
    expect(() => service.capture(id, snapshot('replacement'))).toThrowError(
      /already/,
    );
  });

  it('validates snapshots, source refs, notes, and document ownership', () => {
    const id = create(),
      other = create();
    expect(() => service.capture(id, snapshot('x'.repeat(49000)))).toThrow();
    expect(() =>
      service.capture(id, {
        ...snapshot(),
        schemaVersion: 2,
      } as unknown as JobSnapshot),
    ).toThrow();
    const blocks = service.capture(id, {
      schemaVersion: 1,
      source: 'web',
      capturedAt: now,
      contentBlocks: [{ type: 'paragraph', text: 'Original ordered content' }],
    });
    expect(blocks).toMatchObject({ descriptionText: '', sourceUrl: null });
    expect(service.get(id).snapshot?.contentBlocks[0].text).toBe(
      'Original ordered content',
    );
    const doc = document();
    const linked = service.link({
      applicationId: id,
      documentId: doc,
      purpose: 'submitted_cv',
    });
    expect(linked.sha256).toBe('abc123');
    expect(() =>
      service.link({
        applicationId: id,
        documentId: doc,
        purpose: 'submitted_cv',
        sha256: 'fake',
      } as never),
    ).toThrow();
    const stage = service.record({
      applicationId: other,
      stageLabel: 'Other stage',
    });
    expect(() =>
      service.createNote({
        applicationId: id,
        body: 'brain dump',
        source: 'self_reported',
        stageEventId: stage.id,
      }),
    ).toThrow();
    const note = service.createNote({
      applicationId: id,
      body: 'brain dump',
      source: 'self_reported',
      observedAt: now,
    });
    expect(note.observedAt).toBe(now);
    expect(
      service.updateNote({
        applicationId: id,
        id: note.id,
        patch: { body: 'recruiter said yes', source: 'recruiter_feedback' },
      }).source,
    ).toBe('recruiter_feedback');
    service.removeNote(id, note.id);
    expect(service.get(id).notes).toHaveLength(0);
    db.prepare(
      `INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES ('foreign','',?,?)`,
    ).run(now, now);
    const foreign = document('foreign');
    expect(() =>
      service.link({
        applicationId: id,
        documentId: foreign,
        purpose: 'supporting',
      }),
    ).toThrow();
    db.prepare(`DELETE FROM documents WHERE id=?`).run(doc);
    expect(service.get(id).documents[0]).toMatchObject({
      unavailable: true,
      sha256: 'abc123',
    });
    document('local', 'same.pdf');
    expect(service.get(id).documents[0].documentId).toBeNull();
  });

  it('deduplicates trusted source references per application and source', () => {
    const id = create(),
      other = create();
    const fields = { applicationId: id, stageLabel: 'Screen' };
    service.record(fields, 'email', 'message-1', { verified: false });
    expect(() => service.record(fields, 'email', 'message-1')).toThrowError(
      /already/,
    );
    expect(service.get(id).stages).toHaveLength(2);
    service.record({ ...fields, applicationId: other }, 'email', 'message-1');
    service.record(fields, 'agent', 'message-1');
  });

  it('validates real dispatcher payloads, returns serialisable data and rejects spoofed sources', async () => {
    const dispatcher = createAppDispatcher({
      getAppVersion: () => 'test',
      isStorageReady: () => true,
      storage: {
        db,
        fileStore: new FileStore(
          path.join(dir, 'documents'),
          path.join(dir, 'tmp'),
        ),
      },
      documentsPlatform: {
        pickFile: async () => null,
        openPath: async () => '',
      },
    });
    const send = (
      action: string,
      payload: unknown,
      version = 1,
    ): Promise<ResponseEnvelope> =>
      dispatcher.dispatch({
        requestId: uuid(),
        module: 'applications',
        version,
        action,
        payload,
      });
    const created = await send('create', {
      companyName: 'Acme',
      roleTitle: 'Engineer',
      initialStage: {
        stageLabel: 'Applied',
        stageKind: 'applied',
        occurredAt: now,
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = (created.data as { item: { application: { id: string } } }).item
      .application.id;
    expect(service.get(id).application.appliedAt).toBe('2026-11-03');
    expect(
      (
        await send('stages.record', {
          applicationId: id,
          stageLabel: 'Spoof',
          source: 'email',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await send('snapshot.capture', {
          id,
          snapshot: { ...snapshot(), source: 'email' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await send('create', {
          companyName: 'x',
          roleTitle: 'y',
          snapshot: { ...snapshot(), source: 'web' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await send('stages.record', {
          applicationId: id,
          stageLabel: 'Interview',
        })
      ).ok,
    ).toBe(true);
    const result = await send('get', { id });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect((await send('get', { id: uuid() })).ok).toBe(false);
    expect((await send('create', { companyName: '', roleTitle: 'x' })).ok).toBe(
      false,
    );
    expect((await send('get', { id }, 2)).ok).toBe(false);
  });
});
