import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/main/core/storage';
import { openConnection } from '../src/main/core/db/connection';
import {
  LOCAL_PROFILE_ID,
  seedLocalProfile,
} from '../src/main/core/db/database';
import { runMigrations } from '../src/main/core/db/migrator';
import { MIGRATIONS } from '../src/main/core/db/migrations';
import {
  jobDiscoveryConfigurationV1Schema,
  newJobDiscoveryConfiguration,
} from '../src/shared/contracts';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-migrate-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function dbFile(): string {
  return path.join(workDir, 'app.sqlite');
}

const TS = '2026-01-01T00:00:00.000Z';

/** Populate a data dir as if a prior version had been used (profile, target,
 *  experience, document, settings, a telemetry run). */
function populate(dir: string, version = 20): void {
  const db = openConnection(path.join(dir, 'app.sqlite'));
  try {
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= version),
    );
    seedLocalProfile(db);
    db.prepare(
      'UPDATE profiles SET display_name = ?, summary = ? WHERE id = ?',
    ).run(
      'Prior User',
      'A career summary written before upgrade.',
      LOCAL_PROFILE_ID,
    );
    db.prepare(
      `INSERT INTO career_targets (id, profile_id, role_title, created_at, updated_at)
       VALUES ('tgt-1', ?, 'Data Scientist', ?, ?)`,
    ).run(LOCAL_PROFILE_ID, TS, TS);
    db.prepare(
      `INSERT INTO experiences (id, profile_id, category, role_title, description, created_at, updated_at)
       VALUES ('exp-1', ?, 'employment', 'Data Analyst', 'Did analysis', ?, ?)`,
    ).run(LOCAL_PROFILE_ID, TS, TS);
    db.prepare(
      `INSERT INTO documents (id, profile_id, category, original_name, media_type, relative_path, sha256, size_bytes, created_at)
       VALUES ('doc-1', ?, 'cv', 'cv.pdf', 'application/pdf', 'originals/a/b.pdf', 'deadbeef', 123, ?)`,
    ).run(LOCAL_PROFILE_ID, TS);
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('theme', '{"mode":"dark"}', ?)`,
    ).run(TS);
    db.prepare(
      `INSERT INTO operation_runs (id, module_id, operation, outcome, started_at, finished_at, duration_ms)
       VALUES ('run-1', 'system', 'boot', 'success', ?, ?, 5)`,
    ).run(TS, TS);
  } finally {
    db.close();
  }
}

interface CountRow {
  count: number;
}

describe('migration on a populated (pre-existing) install', () => {
  it('preserves existing exact dates and allows new partial dates after upgrade', () => {
    populate(workDir, 22);
    const db = openConnection(dbFile());
    try {
      db.prepare(
        "UPDATE experiences SET start_date='2020-01-01', end_date='2022-06-30' WHERE id='exp-1'",
      ).run();
      expect(runMigrations(db).appliedVersions).toEqual([23, 24, 25, 26]);
      expect(
        db
          .prepare(
            "SELECT start_date, end_date FROM experiences WHERE id='exp-1'",
          )
          .get(),
      ).toEqual({
        start_date: '2020-01-01',
        end_date: '2022-06-30',
      });
      db.prepare(
        "UPDATE experiences SET start_date='2021-05-20', end_date='2021-05' WHERE id='exp-1'",
      ).run();
      expect(() =>
        db
          .prepare("UPDATE experiences SET end_date='2021-04' WHERE id='exp-1'")
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare("UPDATE experiences SET end_date='2021-13' WHERE id='exp-1'")
          .run(),
      ).toThrow();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_experiences_profile'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('upgrades populated v18 interviews with null guidance and rolls back a broken v19', () => {
    const db = openConnection(dbFile());
    try {
      const upToV18 = MIGRATIONS.filter((m) => m.version <= 18);
      runMigrations(db, upToV18);
      seedLocalProfile(db);
      const insert = db.prepare(`INSERT INTO interview_sessions
        (id, profile_id, method, subject, question_count, status, phase, created_at, updated_at, generation_epoch)
        VALUES (?, 'local', ?, 'History', ?, ?, ?, ?, ?, 3)`);
      insert.run('draft-v18', 'deep_loop', null, 'draft', null, TS, TS);
      insert.run('active-v18', 'quick_fire', 5, 'active', 'answering', TS, TS);
      const before = db
        .prepare('SELECT * FROM interview_sessions ORDER BY id')
        .all();

      expect(() =>
        runMigrations(db, [
          ...upToV18,
          {
            version: 19,
            name: 'broken_guidance',
            sql: MIGRATIONS[18].sql + '\nINSERT INTO missing_table VALUES (1);',
          },
        ]),
      ).toThrow();
      expect(
        db.prepare('PRAGMA table_info(interview_sessions)').all(),
      ).not.toContainEqual(
        expect.objectContaining({ name: 'additional_guidance' }),
      );
      expect(
        db.prepare('SELECT * FROM interview_sessions ORDER BY id').all(),
      ).toEqual(before);

      expect(runMigrations(db).appliedVersions).toEqual([
        19, 20, 21, 22, 23, 24, 25, 26,
      ]);
      const after = db
        .prepare('SELECT * FROM interview_sessions ORDER BY id')
        .all() as Array<Record<string, unknown>>;
      expect(after).toEqual(
        (before as Array<Record<string, unknown>>).map((row) => ({
          ...row,
          additional_guidance: null,
        })),
      );

      // The DB bound mirrors the IPC contract: empty or overlength is refused.
      const setGuidance = db.prepare(
        "UPDATE interview_sessions SET additional_guidance = ? WHERE id = 'draft-v18'",
      );
      expect(() => setGuidance.run('')).toThrow();
      expect(() => setGuidance.run('x'.repeat(2001))).toThrow();
      setGuidance.run('x'.repeat(2000));
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
  it('rolls back a failed recovery migration and preserves the active interview', () => {
    const db = openConnection(dbFile());
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((m) => m.version <= 17),
      );
      seedLocalProfile(db);
      db.prepare(`INSERT INTO interview_sessions
        (id, profile_id, method, subject, status, phase, created_at, updated_at)
        VALUES ('active-before-upgrade', 'local', 'deep_loop', 'History', 'active', 'awaiting_review', ?, ?)`).run(
        TS,
        TS,
      );
      expect(() =>
        runMigrations(db, [
          ...MIGRATIONS.filter((m) => m.version <= 17),
          {
            version: 18,
            name: 'broken_recovery',
            sql: MIGRATIONS[17].sql + '\nINSERT INTO missing_table VALUES (1);',
          },
        ]),
      ).toThrow();
      expect(
        db.prepare('PRAGMA table_info(interview_sessions)').all(),
      ).not.toContainEqual(
        expect.objectContaining({ name: 'generation_epoch' }),
      );
      expect(
        db
          .prepare(
            `SELECT status, phase FROM interview_sessions WHERE id='active-before-upgrade'`,
          )
          .get(),
      ).toEqual({ status: 'active', phase: 'awaiting_review' });
      expect(runMigrations(db).appliedVersions).toEqual([
        18, 19, 20, 21, 22, 23, 24, 25, 26,
      ]);
      expect(
        db
          .prepare(`SELECT status, phase, generation_epoch FROM interview_sessions
        WHERE id='active-before-upgrade'`)
          .get(),
      ).toEqual({
        status: 'active',
        phase: 'awaiting_review',
        generation_epoch: 0,
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('backfills only historically completed Quick-fire publications and rolls back a broken v17', () => {
    const db = openConnection(dbFile());
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 16),
      );
      seedLocalProfile(db);
      const insert = db.prepare(`INSERT INTO interview_sessions
        (id, profile_id, method, subject, question_count, status, created_at, updated_at, completed_at)
        VALUES (?, 'local', 'quick_fire', 'History', 5, ?, ?, ?, ?)`);
      insert.run('historical', 'completed', TS, TS, TS);
      insert.run('unfinished', 'active', TS, TS, null);
      expect(() =>
        runMigrations(db, [
          ...MIGRATIONS.filter((m) => m.version <= 16),
          {
            version: 17,
            name: 'broken_publication',
            sql: MIGRATIONS[16].sql + '\nINSERT INTO missing_table VALUES (1);',
          },
        ]),
      ).toThrow();
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE name='interview_publications'`,
          )
          .get(),
      ).toBeUndefined();
      expect(runMigrations(db, MIGRATIONS).appliedVersions).toEqual([
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      ]);
      expect(
        db
          .prepare(
            'SELECT session_id, summary_json, published_at FROM interview_publications',
          )
          .all(),
      ).toEqual([
        { session_id: 'historical', summary_json: null, published_at: TS },
      ]);
      expect(
        db
          .prepare('SELECT status FROM interview_sessions WHERE id=?')
          .get('unfinished'),
      ).toEqual({ status: 'active' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('upgrades only saved searches at the previous default and preserves historical runs', () => {
    const db = openConnection(dbFile());
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 15),
      );
      seedLocalProfile(db);
      const previous = newJobDiscoveryConfiguration();
      previous.name = 'Prior search';
      previous.intent.targetRoles = ['Designer'];
      previous.run.maxPagesPerTargetedSearch = 3; // Historical v15 SQL ceiling.
      previous.run.deadlineMs = 900_000;
      const shorter = structuredClone(previous);
      shorter.run.deadlineMs = 60_000;
      const insert = db.prepare(`INSERT INTO job_saved_searches
        (id, profile_id, config_json, created_at, updated_at)
        VALUES (?, 'local', ?, ?, ?)`);
      insert.run('old', JSON.stringify(previous), TS, TS);
      insert.run('short', JSON.stringify(shorter), TS, TS);
      db.prepare(`INSERT INTO job_discovery_runs
        (id, profile_id, saved_search_id, status, config_snapshot_json, query_plan_json, started_at, finished_at)
        VALUES ('historical', 'local', 'old', 'completed', ?, '["Designer"]', ?, ?)`).run(
        JSON.stringify(previous),
        TS,
        TS,
      );

      expect(runMigrations(db, MIGRATIONS).appliedVersions).toEqual([
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      ]);
      const rows = db
        .prepare(
          'SELECT id, config_json, updated_at FROM job_saved_searches ORDER BY id',
        )
        .all() as Array<{
        id: string;
        config_json: string;
        updated_at: string;
      }>;
      expect(JSON.parse(rows[0].config_json)).toEqual({
        ...previous,
        run: { ...previous.run, deadlineMs: 5_400_000 },
      });
      expect(JSON.parse(rows[1].config_json)).toEqual(shorter);
      expect(rows.every((row) => row.updated_at === TS)).toBe(true);
      const history = db
        .prepare(
          'SELECT config_snapshot_json FROM job_discovery_runs WHERE id=?',
        )
        .get('historical') as { config_snapshot_json: string };
      expect(history.config_snapshot_json).toBe(JSON.stringify(previous));
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('widens targeted reads from v23 without changing saved values or historical snapshots', () => {
    const db = openConnection(dbFile());
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 23),
      );
      seedLocalProfile(db);
      const old = newJobDiscoveryConfiguration();
      old.name = 'Prior search';
      old.intent.targetRoles = ['Engineer'];
      old.run.maxPagesPerTargetedSearch = 3;
      const saved = db.prepare(`INSERT INTO job_saved_searches
        (id,profile_id,config_json,created_at,updated_at)
        VALUES (?,'local',?,?,?)`);
      saved.run('old', JSON.stringify(old), TS, TS);
      db.prepare(`INSERT INTO job_discovery_runs
        (id,profile_id,saved_search_id,status,config_snapshot_json,query_plan_json,started_at,finished_at)
        VALUES ('historical','local','old','completed',?,'["Engineer"]',?,?)`).run(
        JSON.stringify(old),
        TS,
        TS,
      );

      expect(runMigrations(db).appliedVersions).toEqual([24, 25, 26]);
      expect(
        db
          .prepare('SELECT config_json FROM job_saved_searches WHERE id=?')
          .get('old'),
      ).toEqual({ config_json: JSON.stringify(old) });
      expect(
        db
          .prepare(
            'SELECT config_snapshot_json FROM job_discovery_runs WHERE id=?',
          )
          .get('historical'),
      ).toEqual({ config_snapshot_json: JSON.stringify(old) });

      const next = newJobDiscoveryConfiguration();
      next.name = 'New search';
      next.intent.targetRoles = ['Engineer'];
      expect(next.run.maxPagesPerTargetedSearch).toBe(5);
      expect(jobDiscoveryConfigurationV1Schema.safeParse(next).success).toBe(
        true,
      );
      saved.run('new', JSON.stringify(next), TS, TS);
      db.prepare(`INSERT INTO job_discovery_runs
        (id,profile_id,saved_search_id,status,config_snapshot_json,query_plan_json,started_at,finished_at)
        VALUES ('new-run','local','new','completed',?,'["Engineer"]',?,?)`).run(
        JSON.stringify(next),
        TS,
        TS,
      );
      const overLimit = structuredClone(next);
      overLimit.run.maxPagesPerTargetedSearch = 6;
      expect(
        jobDiscoveryConfigurationV1Schema.safeParse(overLimit).success,
      ).toBe(false);
      expect(() =>
        saved.run('invalid', JSON.stringify(overLimit), TS, TS),
      ).toThrow();
      expect(() =>
        db
          .prepare('UPDATE job_saved_searches SET config_json=? WHERE id=?')
          .run(JSON.stringify(overLimit), 'old'),
      ).toThrow();
      expect(() =>
        db
          .prepare(`INSERT INTO job_discovery_runs
          (id,profile_id,saved_search_id,status,config_snapshot_json,query_plan_json,started_at,finished_at)
          VALUES ('invalid-run','local','new','completed',?,'["Engineer"]',?,?)`)
          .run(JSON.stringify(overLimit), TS, TS),
      ).toThrow();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
  it('upgrades a populated v13 identity without erasing existing facts', () => {
    const db = openConnection(dbFile());
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 13),
      );
      seedLocalProfile(db);
      db.prepare('UPDATE profiles SET display_name=? WHERE id=?').run(
        'Prior User',
        LOCAL_PROFILE_ID,
      );
      const result = runMigrations(db, MIGRATIONS);
      expect(result.appliedVersions).toEqual([
        14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      ]);
      expect(
        db
          .prepare('SELECT display_name FROM profiles WHERE id=?')
          .get(LOCAL_PROFILE_ID),
      ).toEqual({ display_name: 'Prior User' });
      expect(
        db.prepare('SELECT count(*) AS count FROM identity_skills').get(),
      ).toEqual({ count: 0 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
  it('reopens an already-migrated populated DB without reapplying or losing data', () => {
    populate(workDir, 21);

    const storage = openStorage(workDir);
    try {
      // Upgrade once; reopening must not reapply the classification.
      expect(storage.migration.appliedVersions).toEqual([22, 23, 24, 25, 26]);
      expect(storage.migration.currentVersion).toBe(26);

      const db = storage.db;
      const profile = db
        .prepare('SELECT display_name, summary FROM profiles WHERE id = ?')
        .get(LOCAL_PROFILE_ID) as { display_name: string; summary: string };
      expect(profile.display_name).toBe('Prior User');
      expect(profile.summary).toBe('A career summary written before upgrade.');

      for (const [table, expected] of [
        ['career_targets', 1],
        ['experiences', 1],
        ['documents', 1],
        ['settings', 2],
        ['operation_runs', 1],
      ] as const) {
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as CountRow;
        expect(row.count).toBe(expected);
      }

      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
    } finally {
      storage.close();
    }
  });

  it('applies only new migrations on top of a populated DB, preserving data', () => {
    populate(workDir, 17);

    const db = openConnection(dbFile());
    try {
      db.prepare(`INSERT INTO interview_sessions
        (id, profile_id, method, subject, question_count, status, phase, created_at, updated_at)
        VALUES ('prior-interview', 'local', 'deep_loop', 'History', NULL, 'active', 'awaiting_review', ?, ?)`).run(
        TS,
        TS,
      );
      const next = {
        version: 27,
        name: 'test_add_note',
        sql: 'ALTER TABLE profiles ADD COLUMN notes TEXT;',
      };
      const result = runMigrations(db, [...MIGRATIONS, next]);

      // The populated v17 install takes the real recovery and guidance
      // migrations, then the test migration.
      expect(result.appliedVersions).toEqual([
        18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
      ]);
      expect(result.currentVersion).toBe(27);

      const profile = db
        .prepare('SELECT display_name, notes FROM profiles WHERE id = ?')
        .get(LOCAL_PROFILE_ID) as {
        display_name: string;
        notes: string | null;
      };
      expect(profile.display_name).toBe('Prior User');
      expect(profile.notes).toBeNull();
      expect(
        db
          .prepare(`SELECT status, phase, generation_epoch FROM interview_sessions
        WHERE id = 'prior-interview'`)
          .get(),
      ).toEqual({
        status: 'active',
        phase: 'awaiting_review',
        generation_epoch: 0,
      });

      const targets = db
        .prepare('SELECT COUNT(*) AS count FROM career_targets')
        .get() as CountRow;
      expect(targets.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rolls back a failed upgrade and leaves the populated DB fully intact (recovery)', () => {
    populate(workDir, 17);

    const db = openConnection(dbFile());
    try {
      const badNext = {
        version: 27,
        name: 'test_broken',
        sql: 'ALTER TABLE profiles ADD COLUMN notes TEXT; INSERT INTO missing_table (id) VALUES (1);',
      };
      expect(() => runMigrations(db, [...MIGRATIONS, badNext])).toThrow();

      // Schema version is unchanged and the failed column was rolled back.
      const version = db
        .prepare(
          'SELECT COALESCE(MAX(version),0) AS count FROM schema_migrations',
        )
        .get() as CountRow;
      expect(version.count).toBe(26);

      const columns = db.prepare('PRAGMA table_info(profiles)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((c) => c.name)).not.toContain('notes');

      // Pre-existing user data survives the failed upgrade untouched.
      const profile = db
        .prepare('SELECT display_name FROM profiles WHERE id = ?')
        .get(LOCAL_PROFILE_ID) as { display_name: string };
      expect(profile.display_name).toBe('Prior User');
      const docs = db
        .prepare('SELECT COUNT(*) AS count FROM documents')
        .get() as CountRow;
      expect(docs.count).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('dev/prod data separation', () => {
  it('resolves distinct data directories for packaged vs development', async () => {
    const { resolveDataDir } = await import('../src/main/core/paths');
    const base = '/Users/example/Library/Application Support/Career Workspace';
    expect(resolveDataDir(base, true)).toBe(base);
    expect(resolveDataDir(base, false)).toBe(`${base} (dev)`);
    expect(resolveDataDir(base, true)).not.toBe(resolveDataDir(base, false));
  });
});
