-- Schema v12: durable, bounded resolution attempts and coded evidence.
-- Captures themselves remain append-only under the v10 raw-evidence trigger.
ALTER TABLE job_opportunities ADD COLUMN resolution_attempts INTEGER NOT NULL DEFAULT 0 CHECK(resolution_attempts BETWEEN 0 AND 2);
ALTER TABLE job_opportunities ADD COLUMN resolution_reason TEXT CHECK(resolution_reason IS NULL OR resolution_reason IN (
  'verified','missing_company','query_too_long','no_match','identity_mismatch','not_job_description',
  'page_unavailable','capture_too_large','page_truncated','deadline_reached','cancelled'
));
ALTER TABLE job_opportunities ADD COLUMN resolution_evidence_json TEXT CHECK(resolution_evidence_json IS NULL OR json_valid(resolution_evidence_json));

CREATE TRIGGER trg_job_opportunities_resolution_attempts
BEFORE UPDATE OF resolution_attempts ON job_opportunities
WHEN NEW.resolution_attempts < OLD.resolution_attempts OR NEW.resolution_attempts > 2
BEGIN SELECT RAISE(ABORT, 'resolution attempt limit reached'); END;
