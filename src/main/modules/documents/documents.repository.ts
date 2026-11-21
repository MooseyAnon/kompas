import type { SqliteDatabase } from '../../core/db/connection';
import type { Document, DocumentCategory } from '../../../shared/contracts';

/**
 * Full internal document record, including the managed-store-relative path.
 * The `relativePath` stays inside the main process: it is used to resolve,
 * open and remove the managed file and is never returned to the renderer.
 */
export interface DocumentRecord {
  id: string;
  profileId: string;
  category: DocumentCategory;
  originalName: string;
  mediaType: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

interface DocumentRow {
  id: string;
  profile_id: string;
  category: DocumentCategory;
  original_name: string;
  media_type: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  created_at: string;
}

/** Columns exposed by the public listing; the internal path is never selected. */
type PublicDocumentRow = Omit<DocumentRow, 'profile_id' | 'relative_path'>;

/**
 * Documents-owned repository for the `documents` table. Owns all SQL for that
 * table; the internal `relative_path` is only ever returned to trusted
 * main-process callers via {@link DocumentRecord}, and the public
 * {@link Document} projection used at the IPC boundary omits it entirely.
 */
export class DocumentsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** Number of managed documents recorded (used by diagnostics/internal checks). */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM documents')
      .get() as { count: number };

    return row.count;
  }

  insert(record: DocumentRecord): void {
    this.db
      .prepare(
        `INSERT INTO documents
           (id, profile_id, category, original_name, media_type,
            relative_path, sha256, size_bytes, created_at)
         VALUES
           (@id, @profileId, @category, @originalName, @mediaType,
            @relativePath, @sha256, @sizeBytes, @createdAt)`,
      )
      .run(record);
  }

  /** Public listing (newest first); never includes the internal path. */
  list(): Document[] {
    const rows = this.db
      .prepare(
        `SELECT id, category, original_name, media_type, sha256, size_bytes,
                created_at
         FROM documents
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as PublicDocumentRow[];

    return rows.map(rowToPublicDocument);
  }

  /** Internal lookup used to resolve, open or remove the managed file. */
  get(id: string): DocumentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM documents WHERE id = ?')
      .get(id) as DocumentRow | undefined;
    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      profileId: row.profile_id,
      category: row.category,
      originalName: row.original_name,
      mediaType: row.media_type,
      relativePath: row.relative_path,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    };
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }
}

function rowToPublicDocument(row: PublicDocumentRow): Document {
  return {
    id: row.id,
    category: row.category,
    originalName: row.original_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

/** Map an internal record to the safe public projection (drops the path). */
export function toPublicDocument(record: DocumentRecord): Document {
  return {
    id: record.id,
    category: record.category,
    originalName: record.originalName,
    mediaType: record.mediaType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    createdAt: record.createdAt,
  };
}
