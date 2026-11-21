import fs from 'node:fs';
import path from 'node:path';
import type { StorageUsage } from '../../shared/contracts';
import { AppError } from '../ipc/errors';
import { resolveStorageLayout } from './paths';

type StorageCategory = StorageUsage['categories'][number]['category'];

type StorageInventory = Record<StorageCategory, string[]>;

interface ScanBudget {
  entries: number;
}

const MARKER = '.career-reset-pending';
const MARKER_CONTENT = 'career-workspace-reset-v1\n';
const MAX_ENTRIES = 20_000;

// Electron's default-session data is owned by this app's userData identity.
// Playwright launches ephemeral contexts and does not create a persistent profile.
const CACHE_DIRECTORIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'GrShaderCache',
  'ShaderCache',
];

const SESSION_ENTRIES = [
  'Session Storage',
  'Local Storage',
  'IndexedDB',
  'Service Worker',
  'blob_storage',
  'Network',
  'Cookies',
  'Cookies-journal',
];

function storageTargets(dataDir: string): StorageInventory {
  const layout = resolveStorageLayout(dataDir);

  return {
    database: [
      layout.databaseFile,
      `${layout.databaseFile}-wal`,
      `${layout.databaseFile}-shm`,
      `${layout.databaseFile}-journal`,
    ],
    documents: [layout.documentsDir],
    audio: [layout.audioDir],
    logs: [layout.logsDir],
    cache: CACHE_DIRECTORIES.map((name) => path.join(dataDir, name)),
    session: SESSION_ENTRIES.map((name) => path.join(dataDir, name)),
  };
}

function statIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function checkRoot(dataDir: string): void {
  const unsafeRoot =
    !path.isAbsolute(dataDir) ||
    path.parse(dataDir).root === path.resolve(dataDir);

  if (unsafeRoot) {
    throw new Error('Unsafe data root');
  }

  const stat = statIfPresent(dataDir);

  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Unsafe data root');
  }

  if (
    fs.realpathSync(dataDir) !==
    path.join(fs.realpathSync(path.dirname(dataDir)), path.basename(dataDir))
  ) {
    throw new Error('Unsafe data root');
  }
}

/** Walk only explicitly known roots; symlinks are never followed or counted. */
function measureStorageEntry(file: string, budget: ScanBudget): number {
  const stat = statIfPresent(file);

  if (!stat) {
    return 0;
  }

  if (++budget.entries > MAX_ENTRIES) {
    throw new Error('Usage scan limit reached');
  }

  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('Unsafe storage entry');
  }

  if (stat.isFile()) {
    return stat.size;
  }

  let bytes = 0;

  for (const entry of fs.readdirSync(file)) {
    bytes += measureStorageEntry(path.join(file, entry), budget);
  }

  return bytes;
}

function measureCategory(
  files: string[],
  budget: ScanBudget,
  rootSafe: boolean,
): number | null {
  let bytes = 0;

  try {
    if (!rootSafe) {
      throw new Error('Unsafe root');
    }

    for (const file of files) {
      bytes += measureStorageEntry(file, budget);
    }
  } catch {
    return null;
  }

  return bytes;
}

/** Unknown categories make the total unknown; all categories share one scan budget. */
export function storageUsage(dataDir: string): StorageUsage {
  const inventory = storageTargets(dataDir);
  const budget = { entries: 0 };
  let rootSafe = true;

  try {
    checkRoot(dataDir);
  } catch {
    rootSafe = false;
  }

  const categories = (Object.keys(inventory) as StorageCategory[]).map(
    (category) => ({
      category,
      bytes: measureCategory(inventory[category], budget, rootSafe),
    }),
  );
  const partial = categories.some((category) => category.bytes === null);

  return {
    categories,
    totalBytes: partial
      ? null
      : categories.reduce((sum, category) => sum + (category.bytes ?? 0), 0),
    partial,
  };
}

/** Preflight every owned target, not just the first one removed. */
export function validateResetTargets(dataDir: string): void {
  checkRoot(dataDir);
  const budget = { entries: 0 };

  for (const files of Object.values(storageTargets(dataDir))) {
    for (const file of files) {
      measureStorageEntry(file, budget);
    }
  }

  const marker = statIfPresent(path.join(dataDir, MARKER));

  if (
    marker &&
    (!marker.isFile() ||
      fs.readFileSync(path.join(dataDir, MARKER), 'utf8') !== MARKER_CONTENT)
  ) {
    throw new Error('Unsafe reset marker');
  }
}

/** Persist the reset request for the next launch, after validating all owned targets. */
export function requestStorageReset(dataDir: string): void {
  try {
    validateResetTargets(dataDir);
    fs.writeFileSync(path.join(dataDir, MARKER), MARKER_CONTENT, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    throw new AppError(
      'CONFLICT',
      'Reset could not start. ' +
        'Check storage permissions or restart and try again.',
    );
  }
}

/** Called on the next process launch, before opening SQLite or a renderer window. */
export function finishPendingReset(dataDir: string): boolean {
  const marker = path.join(dataDir, MARKER);

  if (!statIfPresent(marker)) {
    return false;
  }

  validateResetTargets(dataDir);

  for (const files of Object.values(storageTargets(dataDir))) {
    for (const file of files) {
      if (statIfPresent(file)) {
        fs.rmSync(file, { recursive: true, force: false });
      }
    }
  }

  fs.unlinkSync(marker);

  return true;
}
