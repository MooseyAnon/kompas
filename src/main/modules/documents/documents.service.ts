import fs from 'node:fs';
import path from 'node:path';
import {
  DOCUMENT_MAX_BYTES,
  SUPPORTED_DOCUMENT_TYPES,
  type Document,
  type DocumentCategory,
  type DocumentsImportOutput,
} from '../../../shared/contracts';
import { LOCAL_PROFILE_ID } from '../../core/db/database';
import type { FileStore } from '../../core/files/file-store';
import { AppError } from '../../ipc/errors';
import type { TelemetryService } from '../telemetry/telemetry.service';
import {
  toPublicDocument,
  type DocumentRecord,
  type DocumentsRepository,
} from './documents.repository';
import {
  DocxExtractionAdapter,
  ExtractionError,
  ExtractionRegistry,
  PdfExtractionAdapter,
  readManagedDocument,
  type ExtractedDocument,
} from './extraction';

/** Opens a native file picker; resolves to an absolute path or null (cancelled). */
export type FilePicker = () => Promise<string | null>;

/** Opens a managed file by absolute path; resolves to '' on success or an error string. */
export type PathOpener = (absolutePath: string) => Promise<string>;

export interface DocumentsServiceDeps {
  repository: DocumentsRepository;
  fileStore: FileStore;
  pickFile: FilePicker;
  openPath: PathOpener;
  telemetry?: TelemetryService;
}

/** Leading bytes read to verify a file's declared type. */
const HEADER_BYTES = 8;

