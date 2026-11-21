import type { SqliteDatabase } from './connection';
import { MIGRATIONS, type Migration } from './migrations';

export interface MigrationResult {
  /** Versions applied during this run (empty when already up to date). */
  appliedVersions: number[];

  /** Highest applied schema version after this run. */
  currentVersion: number;
}

interface VersionRow {
  version: number;
}

const CREATE_BOOKKEEPING = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);`;

/**
 * Apply any pending migrations in version order. Each migration runs inside its
 * own transaction together with its bookkeeping insert, so a failure rolls the
 * migration back entirely and surfaces as a thrown error — never a half-applied
 * schema. Already-applied versions are skipped, making re-runs idempotent.
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: Migration[] = MIGRATIONS,
): MigrationResult {
  db.exec(CREATE_BOOKKEEPING);

  const appliedRows = db
    .prepare<[], VersionRow>(
      'SELECT version FROM schema_migrations ORDER BY version',
    )
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));

  const pending = migrations
    .filter((migration) => !applied.has(migration.version))
    .sort((a, b) => a.version - b.version);

  const appliedVersions: number[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, new Date().toISOString());
    });

    apply();
    appliedVersions.push(migration.version);
  }

  const current = db
    .prepare<[], VersionRow>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
    )
    .get()!;

  return { appliedVersions, currentVersion: current.version };
}
