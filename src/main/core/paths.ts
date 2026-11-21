import path from 'node:path';

/**
 * Absolute paths for the managed local data directory. All application data is
 * rooted here; nothing writable lives in the ASAR, repository or CWD.
 */
export interface StorageLayout {
  dataDir: string;

  databaseFile: string;

  documentsDir: string;

  documentsOriginalsDir: string;

  documentsTmpDir: string;

  audioDir: string;

  audioOriginalsDir: string;

  audioTmpDir: string;

  audioStagingDir: string;

  logsDir: string;

  appLogFile: string;
}

/** Derive the full managed layout from a single data directory. */
export function resolveStorageLayout(dataDir: string): StorageLayout {
  const documentsDir = path.join(dataDir, 'documents');
  const audioDir = path.join(dataDir, 'audio');
  const logsDir = path.join(dataDir, 'logs');

  return {
    dataDir,
    databaseFile: path.join(dataDir, 'app.sqlite'),
    documentsDir,
    documentsOriginalsDir: path.join(documentsDir, 'originals'),
    documentsTmpDir: path.join(documentsDir, '.tmp'),
    audioDir,
    audioOriginalsDir: path.join(audioDir, 'originals'),
    audioTmpDir: path.join(audioDir, '.tmp'),
    audioStagingDir: path.join(audioDir, '.staging'),
    logsDir,
    appLogFile: path.join(logsDir, 'app.jsonl'),
  };
}

/**
 * Give development builds a distinct data identity so running the app or tests
 * in dev never reads or mutates installed production data.
 */
export function resolveDataDir(
  baseUserData: string,
  isPackaged: boolean,
): string {
  return isPackaged ? baseUserData : `${baseUserData} (dev)`;
}
