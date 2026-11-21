-- Pack 012 / schema migration version 9.
-- Embedded by the migration registry after schema v8.
-- All timestamps are UTC ISO-8601 strings, supplied by the application service.

CREATE TABLE job_applications (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL CHECK(length(trim(company_name)) > 0),
  role_title TEXT NOT NULL CHECK(length(trim(role_title)) > 0),
  location TEXT,
  job_url TEXT,

  -- Set once, then immutable. A missing JD is allowed during initial entry.
  job_snapshot_json TEXT CHECK(job_snapshot_json IS NULL OR (json_valid(job_snapshot_json) AND json_type(job_snapshot_json) = 'object')),
  job_snapshot_captured_at TEXT,
  job_snapshot_source TEXT CHECK(
    job_snapshot_source IS NULL OR
    job_snapshot_source IN ('manual', 'web', 'email', 'other')
  ),

  -- Pointer to the current event; no duplicated mutable stage label on this row.
  current_stage_event_id TEXT REFERENCES application_stage_events(id) ON DELETE SET NULL,
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,

  CHECK(
    (job_snapshot_json IS NULL AND job_snapshot_captured_at IS NULL AND job_snapshot_source IS NULL)
    OR
    (job_snapshot_json IS NOT NULL AND job_snapshot_captured_at IS NOT NULL AND job_snapshot_source IS NOT NULL)
  )
);

CREATE INDEX idx_job_applications_profile_recent
  ON job_applications(profile_id, archived_at, updated_at DESC, id DESC);
CREATE INDEX idx_job_applications_company
  ON job_applications(profile_id, company_name);

CREATE TABLE application_stage_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_label TEXT NOT NULL CHECK(length(trim(stage_label)) > 0),
  stage_kind TEXT CHECK(
    stage_kind IS NULL OR stage_kind IN (
      'saved', 'applied', 'screening', 'interview', 'assessment',
      'offer', 'rejected', 'withdrawn', 'other'
    )
  ),
  -- Free-form detail such as 'phone_screen', 'technical', 'onsite', 'system_design'.
  stage_subtype TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('user', 'email', 'agent', 'import')),
  -- Optional stable source identifier: enables future idempotent automation.
  source_ref TEXT,
  source_evidence_json TEXT CHECK(
    source_evidence_json IS NULL OR json_valid(source_evidence_json)
  ),
  -- A correction is a new event; the original event is retained.
  corrects_event_id TEXT REFERENCES application_stage_events(id)
);

CREATE INDEX idx_application_stage_events_history
  ON application_stage_events(application_id, occurred_at, recorded_at, id);
