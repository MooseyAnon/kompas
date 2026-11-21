import fs from 'node:fs';
import { openDatabase } from './db/database';
import type { MigrationResult } from './db/migrator';
import type { SqliteDatabase } from './db/connection';
import { FileStore } from './files/file-store';
import { resolveStorageLayout, type StorageLayout } from './paths';
import { DiscoveryRunsRepository } from '../modules/job-discovery/runs.repository';

export interface Storage {
  db: SqliteDatabase;

  fileStore: FileStore;

  audioFileStore: FileStore;

  audioStagingDir: string;

  layout: StorageLayout;

  migration: MigrationResult;

  close(): void;
}

function createStorageDirectories(layout: StorageLayout): void {
  const directories = [
    layout.dataDir,
    layout.documentsOriginalsDir,
    layout.documentsTmpDir,
    layout.audioOriginalsDir,
    layout.audioTmpDir,
    layout.audioStagingDir,
    layout.logsDir,
  ];

  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function openFileStore(originalsDir: string, tempDir: string): FileStore {
  const store = new FileStore(originalsDir, tempDir);
  store.cleanupTempFiles();

  return store;
}

/**
 * Initialise durable local storage for a given data directory: create the
 * managed directory tree, open and migrate the SQLite database, seed the local
 * profile and build the managed file store. Throws on failure so the caller can
 * report storage as not-ready honestly rather than continuing half-initialised.
 */
export function openStorage(dataDir: string): Storage {
  const layout = resolveStorageLayout(dataDir);

  createStorageDirectories(layout);

  const { db, migration } = openDatabase(layout.databaseFile);

  try {
    new DiscoveryRunsRepository(db).reconcile(new Date().toISOString());
  } catch (error) {
    db.close();
    throw error;
  }

  const fileStore = openFileStore(
    layout.documentsOriginalsDir,
    layout.documentsTmpDir,
  );
  const audioFileStore = openFileStore(
    layout.audioOriginalsDir,
    layout.audioTmpDir,
  );

  return {
    db,
    fileStore,
    audioFileStore,
    audioStagingDir: layout.audioStagingDir,
    layout,
    migration,
    close() {
      db.close();
    },
  };
}
