-- Schema v14. Skills are explicitly user-confirmed, never parsed from CV drafts.
CREATE TABLE identity_skills (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  PRIMARY KEY (profile_id, name)
);

-- A snapshot must remain scoped to the opportunity's own profile and the
-- successful, currently verified interpretation of its captured posting.
CREATE TRIGGER trg_job_match_snapshot_guard
BEFORE UPDATE OF match_json, match_computed_at ON job_opportunities
WHEN NEW.match_json IS NOT NULL AND (
  json_extract(NEW.match_json, '$.schemaVersion') IS NOT 1 OR
  json_extract(NEW.match_json, '$.opportunityId') IS NOT NEW.id OR
  json_extract(NEW.match_json, '$.computedAt') IS NOT NEW.match_computed_at OR
  (json_extract(NEW.match_json, '$.extractionId') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM job_jd_extractions e
    WHERE e.id=json_extract(NEW.match_json, '$.extractionId')
      AND e.opportunity_id=NEW.id AND e.status='extracted'
      AND e.capture_id=json_extract(NEW.resolution_evidence_json, '$.captureId')
  ))
)
BEGIN SELECT RAISE(ABORT, 'match snapshot requires owned extraction'); END;
