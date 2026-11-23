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
import { createAppDispatcher } from '../src/main/core/registry';
import { FileStore } from '../src/main/core/files/file-store';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import {
  JOB_DISCOVERY_LIMITS,
  jobDiscoveryConfigurationV1Schema,
  newJobDiscoveryConfiguration,
  type JobDiscoveryConfigurationV1,
  type SavedSearch,
} from '../src/shared/contracts';

let dir: string;
let db: SqliteDatabase;
let service: SavedSearchesService;
const now = '2026-11-04T12:00:00.000Z';
const uuid = () => crypto.randomUUID();
function config(): JobDiscoveryConfigurationV1 {
  const value = newJobDiscoveryConfiguration();
  value.name = 'Research placements';
  value.intent.targetRoles = ['Research Assistant', 'Lab Technician'];
  return value;
}
function insertConfig(value: unknown, profile = 'local') {
  const id = uuid();
  db.prepare(`INSERT INTO job_saved_searches VALUES (?, ?, ?, ?, ?)`).run(
    id,
    profile,
    JSON.stringify(value),
    now,
    now,
  );
  return id;
}
function insertRun(search: string | null, value = config(), profile = 'local') {
  const id = uuid();
  db.prepare(`INSERT INTO job_discovery_runs (id,profile_id,saved_search_id,status,config_snapshot_json,query_plan_json,started_at)
    VALUES (?, ?, ?, 'running', ?, '[]', ?)`).run(
    id,
    profile,
    search,
    JSON.stringify(value),
    now,
  );
  return id;
}
function dispatcher() {
  return createAppDispatcher({
    getAppVersion: () => 'test',
    isStorageReady: () => true,
    storage: {
      db,
      fileStore: new FileStore(
        path.join(dir, 'documents'),
        path.join(dir, 'tmp'),
      ),
    },
  });
}
function send(action: string, payload: unknown, version = 1) {
  return dispatcher().dispatch({
    requestId: uuid(),
    module: 'jobDiscovery',
    version,
    action: `savedSearches.${action}`,
    payload,
  });
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-discovery-'));
  db = openDatabase(path.join(dir, 'app.sqlite')).db;
  service = new SavedSearchesService(new SavedSearchesRepository(db));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('saved searches', () => {
  it('round-trips the entire configuration through the registered IPC and survives restart inactive', async () => {
    const value = config();
    value.run.deadlineMs = 12345;
    value.run.maxCollectionPages = 0;
    value.query.maxQueries = 2;
    value.sources.collectionProviders = ['indeed'];
    const created = await send('create', { config: value });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('create failed');
    const item = (created.data as { item: SavedSearch }).item;
    expect(item.config).toEqual(value);
    expect(
      JSON.parse(
        (
          db
            .prepare('SELECT config_json FROM job_saved_searches WHERE id=?')
            .get(item.id) as { config_json: string }
        ).config_json,
      ),
    ).toEqual(value);
    value.name = 'Edited search';
    expect((await send('update', { id: item.id, config: value })).ok).toBe(
      true,
    );
    expect((await send('setActive', { id: item.id, active: false })).ok).toBe(
      true,
    );
    db.close();
    const reopened = openDatabase(path.join(dir, 'app.sqlite'));
    db = reopened.db;
    service = new SavedSearchesService(new SavedSearchesRepository(db));
    expect(reopened.migration.appliedVersions).toEqual([]);
    expect(await send('get', { id: item.id })).toMatchObject({
      ok: true,
      data: { item: { config: { ...value, active: false } } },
    });
    expect(() => service.requireActive(item.id)).toThrow(/Activate/);
    expect(() => insertRun(item.id, { ...value, active: false })).toThrow();
    service.setActive({ id: item.id, active: true });
    expect(service.requireActive(item.id).config).toEqual(value);
  });

  it('denies foreign IDs in get/update/toggle/list cursors and rejects renderer authority', async () => {
    db.prepare(
      `INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES ('foreign','',?,?)`,
    ).run(now, now);
    const foreign = insertConfig(config(), 'foreign');
    const own = service.create({ config: config() });
    for (const [action, payload] of [
      ['get', { id: foreign }],
      ['update', { id: foreign, config: config() }],
      ['setActive', { id: foreign, active: false }],
    ] as const)
      expect(await send(action, payload)).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });
    expect(await send('list', {})).toMatchObject({
      ok: true,
      data: { items: [own] },
    });
    expect(await send('list', { cursor: foreign })).toMatchObject({
      ok: true,
      data: { items: [] },
    });
    expect(
      await send('create', { config: config(), profileId: 'foreign' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await send('get', { id: own.id }, 2)).toMatchObject({
      ok: false,
      error: { code: 'VERSION_UNSUPPORTED' },
    });
    expect(await send('run', { id: own.id })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await send('get', { id: '../app.sqlite' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('uses bounded stable pagination even when configs are edited', () => {
    for (let n = 0; n < 5; n++) service.create({ config: config() });
    const first = service.list({ limit: 2 });
    service.setActive({ id: first.items[0].id, active: false });
    const second = service.list({ limit: 2, cursor: first.nextCursor! });
    const third = service.list({ limit: 2, cursor: second.nextCursor! });
    expect(
      new Set(
        [...first.items, ...second.items, ...third.items].map(
          (item) => item.id,
        ),
      ).size,
    ).toBe(5);
    expect(third.nextCursor).toBeNull();
  });
});

const invalidCases: Array<
  [string, (c: JobDiscoveryConfigurationV1) => unknown]
> = [
  ['version', (c) => ({ ...c, schemaVersion: 2 })],
  ['missing fields', () => ({})],
  [
    'missing nested field',
    (c) => ({ ...c, intent: { targetRoles: ['Role'] } }),
  ],
  ['unknown key', (c) => ({ ...c, override: true })],
  ['unknown nested key', (c) => ({ ...c, query: { ...c.query, hidden: 1 } })],
  ['active type', (c) => ({ ...c, active: 1 })],
  ['blank name', (c) => ({ ...c, name: '   ' })],
  ['long name', (c) => ({ ...c, name: 'x'.repeat(121) })],
  ['empty roles', (c) => ({ ...c, intent: { ...c.intent, targetRoles: [] } })],
  [
    'duplicate roles',
    (c) => ({ ...c, intent: { ...c.intent, targetRoles: ['Role', ' role '] } }),
  ],
  [
    'too many roles',
    (c) => ({
      ...c,
      intent: { ...c.intent, targetRoles: ['a', 'b', 'c', 'd', 'e', 'f'] },
    }),
  ],
  ['role type', (c) => ({ ...c, intent: { ...c.intent, targetRoles: [1] } })],
  [
    'long role',
    (c) => ({ ...c, intent: { ...c.intent, targetRoles: ['x'.repeat(201)] } }),
  ],
  [
    'too many keywords',
    (c) => ({ ...c, intent: { ...c.intent, keywords: Array(11).fill('key') } }),
  ],
  [
    'blank company',
    (c) => ({ ...c, intent: { ...c.intent, companies: [''] } }),
  ],
  ['year', (c) => ({ ...c, intent: { ...c.intent, targetYear: 2101 } })],
  [
    'provider',
    (c) => ({ ...c, sources: { collectionProviders: ['glassdoor'] } }),
  ],
  ['no providers', (c) => ({ ...c, sources: { collectionProviders: [] } })],
  [
    'duplicate providers',
    (c) => ({ ...c, sources: { collectionProviders: ['indeed', 'indeed'] } }),
  ],
  [
    'query strategy',
    (c) => ({ ...c, query: { ...c.query, strategy: 'model' } }),
  ],
  ['query cap', (c) => ({ ...c, query: { ...c.query, maxQueries: 5 } })],
  [
    'fractional budget',
    (c) => ({ ...c, run: { ...c.run, maxNewCandidates: 1.5 } }),
  ],
  [
    'negative budget',
    (c) => ({ ...c, run: { ...c.run, maxCollectionPages: -1 } }),
  ],
  [
    'zero concurrency',
    (c) => ({ ...c, run: { ...c.run, maxConcurrentWebOperations: 0 } }),
  ],
  ...Object.entries(JOB_DISCOVERY_LIMITS)
    .filter(([key]) => key !== 'maxQueries' && key !== 'deadlineMs')
    .map(
      ([key, ceiling]): [
        string,
        (c: JobDiscoveryConfigurationV1) => unknown,
      ] => [key, (c) => ({ ...c, run: { ...c.run, [key]: ceiling + 1 } })],
    ),
];
describe('independent runtime and SQL validation', () => {
  it('enforces the 90-minute ceiling in application validation while SQL validates deadline shape', async () => {
    const value = config();
    value.run.deadlineMs = JOB_DISCOVERY_LIMITS.deadlineMs + 1;
    expect(jobDiscoveryConfigurationV1Schema.safeParse(value).success).toBe(
      false,
    );
    expect(() => service.create({ config: value })).toThrow();
    expect(await send('create', { config: value })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    // A structurally valid future policy value is not rejected by schema v16.
    expect(() => insertConfig(value)).not.toThrow();
    value.run.deadlineMs = 0;
    expect(() => insertConfig(value)).toThrow();
  });
  it.each(invalidCases)(
    'rejects %s on Zod, domain, IPC, SQL insert/update and run snapshot',
    async (_name, change) => {
      const invalid = change(config());
      expect(jobDiscoveryConfigurationV1Schema.safeParse(invalid).success).toBe(
        false,
      );
      expect(() =>
        service.create({ config: invalid as JobDiscoveryConfigurationV1 }),
      ).toThrow();
      expect(await send('create', { config: invalid })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      expect(() => insertConfig(invalid)).toThrow();
      const saved = service.create({ config: config() });
      expect(() =>
        db
          .prepare('UPDATE job_saved_searches SET config_json=? WHERE id=?')
          .run(JSON.stringify(invalid), saved.id),
      ).toThrow();
      expect(service.get({ id: saved.id })).toEqual(saved);
      expect(() =>
        insertRun(saved.id, invalid as JobDiscoveryConfigurationV1),
      ).toThrow();
    },
  );
  it('accepts explicitly stricter settings and rejects duplicate object keys and malformed JSON', () => {
    // SQLite TEXT PRIMARY KEY alone permits NULL; IDs must not bypass the
    // row-scoped configuration triggers through SQL three-valued logic.
    expect(() =>
      db
        .prepare(
          `INSERT INTO job_saved_searches VALUES (NULL,'local','{}',?,?)`,
        )
        .run(now, now),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO job_discovery_runs (id,profile_id,status,config_snapshot_json,query_plan_json,started_at) VALUES (NULL,'local','running','{}','[]',?)`,
        )
        .run(now),
    ).toThrow();
    const value = config();
    value.run = {
      maxNewCandidates: 1,
      maxInspectedCandidates: 1,
      maxCollectionPages: 0,
      maxTargetedSearchesPerCandidate: 0,
      maxPagesPerTargetedSearch: 0,
      maxConcurrentWebOperations: 1,
      maxConcurrentExtractions: 1,
      maxTransientRetries: 0,
      deadlineMs: 1,
    };
    expect(service.create({ config: value }).config).toEqual(value);
    const item = service.create({ config: config() });
    for (const raw of [
      'null',
      '[]',
      'not JSON',
      JSON.stringify(config()).replace(
        '"deadlineMs":5400000',
        '"maxNewCandidates":2',
      ),
    ]) {
      expect(() =>
        db
          .prepare('UPDATE job_saved_searches SET config_json=? WHERE id=?')
          .run(raw, item.id),
      ).toThrow();
    }
  });
});

describe('v10 migration and reserved schema invariants', () => {
  it('rolls back all v10 schema additions on a failed upgrade, retaining v9 data', () => {
    db.close();
    db = openConnection(path.join(dir, 'rollback.sqlite'));
    runMigrations(db, MIGRATIONS.slice(0, 9));
    seedLocalProfile(db);
    db.prepare(
      `UPDATE profiles SET display_name='Retained' WHERE id='local'`,
    ).run();
    const broken = {
      ...MIGRATIONS[9],
      sql: `${MIGRATIONS[9].sql}\nINSERT INTO nonexistent_table VALUES (1);`,
    };
    expect(() =>
      runMigrations(db, [...MIGRATIONS.slice(0, 9), broken]),
    ).toThrow();
    expect(
      db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
    ).toEqual({ version: 9 });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name='job_saved_searches'`,
        )
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT display_name FROM profiles WHERE id='local'`).get(),
    ).toEqual({ display_name: 'Retained' });
    expect(runMigrations(db).appliedVersions).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    ]);
  });
  it('upgrades populated real v9 without changing existing rows, repeats and restarts cleanly', () => {
    db.close();
    const file = path.join(dir, 'v9.sqlite');
    db = openConnection(file);
    expect(runMigrations(db, MIGRATIONS.slice(0, 9)).currentVersion).toBe(9);
    seedLocalProfile(db);
    db.prepare(
      `UPDATE profiles SET display_name='Existing profile' WHERE id='local'`,
    ).run();
    db.prepare(
      `INSERT INTO documents (id,profile_id,category,original_name,media_type,relative_path,sha256,size_bytes,created_at) VALUES ('doc','local','cv','fixture.pdf','application/pdf','originals/fixture.pdf','abc',1,?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO cv_imports (id,document_id,status,diagnostics_json,source_sha256,created_at,updated_at) VALUES ('import','doc','ready','{}','abc',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO interview_sessions (id,profile_id,method,subject,status,created_at,updated_at) VALUES ('interview','local','deep_loop','Practice','draft',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO audio_recordings (id,profile_id,relative_path,sha256,size_bytes,duration_ms,media_type,codec,sample_rate,channels,created_at,updated_at) VALUES ('audio','local','originals/audio.wav','abc',44,1,'audio/wav','pcm_s16le',16000,1,?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO settings VALUES ('inference.preferences','{}',?)`,
    ).run(now);
    // Seed a real v9 application before the new correlation column exists.
    db.prepare(`INSERT INTO job_applications
      (id,profile_id,company_name,role_title,created_at,updated_at)
      VALUES ('old-app','local','Existing employer','Existing role',?,?)`).run(
      now,
      now,
    );
    db.prepare(`INSERT INTO application_stage_events
      (id,application_id,stage_label,stage_kind,occurred_at,recorded_at,source)
      VALUES ('old-stage','old-app','Saved','saved',?,?,'user')`).run(now, now);
    db.prepare(
      `UPDATE job_applications SET current_stage_event_id='old-stage' WHERE id='old-app'`,
    ).run();
    const tables = [
      'profiles',
      'documents',
      'cv_imports',
      'interview_sessions',
      'audio_recordings',
      'settings',
      'job_applications',
      'application_stage_events',
    ];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    expect(runMigrations(db).appliedVersions).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    ]);
    expect(runMigrations(db).appliedVersions).toEqual([]);
    db.close();
    db = openDatabase(file).db;
    expect(
      tables.map((table) =>
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .filter(
            (row) =>
              table !== 'settings' ||
              (row as { key: string }).key !== 'onboarding.completed',
          )
          .map((row) => {
            const {
              discovery_opportunity_id: _added,
              generation_epoch: _epoch,
              additional_guidance: _guidance,
              avatar: _avatar,
              ...legacy
            } = row as Record<string, unknown>;
            return legacy;
          }),
      ),
    ).toEqual(before);
    expect(
      db
        .prepare(
          `SELECT generation_epoch, additional_guidance FROM interview_sessions WHERE id='interview'`,
        )
        .get(),
    ).toEqual({ generation_epoch: 0, additional_guidance: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('protects run snapshots, ownership, admission caps, captures and profile cascades', () => {
    db.prepare(
      `INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES ('foreign','',?,?)`,
    ).run(now, now);
    const search = insertConfig(config());
    const foreign = insertConfig(config(), 'foreign');
    expect(() => insertRun(foreign)).toThrow();
    const run = insertRun(search);
    expect(() => insertRun(search)).toThrow();
    const foreignRun = insertRun(foreign, config(), 'foreign');
    expect(() =>
      db
        .prepare('UPDATE job_discovery_runs SET saved_search_id=? WHERE id=?')
        .run(insertConfig(config()), run),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE job_discovery_runs SET query_plan_json='["changed"]' WHERE id=?`,
        )
        .run(run),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE job_discovery_runs SET config_snapshot_json=? WHERE id=?`,
        )
        .run(JSON.stringify({ ...config(), name: 'changed' }), run),
    ).toThrow();
    service.setActive({ id: search, active: false });
    expect(
      (
        db
          .prepare(
            'SELECT config_snapshot_json FROM job_discovery_runs WHERE id=?',
          )
          .get(run) as { config_snapshot_json: string }
      ).config_snapshot_json,
    ).toBe(JSON.stringify(config()));
    const opportunity = uuid();
    db.prepare(
      `INSERT INTO job_opportunities (id,profile_id,title,created_at,updated_at) VALUES (?,'local','Role',?,?)`,
    ).run(opportunity, now, now);
    const source = (profile = 'local', opportunityId = uuid()) => {
      const id = uuid();
      if (profile === 'local' && opportunityId !== opportunity)
        db.prepare(`INSERT INTO job_opportunities (id,profile_id,title,created_at,updated_at)
          VALUES (?,'local','Role',?,?)`).run(opportunityId, now, now);
      db.prepare(
        `INSERT INTO job_opportunity_sources (id,profile_id,opportunity_id,provider,source_key,discovered_url,first_seen_at,last_seen_at) VALUES (?,?,?,'indeed',?,'https://example.org/job',?,?)`,
      ).run(
        id,
        profile,
        profile === 'foreign' ? opportunity : opportunityId,
        id,
        now,
        now,
      );
      return id;
    };
    expect(() => source('foreign')).toThrow();
    const addItem = (sourceId: string, runId = run, admitted = 1) => {
      const id = uuid();
      db.prepare(
        `INSERT INTO job_discovery_run_items VALUES (?,?,?,?,'admitted',NULL,?,?)`,
      ).run(id, runId, sourceId, admitted, now, now);
      return id;
    };
    expect(() => addItem(source(), foreignRun)).toThrow();
    for (let n = 0; n < 10; n++) addItem(source());
    expect(() => addItem(source())).toThrow(/admission/);
    const extra = addItem(source(), run, 0);
    expect(() =>
      db
        .prepare('UPDATE job_discovery_run_items SET admitted=1 WHERE id=?')
        .run(extra),
    ).toThrow(/admission/);
    db.prepare(
      `UPDATE job_discovery_runs SET status='completed',finished_at=? WHERE id=?`,
    ).run(now, run);
    const nextRun = insertRun(search);
    const moved = addItem(source(), nextRun);
    expect(() =>
      db
        .prepare('UPDATE job_discovery_run_items SET run_id=? WHERE id=?')
        .run(run, moved),
    ).toThrow(/admission/);
    const capture = uuid();
    db.prepare(
      `INSERT INTO job_opportunity_captures (id,opportunity_id,source_url,raw_readpage_json,captured_at) VALUES (?,?,'https://example.org/job','{}',?)`,
    ).run(capture, opportunity, now);
    expect(() =>
      db
        .prepare(
          `UPDATE job_opportunity_captures SET raw_readpage_json='{"changed":true}' WHERE id=?`,
        )
        .run(capture),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO job_opportunity_captures (id,opportunity_id,source_url,raw_readpage_json,captured_at) VALUES (?,?,'https://example.org/job',?,?)`,
        )
        .run(
          uuid(),
          opportunity,
          JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }),
          now,
        ),
    ).toThrow();
    db.prepare(
      `UPDATE job_opportunity_captures SET capture_status='extracted',extracted_jd_json='{}' WHERE id=?`,
    ).run(capture);
    expect(() =>
      db
        .prepare(
          `UPDATE job_opportunity_captures SET extracted_jd_json='{"changed":true}' WHERE id=?`,
        )
        .run(capture),
    ).toThrow();
    expect(() =>
      db
        .prepare(`UPDATE job_opportunities SET profile_id='foreign' WHERE id=?`)
        .run(opportunity),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE job_saved_searches SET profile_id='foreign' WHERE id=?`,
        )
        .run(search),
    ).toThrow();
    db.prepare('DELETE FROM job_saved_searches WHERE id=?').run(search);
    expect(
      db
        .prepare('SELECT saved_search_id FROM job_discovery_runs WHERE id=?')
        .get(run),
    ).toEqual({ saved_search_id: null });
    db.prepare(`DELETE FROM profiles WHERE id='local'`).run();
    expect(db.prepare('SELECT * FROM job_opportunities').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