CREATE UNIQUE INDEX idx_application_stage_events_source_dedupe
  ON application_stage_events(application_id, source, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE TABLE application_notes (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_event_id TEXT REFERENCES application_stage_events(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK(length(trim(body)) > 0),
  source TEXT NOT NULL CHECK(source IN ('self_reported', 'recruiter_feedback', 'other')),
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_application_notes_history
  ON application_notes(application_id, created_at DESC, id DESC);

CREATE TABLE application_documents (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  -- Null after deleting a managed document; copied identity stays available.
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('submitted_cv', 'submitted_cover_letter', 'supporting')),
  original_name_snapshot TEXT NOT NULL,
  category_snapshot TEXT NOT NULL CHECK(category_snapshot IN ('cv', 'cover_letter', 'other')),
  media_type_snapshot TEXT NOT NULL,
  sha256_snapshot TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  submitted_at TEXT,
  -- Mark an incorrect association as unlinked without erasing its audit record.
  unlinked_at TEXT,
  unlink_reason TEXT,
  CHECK(unlinked_at IS NOT NULL OR unlink_reason IS NULL)
);

CREATE INDEX idx_application_documents_history
  ON application_documents(application_id, linked_at DESC, id DESC);
CREATE INDEX idx_application_documents_document
  ON application_documents(document_id);

-- Preserve the originally captured JD (including its capture provenance).
CREATE TRIGGER trg_job_applications_snapshot_immutable
BEFORE UPDATE OF job_snapshot_json, job_snapshot_captured_at, job_snapshot_source
ON job_applications
WHEN OLD.job_snapshot_json IS NOT NULL AND (
  NEW.job_snapshot_json IS NOT OLD.job_snapshot_json OR
  NEW.job_snapshot_captured_at IS NOT OLD.job_snapshot_captured_at OR
  NEW.job_snapshot_source IS NOT OLD.job_snapshot_source
)
BEGIN
  SELECT RAISE(ABORT, 'captured job snapshots cannot be changed');
END;

-- The duplicated provenance columns must always agree with the original JSON.
CREATE TRIGGER trg_job_applications_snapshot_provenance_insert
BEFORE INSERT ON job_applications
WHEN NEW.job_snapshot_json IS NOT NULL AND (
  json_extract(NEW.job_snapshot_json, '$.schemaVersion') IS NOT 1 OR
  json_extract(NEW.job_snapshot_json, '$.capturedAt') IS NOT NEW.job_snapshot_captured_at OR
  json_extract(NEW.job_snapshot_json, '$.source') IS NOT NEW.job_snapshot_source
)
BEGIN
  SELECT RAISE(ABORT, 'job snapshot provenance does not match');
END;

CREATE TRIGGER trg_job_applications_snapshot_provenance_update
BEFORE UPDATE OF job_snapshot_json, job_snapshot_captured_at, job_snapshot_source
ON job_applications
WHEN NEW.job_snapshot_json IS NOT NULL AND (
  json_extract(NEW.job_snapshot_json, '$.schemaVersion') IS NOT 1 OR
  json_extract(NEW.job_snapshot_json, '$.capturedAt') IS NOT NEW.job_snapshot_captured_at OR
  json_extract(NEW.job_snapshot_json, '$.source') IS NOT NEW.job_snapshot_source
)
BEGIN
  SELECT RAISE(ABORT, 'job snapshot provenance does not match');
END;

-- Prevent an application from pointing at another application's stage event.
CREATE TRIGGER trg_job_applications_stage_owner_insert
BEFORE INSERT ON job_applications
WHEN NEW.current_stage_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM application_stage_events
  WHERE id = NEW.current_stage_event_id AND application_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'current stage event belongs to a different application');
END;

CREATE TRIGGER trg_job_applications_stage_owner
BEFORE UPDATE OF current_stage_event_id ON job_applications
WHEN NEW.current_stage_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM application_stage_events
  WHERE id = NEW.current_stage_event_id AND application_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'current stage event belongs to a different application');
END;

-- A correction must refer to an event from the same application.
CREATE TRIGGER trg_application_stage_events_correction_owner
BEFORE INSERT ON application_stage_events
WHEN NEW.corrects_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM application_stage_events
  WHERE id = NEW.corrects_event_id AND application_id = NEW.application_id
)
BEGIN
  SELECT RAISE(ABORT, 'corrected stage event belongs to a different application');
END;

-- Stage history is append-only; edits are represented by correction events.
CREATE TRIGGER trg_application_stage_events_no_update
BEFORE UPDATE ON application_stage_events
BEGIN
  SELECT RAISE(ABORT, 'stage events are append-only');
END;

-- A note may only refer to a stage event of its own application.
CREATE TRIGGER trg_application_notes_stage_owner_insert
BEFORE INSERT ON application_notes
WHEN NEW.stage_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM application_stage_events
  WHERE id = NEW.stage_event_id AND application_id = NEW.application_id
)
BEGIN
  SELECT RAISE(ABORT, 'note stage event belongs to a different application');
END;

CREATE TRIGGER trg_application_notes_stage_owner_update
BEFORE UPDATE OF stage_event_id, application_id ON application_notes
WHEN NEW.stage_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM application_stage_events
  WHERE id = NEW.stage_event_id AND application_id = NEW.application_id
)
BEGIN
  SELECT RAISE(ABORT, 'note stage event belongs to a different application');
END;

-- Linking a submitted file captures identity evidence. Later unlinking is allowed,
-- but changing what file was historically linked is not.
CREATE TRIGGER trg_application_documents_identity_immutable
BEFORE UPDATE OF
  application_id, purpose, original_name_snapshot, category_snapshot,
  media_type_snapshot, sha256_snapshot, linked_at
ON application_documents
WHEN
  NEW.application_id IS NOT OLD.application_id OR
  NEW.purpose IS NOT OLD.purpose OR
  NEW.original_name_snapshot IS NOT OLD.original_name_snapshot OR
  NEW.category_snapshot IS NOT OLD.category_snapshot OR
  NEW.media_type_snapshot IS NOT OLD.media_type_snapshot OR
  NEW.sha256_snapshot IS NOT OLD.sha256_snapshot OR
  NEW.linked_at IS NOT OLD.linked_at
BEGIN
  SELECT RAISE(ABORT, 'linked document identity cannot be changed');
END;
