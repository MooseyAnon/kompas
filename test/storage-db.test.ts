import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../src/main/core/db/connection';
import { openConnection } from '../src/main/core/db/connection';
import {
  LOCAL_PROFILE_ID,
  openDatabase,
  seedLocalProfile,
} from '../src/main/core/db/database';
import { runMigrations } from '../src/main/core/db/migrator';
import { MIGRATIONS } from '../src/main/core/db/migrations';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-db-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function dbPath(name = 'app.sqlite'): string {
  return path.join(workDir, name);
}

interface CountRow {
  count: number;
}

describe('migration runner', () => {
  it('creates tables and seeds exactly one local profile on first run', () => {
    const file = dbPath();
    const { db, migration } = openDatabase(file);
    try {
      expect(migration.appliedVersions).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        21, 22, 23, 24, 25, 26,
      ]);
      expect(migration.currentVersion).toBe(26);

      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      for (const expected of [
        'profiles',
        'career_targets',
        'documents',
        'experiences',
        'operation_runs',
        'schema_migrations',
        'settings',
        'interview_sessions',
        'interview_rounds',
        'interview_questions',
        'interview_answers',
        'interview_reviews',
        'interview_coaching',
        'audio_recordings',
        'audio_transcription_jobs',
        'audio_transcripts',
        'interview_answer_drafts',
        'interview_answer_audio',
        'job_applications',
        'application_stage_events',
        'application_notes',
        'application_documents',
        'job_saved_searches',
        'job_discovery_runs',
        'job_opportunities',
        'job_opportunity_sources',
        'job_opportunity_captures',
        'job_jd_extractions',
        'job_discovery_run_items',
      ]) {
        expect(names).toContain(expected);
      }

      const profiles = db
        .prepare('SELECT COUNT(*) AS count FROM profiles')
        .get() as CountRow;
      expect(profiles.count).toBe(1);

      const local = db
        .prepare('SELECT id, display_name FROM profiles WHERE id = ?')
        .get(LOCAL_PROFILE_ID) as { id: string; display_name: string };
      expect(local.id).toBe(LOCAL_PROFILE_ID);
      expect(local.display_name).toBe('');
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second open applies no migrations and keeps one profile', () => {
    const file = dbPath();
    const first = openDatabase(file);
    first.db.close();

    const second = openDatabase(file);
    try {
      expect(second.migration.appliedVersions).toEqual([]);
      expect(second.migration.currentVersion).toBe(26);
      const profiles = second.db
        .prepare('SELECT COUNT(*) AS count FROM profiles')
        .get() as CountRow;
      expect(profiles.count).toBe(1);
    } finally {
      second.db.close();
    }
  });

  it('seeding twice never duplicates or overwrites the local profile', () => {
    const file = dbPath();
    const { db } = openDatabase(file);
    try {
      db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(
        'Edited',
        LOCAL_PROFILE_ID,
      );
      seedLocalProfile(db);
      const row = db
        .prepare('SELECT display_name FROM profiles WHERE id = ?')
        .get(LOCAL_PROFILE_ID) as { display_name: string };
      expect(row.display_name).toBe('Edited');
      const profiles = db
        .prepare('SELECT COUNT(*) AS count FROM profiles')
        .get() as CountRow;
      expect(profiles.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rolls back a failed migration and surfaces the error', () => {
    const db = openConnection(dbPath('bad.sqlite'));
    try {
      const migrations = [
        {
          version: 1,
          name: 'bad',
          sql: 'CREATE TABLE will_rollback (id INTEGER PRIMARY KEY); INSERT INTO missing_table (id) VALUES (1);',
        },
      ];
      expect(() => runMigrations(db, migrations)).toThrow();

      const table = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='will_rollback'`,
        )
        .get();
      expect(table).toBeUndefined();

      const versions = db
        .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
        .get() as CountRow;
      expect(versions.count).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('fresh database integrity', () => {
  it('passes integrity_check and foreign_key_check', () => {
    const { db } = openDatabase(dbPath());
    try {
      const integrity = db.pragma('integrity_check', { simple: true });
      expect(integrity).toBe('ok');
      const fkIssues = db.pragma('foreign_key_check') as unknown[];
      expect(fkIssues).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('constraints', () => {
  function seededDb(): SqliteDatabase {
    return openDatabase(dbPath()).db;
  }

  it('enforces foreign keys on child inserts', () => {
    const db = seededDb();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO career_targets (id, profile_id, role_title, created_at, updated_at)
             VALUES ('t1', 'does-not-exist', 'Engineer', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('rejects invalid JSON in json_valid-constrained columns', () => {
    const db = seededDb();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO settings (key, value_json, updated_at)
             VALUES ('theme', 'not json', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/CHECK/i);

      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('theme', '{"mode":"dark"}', '2026-01-01T00:00:00.000Z')`,
      ).run();
      const row = db
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get('theme') as { value_json: string };
      expect(row.value_json).toBe('{"mode":"dark"}');
    } finally {
      db.close();
    }
  });

  it('enforces CHECK constraints (blank role title rejected)', () => {
    const db = seededDb();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO career_targets (id, profile_id, role_title, created_at, updated_at)
             VALUES ('t2', ?, '   ', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(LOCAL_PROFILE_ID),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });
});

describe('durability across restart', () => {
  it('persists data written before close on an on-disk database', () => {
    const file = dbPath();
    const first = openDatabase(file);
    first.db
      .prepare('UPDATE profiles SET display_name = ? WHERE id = ?')
      .run('Persisted Name', LOCAL_PROFILE_ID);
    first.db
      .prepare(
        `INSERT INTO career_targets (id, profile_id, role_title, created_at, updated_at)
         VALUES ('t-keep', ?, 'Data Scientist', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(LOCAL_PROFILE_ID);
    first.db.close();

    const second = openDatabase(file);
    try {
      const profile = second.db
        .prepare('SELECT display_name FROM profiles WHERE id = ?')
        .get(LOCAL_PROFILE_ID) as { display_name: string };
      expect(profile.display_name).toBe('Persisted Name');

      const target = second.db
        .prepare('SELECT role_title FROM career_targets WHERE id = ?')
        .get('t-keep') as { role_title: string };
      expect(target.role_title).toBe('Data Scientist');
    } finally {
      second.db.close();
    }
  });
});

describe('migration registry', () => {
  it('embeds the canonical init migration as version 1', () => {
    expect(MIGRATIONS[0]).toMatchObject({ version: 1, name: '001_init' });
    expect(MIGRATIONS[0].sql).toContain('CREATE TABLE profiles');
  });
});
