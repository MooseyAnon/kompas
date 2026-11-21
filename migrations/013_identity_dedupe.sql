-- Schema v11: the per-run user ceiling and cross-run admissions are enforced
-- independently of the in-process identity service. v10 remains immutable.
CREATE TRIGGER trg_job_discovery_admission_snapshot_insert
BEFORE INSERT ON job_discovery_run_items
WHEN NEW.admitted = 1 AND (
  (SELECT COUNT(*) FROM job_discovery_run_items WHERE run_id=NEW.run_id AND admitted=1)
    >= (SELECT json_extract(config_snapshot_json, '$.run.maxNewCandidates')
        FROM job_discovery_runs WHERE id=NEW.run_id)
  OR EXISTS (SELECT 1 FROM job_discovery_run_items WHERE source_id=NEW.source_id AND admitted=1)
)
BEGIN SELECT RAISE(ABORT, 'candidate admission already recorded or snapshot limit reached'); END;

CREATE TRIGGER trg_job_discovery_admission_snapshot_update
BEFORE UPDATE OF admitted, run_id, source_id ON job_discovery_run_items
WHEN NEW.admitted=1 AND (OLD.admitted=0 OR NEW.run_id<>OLD.run_id OR NEW.source_id<>OLD.source_id) AND (
  (SELECT COUNT(*) FROM job_discovery_run_items WHERE run_id=NEW.run_id AND admitted=1)
    >= (SELECT json_extract(config_snapshot_json, '$.run.maxNewCandidates')
        FROM job_discovery_runs WHERE id=NEW.run_id)
  OR EXISTS (SELECT 1 FROM job_discovery_run_items WHERE source_id=NEW.source_id AND admitted=1 AND id<>OLD.id)
)
BEGIN SELECT RAISE(ABORT, 'candidate admission already recorded or snapshot limit reached'); END;
