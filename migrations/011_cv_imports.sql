-- Private, review-only CV candidates. Never modifies canonical identity.
CREATE TABLE cv_imports (
  id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','ready','partial','failed','cancelled')),
  draft_json TEXT CHECK(draft_json IS NULL OR json_valid(draft_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  source_sha256 TEXT NOT NULL,
  applied_status TEXT NOT NULL DEFAULT 'not_applied' CHECK(applied_status = 'not_applied'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cv_imports_document_unique ON cv_imports(document_id);
CREATE INDEX cv_imports_recent ON cv_imports(created_at DESC, id DESC);
