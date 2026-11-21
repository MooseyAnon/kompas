import type { SqliteDatabase } from '../../core/db/connection';
import {
  cvDraftSchema,
  cvDiagnosticsSchema,
  type CvImport,
} from '../../../shared/contracts';

/** Raw `cv_imports` row; draft and diagnostics are JSON text. */
interface Row {
  id: string;
  document_id: string | null;
  status: CvImport['status'];
  draft_json: string | null;
  diagnostics_json: string;
  source_sha256: string;
  applied_status: 'not_applied';
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): CvImport {
  return {
    id: row.id,
    documentId: row.document_id,
    status: row.status,
    draft: row.draft_json
      ? cvDraftSchema.parse(JSON.parse(row.draft_json))
      : null,
    diagnostics: cvDiagnosticsSchema.parse(JSON.parse(row.diagnostics_json)),
    sourceSha256: row.source_sha256,
    appliedStatus: row.applied_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CvImportsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CvImport | null {
    const row = this.db
      .prepare('SELECT * FROM cv_imports WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  byDocument(documentId: string): CvImport | null {
    const row = this.db
      .prepare('SELECT * FROM cv_imports WHERE document_id = ?')
      .get(documentId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(limit = 30): CvImport[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM cv_imports ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(limit) as Row[]
    ).map(fromRow);
  }

  insert(item: CvImport): void {
    this.db
      .prepare(
        'INSERT INTO cv_imports (id,document_id,status,draft_json,diagnostics_json,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        item.id,
        item.documentId,
        item.status,
        null,
        JSON.stringify(item.diagnostics),
        item.sourceSha256,
        item.createdAt,
        item.updatedAt,
      );
  }

  update(item: CvImport): void {
    this.db
      .prepare(
        'UPDATE cv_imports SET status=?,draft_json=?,diagnostics_json=?,updated_at=? WHERE id=?',
      )
      .run(
        item.status,
        item.draft ? JSON.stringify(cvDraftSchema.parse(item.draft)) : null,
        JSON.stringify(cvDiagnosticsSchema.parse(item.diagnostics)),
        item.updatedAt,
        item.id,
      );
  }

  discard(id: string): void {
    this.db.prepare('DELETE FROM cv_imports WHERE id=?').run(id);
  }

  reconcile(): void {
    this.db
      .prepare(
        "UPDATE cv_imports SET status='cancelled', updated_at=? WHERE status='processing'",
      )
      .run(new Date().toISOString());
  }
}
