import {
  openConnection,
  type ConnectionOptions,
  type SqliteDatabase,
} from './connection';
import { runMigrations, type MigrationResult } from './migrator';

/** Stable primary key for the single local profile (v1). */
export const LOCAL_PROFILE_ID = 'local';

export interface OpenDatabaseResult {
  db: SqliteDatabase;
  migration: MigrationResult;
}

/**
 * Idempotently seed the single `profiles.id='local'` row with empty fields.
 * Existing data is never overwritten (ON CONFLICT DO NOTHING).
 */
export function seedLocalProfile(
  db: SqliteDatabase,
  now: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO profiles (id, display_name, created_at, updated_at)
     VALUES (@id, '', @now, @now)
     ON CONFLICT(id) DO NOTHING`,
  ).run({ id: LOCAL_PROFILE_ID, now });
}

/**
 * Open the application database: connect with required pragmas, run pending
 * migrations transactionally and seed the local profile. Returns the live
 * connection and the migration summary.
 */
export function openDatabase(
  filename: string,
  options: ConnectionOptions = {},
): OpenDatabaseResult {
  const db = openConnection(filename, options);

  try {
    const migration = runMigrations(db);
    seedLocalProfile(db);

    return { db, migration };
  } catch (error) {
    db.close();
    throw error;
  }
}