/** Authoritative magic-byte prefixes per supported extension; DOCX is a ZIP container. */
const MAGIC_BY_EXTENSION: Readonly<Record<string, Buffer>> = {
  pdf: Buffer.from('%PDF-', 'latin1'),
  docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

interface DetectedType {
  extension: string;
  mediaType: string;
}

interface StoredFile {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * In-process `documents` domain service. It owns the import lifecycle: a native
 * picker (owned by the main process — never a renderer-supplied path), file
 * type/size validation (extension plus magic bytes), a safe streamed copy into
 * the managed store, checksum/metadata persistence, orphan cleanup on failure,
 * and opening/removing managed files by id. It also offers trusted in-process
 * text extraction of stored CVs by id; no managed path ever crosses IPC.
 */
export class DocumentsService {
  private readonly extractors = new ExtractionRegistry([
    new PdfExtractionAdapter(),
    new DocxExtractionAdapter(),
  ]);
  private readonly repository: DocumentsRepository;
  private readonly fileStore: FileStore;
  private readonly pickFile: FilePicker;
  private readonly openPath: PathOpener;
  private readonly telemetry?: TelemetryService;

  constructor(deps: DocumentsServiceDeps) {
    this.repository = deps.repository;
    this.fileStore = deps.fileStore;
    this.pickFile = deps.pickFile;
    this.openPath = deps.openPath;
    this.telemetry = deps.telemetry;
  }

  /** Pick, validate, store and record a new document; cancellation is not an error. */
  async import(category: DocumentCategory): Promise<DocumentsImportOutput> {
    const startedAt = new Date().toISOString();

    const source = await this.pickFile();
    if (!source) {
      this.record('import', 'cancelled', startedAt, { category });
      return { cancelled: true };
    }

    assertImportableFile(source);
    const detected = detectType(source);
    const stored = await this.storeFile(source, detected.extension);

    const record: DocumentRecord = {
      id: globalThis.crypto.randomUUID(),
      profileId: LOCAL_PROFILE_ID,
      category,
      originalName: path.basename(source),
      mediaType: detected.mediaType,
      relativePath: stored.relativePath,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      createdAt: new Date().toISOString(),
    };
    this.insertOrRemoveFile(record);

    this.record('import', 'success', startedAt, {
      category,
      mediaType: detected.mediaType,
      sizeBytes: stored.sizeBytes,
    });

    return { cancelled: false, item: toPublicDocument(record) };
  }

  list(): Document[] {
    return this.repository.list();
  }

  /** Trusted in-process extraction by managed document ID; no path crosses IPC. */
  async extract(id: string, signal?: AbortSignal): Promise<ExtractedDocument> {
    const record = this.repository.get(id);
    if (!record || record.category !== 'cv') {
      throw new AppError('NOT_FOUND', 'That CV could not be found.');
    }

    let absolutePath: string;
    try {
      absolutePath = this.fileStore.resolve(record.relativePath);
    } catch {
      throw new ExtractionError('DOCUMENT_UNAVAILABLE');
    }

    const bytes = await readManagedDocument(absolutePath, signal);

    return this.extractors.extract(record.mediaType, bytes, signal);
  }

  getCv(id: string): Document | null {
    const record = this.repository.get(id);
    return record?.category === 'cv' ? toPublicDocument(record) : null;
  }

  /** Narrow in-process metadata lookup; never returns a managed filesystem path. */
  getMetadata(id: string): { profileId: string; document: Document } | null {
    const record = this.repository.get(id);
    return record
      ? { profileId: record.profileId, document: toPublicDocument(record) }
      : null;
  }

  async open(id: string): Promise<{ opened: true }> {
    const record = this.requireRecord(id);

    let absolutePath: string;
    try {
      absolutePath = this.fileStore.resolve(record.relativePath);
    } catch {
      throw new AppError('IO_ERROR', 'The managed file could not be located.');
    }

    if (!fs.existsSync(absolutePath)) {
      throw new AppError(
        'IO_ERROR',
        'The stored file is missing and cannot be opened.',
      );
    }

    const failure = await this.openPath(absolutePath);
    if (failure) {
      throw new AppError('IO_ERROR', 'The file could not be opened.');
    }

    return { opened: true };
  }

  remove(id: string): { removed: true } {
    const record = this.requireRecord(id);

    this.repository.delete(id);

    try {
      this.fileStore.remove(record.relativePath);
    } catch {
      // DB record is gone; a missing/undeletable file is reconciled later.
    }

    return { removed: true };
  }

  private requireRecord(id: string): DocumentRecord {
    const record = this.repository.get(id);
    if (!record) {
      throw new AppError('NOT_FOUND', 'That document could not be found.');
    }

    return record;
  }

  private async storeFile(
    source: string,
    extension: string,
  ): Promise<StoredFile> {
    const relativePath = this.fileStore.newRelativePath(extension);
    const { sha256, sizeBytes } = await this.fileStore.importFromPath(
      source,
      relativePath,
    );

    return { relativePath, sha256, sizeBytes };
  }

  /** Persist metadata; on failure remove the now-orphaned managed file. */
  private insertOrRemoveFile(record: DocumentRecord): void {
    try {
      this.repository.insert(record);
    } catch {
      try {
        this.fileStore.remove(record.relativePath);
      } catch {
        // Leave for later reconciliation; do not mask the original failure.
      }
      throw new AppError('IO_ERROR', 'The document could not be saved.');
    }
  }

  private record(
    operation: string,
    outcome: 'success' | 'cancelled',
    startedAt: string,
    detail: Record<string, string | number | boolean | null>,
  ): void {
    this.telemetry?.record({
      moduleId: 'documents',
      operation,
      outcome,
      startedAt,
      detail,
    });
  }
}

/** Reject unreadable, non-regular or oversized source files before copying. */
function assertImportableFile(sourcePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    throw new AppError('IO_ERROR', 'The selected file could not be read.');
  }

  if (!stat.isFile()) {
    throw new AppError('INVALID_INPUT', 'Please choose a file to import.');
  }

  if (stat.size > DOCUMENT_MAX_BYTES) {
    throw new AppError(
      'INVALID_INPUT',
      'That file is larger than the 25 MB import limit.',
    );
  }
}

/**
 * Validate the file type using both its extension (a hint) and its leading
 * magic bytes (authoritative). Executable or mismatched files are rejected.
 */
function detectType(sourcePath: string): DetectedType {
  const extension = path.extname(sourcePath).slice(1).toLowerCase();
  const supported = SUPPORTED_DOCUMENT_TYPES.find(
    (type) => type.extension === extension,
  );
  if (!supported) {
    throw new AppError(
      'INVALID_INPUT',
      'Only PDF and DOCX files can be imported.',
    );
  }

  const magic = MAGIC_BY_EXTENSION[supported.extension];
  const header = readHeader(sourcePath, HEADER_BYTES);
  if (!header.subarray(0, magic.length).equals(magic)) {
    throw new AppError(
      'INVALID_INPUT',
      'That file does not look like a valid PDF or DOCX document.',
    );
  }

  return { extension: supported.extension, mediaType: supported.mediaType };
}

function readHeader(sourcePath: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = fs.openSync(sourcePath, 'r');
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    throw new AppError('IO_ERROR', 'The selected file could not be read.');
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing further to do if the descriptor is already closed.
      }
    }
  }
}
