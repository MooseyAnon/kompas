-- Career Workspace, initial schema (v1)
-- SQLite 3.38+ with JSON support; all timestamps ISO-8601 UTC strings.
-- Migration runner manages BEGIN/COMMIT and schema_migrations bookkeeping.
-- Execute `PRAGMA foreign_keys = ON` per connection, outside any transaction.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  current_stage TEXT CHECK (current_stage IN ('student','graduate','employed','career_change','other') OR current_stage IS NULL),
  current_role TEXT,
  location TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE career_targets (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role_title TEXT NOT NULL CHECK (length(trim(role_title)) > 0),
  target_level TEXT,
  sector TEXT,
  location TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_career_targets_profile ON career_targets(profile_id, active);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('cv','cover_letter','other')),
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_documents_profile ON documents(profile_id, created_at);

CREATE TABLE experiences (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('employment','education','project','other')),
  organisation TEXT,
  role_title TEXT NOT NULL CHECK (length(trim(role_title)) > 0),
  start_date TEXT,  -- YYYY-MM-DD or NULL; avoid pretending dates are known
  end_date TEXT,
  description TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'user_confirmed'
    CHECK (verification_status IN ('user_confirmed','unconfirmed')),
  source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_date IS NULL OR (length(start_date)=10 AND date(start_date)=start_date)),
  CHECK (end_date IS NULL OR (length(end_date)=10 AND date(end_date)=end_date)),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_experiences_profile ON experiences(profile_id, category);

-- Reserved for subsequent AI/inference capabilities: no auto-accepting suggestions in foundation.
CREATE TABLE profile_suggestions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_entity TEXT NOT NULL CHECK (target_entity IN ('profile','career_target','experience')),
  target_id TEXT,              -- optional until a future feature defines application semantics
  proposed_change_json TEXT NOT NULL CHECK (json_valid(proposed_change_json)),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_suggestions_profile ON profile_suggestions(profile_id, status);

-- Minimal audit history of *user mutations*, not event sourcing.
CREATE TABLE profile_changes (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('profile','career_target','experience')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','accepted_suggestion')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_profile_changes_profile ON profile_changes(profile_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);

-- Diagnostic summaries only. Do not persist user documents, prompts or transcript bodies here.
CREATE TABLE operation_runs (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  error_code TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
);
CREATE INDEX idx_operation_runs_recent ON operation_runs(started_at DESC);
CREATE INDEX idx_operation_runs_module ON operation_runs(module_id, started_at DESC);
