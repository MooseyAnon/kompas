import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../ipc/errors';
import { assertNoSymlinkEscape, resolveWithinRoot } from './path-safety';

export interface StoredFileResult {
  /** Store-relative path of the committed file (also stored in the DB). */
  relativePath: string;

  sha256: string;

  sizeBytes: number;
}

export interface FileStoreOptions {
  /** Max age (ms) of a temp file before `cleanupTempFiles` removes it. */
  tempMaxAgeMs?: number;
}

const DEFAULT_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Managed file store. All originals live under a single root directory; a
 * sibling temp directory stages in-progress writes. Every read/write/delete is
 * confined to the root with lexical containment and symlink-escape checks, so
 * no caller-supplied name can redirect I/O outside the managed area.
 *
 * The renderer never provides filesystem paths: it addresses files by a
 * store-relative path produced here. Import orchestration (native dialog, type
 * and size validation) is wired in stage 003 and consumes this service.
 */
export class FileStore {
  private readonly root: string;

  private readonly tempDir: string;

  private readonly tempMaxAgeMs: number;

  constructor(root: string, tempDir: string, options: FileStoreOptions = {}) {
    this.root = path.resolve(root);
    this.tempDir = path.resolve(tempDir);
    this.tempMaxAgeMs = options.tempMaxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS;
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  /** Generate a random, collision-resistant store-relative name. */
  newRelativePath(extension?: string): string {
    const ext = normaliseExtension(extension);

    return `${crypto.randomUUID()}${ext}`;
  }

  /** Resolve a store-relative path to a safe absolute path (containment + symlink checks). */
  resolve(relativePath: string): string {
    const absolute = resolveWithinRoot(this.root, relativePath);
    assertNoSymlinkEscape(this.root, absolute);

    return absolute;
  }

  exists(relativePath: string): boolean {
    return fs.existsSync(this.resolve(relativePath));
  }

  /**
   * Stream a source file into the store: copy to a temp file while hashing and
   * measuring size, then atomically rename into place. Cleans up the staged
   * temp file on any failure. The source path is supplied only by trusted
   * main-process code (never the renderer).
   */
  async importFromPath(
    sourcePath: string,
    relativePath: string,
  ): Promise<StoredFileResult> {
    const destination = this.resolve(relativePath);
    const destinationDir = path.dirname(destination);
    fs.mkdirSync(destinationDir, { recursive: true });

    const tempPath = path.join(this.tempDir, `${crypto.randomUUID()}.part`);
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;

    try {
      const source = fs.createReadStream(sourcePath);
      source.on('data', (chunk: Buffer) => {
        sizeBytes += chunk.length;
        hash.update(chunk);
      });

      const sink = fs.createWriteStream(tempPath, { flags: 'wx' });
      await pipeline(source, sink);
      fs.renameSync(tempPath, destination);
    } catch {
      safeUnlink(tempPath);
      throw new AppError('IO_ERROR', 'Failed to store the file.');
    }

    return {
      relativePath,
      sha256: hash.digest('hex'),
      sizeBytes,
    };
  }

  /** Safely remove a managed file. A missing file is treated as already removed. */
  remove(relativePath: string): void {
    const absolute = this.resolve(relativePath);

    try {
      fs.rmSync(absolute, { force: true });
    } catch {
      throw new AppError('IO_ERROR', 'Failed to remove the file.');
    }
  }

  /** Best-effort removal of stale staged temp files left by interrupted writes. */
  cleanupTempFiles(now: number = Date.now()): number {
    let removed = 0;
    let entries: string[];

    try {
      entries = fs.readdirSync(this.tempDir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const full = path.join(this.tempDir, entry);

      try {
        const stat = fs.statSync(full);

        if (now - stat.mtimeMs >= this.tempMaxAgeMs) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        // Ignore files that vanish or cannot be stat-ed during cleanup.
      }
    }

    return removed;
  }
}

function normaliseExtension(extension?: string): string {
  if (!extension) {
    return '';
  }

  const trimmed = extension.trim().toLowerCase();

  if (trimmed.length === 0) {
    return '';
  }

  const withoutDot = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;

  if (!/^[a-z0-9]{1,16}$/.test(withoutDot)) {
    return '';
  }

  return `.${withoutDot}`;
}

function safeUnlink(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // Best-effort cleanup; nothing further we can safely do here.
  }
}
