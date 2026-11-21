-- Schema v20: a new run may admit an unfinished, rediscovered opportunity.
-- Eligibility stays in the domain transaction; SQL independently enforces one
-- admitted source per opportunity per run and the frozen admission ceiling.
DROP TRIGGER trg_job_discovery_admission_snapshot_insert;
DROP TRIGGER trg_job_discovery_admission_snapshot_update;

CREATE TRIGGER trg_job_discovery_admission_snapshot_insert
BEFORE INSERT ON job_discovery_run_items
WHEN NEW.admitted = 1 AND (
  (SELECT COUNT(*) FROM job_discovery_run_items WHERE run_id=NEW.run_id AND admitted=1)
    >= (SELECT json_extract(config_snapshot_json, '$.run.maxNewCandidates')
        FROM job_discovery_runs WHERE id=NEW.run_id)
  OR EXISTS (
    SELECT 1 FROM job_discovery_run_items i
    JOIN job_opportunity_sources prior ON prior.id=i.source_id
    JOIN job_opportunity_sources incoming ON incoming.id=NEW.source_id
    WHERE i.run_id=NEW.run_id AND i.admitted=1 AND prior.opportunity_id=incoming.opportunity_id
  )
)
BEGIN SELECT RAISE(ABORT, 'candidate admission already recorded or snapshot limit reached'); END;

CREATE TRIGGER trg_job_discovery_admission_snapshot_update
BEFORE UPDATE OF admitted, run_id, source_id ON job_discovery_run_items
WHEN NEW.admitted=1 AND (OLD.admitted=0 OR NEW.run_id<>OLD.run_id OR NEW.source_id<>OLD.source_id) AND (
  (SELECT COUNT(*) FROM job_discovery_run_items WHERE run_id=NEW.run_id AND admitted=1 AND id<>OLD.id)
    >= (SELECT json_extract(config_snapshot_json, '$.run.maxNewCandidates')
        FROM job_discovery_runs WHERE id=NEW.run_id)
  OR EXISTS (
    SELECT 1 FROM job_discovery_run_items i
    JOIN job_opportunity_sources prior ON prior.id=i.source_id
    JOIN job_opportunity_sources incoming ON incoming.id=NEW.source_id
    WHERE i.run_id=NEW.run_id AND i.admitted=1 AND i.id<>OLD.id
      AND prior.opportunity_id=incoming.opportunity_id
  )
)
BEGIN SELECT RAISE(ABORT, 'candidate admission already recorded or snapshot limit reached'); END;
