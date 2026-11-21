import fs from 'node:fs';

export interface JsonlLoggerOptions {
  /** Rotate once the active log reaches this size. */
  maxBytes?: number;
  /** Number of rotated files to retain (app.jsonl.1 .. app.jsonl.N). */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

/**
 * Bounded, append-only JSONL logger for safe operational detail. Writing is
 * best-effort: a logging failure must never interrupt a successful user action,
 * so errors are swallowed here. Callers must pass only sanitised, non-sensitive
 * fields (no user text, file paths or secrets).
 */
export class JsonlLogger {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(file: string, options: JsonlLoggerOptions = {}) {
    this.file = file;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  }

  write(record: Record<string, unknown>): void {
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    } catch {
      // Best-effort logging; never throw into the calling operation.
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) {
      return;
    }
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = `${this.file}.${index}`;
      const to = `${this.file}.${index + 1}`;
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    }
    fs.renameSync(this.file, `${this.file}.1`);
  }
}
