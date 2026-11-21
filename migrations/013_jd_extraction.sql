-- Schema v13: one append-only interpretation attempt per verified original capture.
CREATE TABLE job_jd_extractions (
  id TEXT PRIMARY KEY NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES job_opportunities(id) ON DELETE CASCADE,
  capture_id TEXT NOT NULL REFERENCES job_opportunity_captures(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES job_discovery_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('running','extracted','failed')),
  error_code TEXT CHECK(error_code IS NULL OR error_code IN ('INVALID_SCHEMA','MODEL_UNAVAILABLE','MODEL_FAILED','RESOURCE_LIMIT','DEADLINE_REACHED','CANCELLED','NOT_JOB_DESCRIPTION','INTERRUPTED')),
  jd_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(jd_schema_version=1),
  extracted_jd_json TEXT CHECK(extracted_jd_json IS NULL OR json_valid(extracted_jd_json)),
  inference_meta_json TEXT CHECK(inference_meta_json IS NULL OR json_valid(inference_meta_json)),
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostics_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status='running' AND finished_at IS NULL AND extracted_jd_json IS NULL) OR
        (status='failed' AND finished_at IS NOT NULL AND extracted_jd_json IS NULL) OR
        (status='extracted' AND finished_at IS NOT NULL AND extracted_jd_json IS NOT NULL)),
  CHECK(status <> 'extracted' OR inference_meta_json IS NOT NULL)
);
CREATE INDEX idx_job_jd_extractions_history ON job_jd_extractions(opportunity_id, started_at DESC, id DESC);
CREATE UNIQUE INDEX idx_job_jd_extractions_success ON job_jd_extractions(capture_id) WHERE status='extracted';
CREATE UNIQUE INDEX idx_job_jd_extractions_running ON job_jd_extractions(capture_id) WHERE status='running';
CREATE TRIGGER trg_job_jd_extractions_owner
BEFORE INSERT ON job_jd_extractions
WHEN NOT EXISTS (
  SELECT 1 FROM job_opportunity_captures c JOIN job_opportunities o ON o.id=c.opportunity_id
  JOIN job_discovery_runs r ON r.id=NEW.run_id
  WHERE c.id=NEW.capture_id AND c.opportunity_id=NEW.opportunity_id AND o.profile_id=r.profile_id
    AND o.canonical_verified_at IS NOT NULL
    AND json_extract(o.resolution_evidence_json, '$.captureId')=NEW.capture_id
)
BEGIN SELECT RAISE(ABORT, 'extraction requires verified owned capture'); END;
CREATE TRIGGER trg_job_jd_extractions_immutable
BEFORE UPDATE ON job_jd_extractions WHEN OLD.status <> 'running' OR
  NEW.id IS NOT OLD.id OR NEW.opportunity_id IS NOT OLD.opportunity_id OR
  NEW.capture_id IS NOT OLD.capture_id OR NEW.run_id IS NOT OLD.run_id OR
  NEW.started_at IS NOT OLD.started_at OR NEW.status='running'
BEGIN SELECT RAISE(ABORT, 'extraction evidence is immutable'); END;
