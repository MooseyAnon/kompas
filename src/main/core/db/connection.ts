import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

/** The concrete SQLite connection type used across the storage layer. */
export type SqliteDatabase = BetterSqliteDatabase;

export interface ConnectionOptions {
  /** Milliseconds a write will wait on a locked database before failing. */
  busyTimeoutMs?: number;
  /** Enable WAL journalling (on-disk databases only). Default true. */
  wal?: boolean;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Open a SQLite connection with the per-connection pragmas required by the data
 * model: foreign keys enforced, WAL journalling and a busy timeout. Foreign
 * keys are set outside any transaction, as SQLite requires.
 */
export function openConnection(
  filename: string,
  options: ConnectionOptions = {},
): SqliteDatabase {
  const db = new Database(filename);
  db.pragma(
    `busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`,
  );

  if (options.wal ?? true) {
    db.pragma('journal_mode = WAL');
  }

  db.pragma('foreign_keys = ON');

  return db;
}
