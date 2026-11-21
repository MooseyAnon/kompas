-- Schema v21: bounded, candidate-scoped resolution history. Older claimed
-- attempts have no rows here; absence means details unavailable, not no work.
CREATE TABLE job_resolution_attempts (
  id TEXT PRIMARY KEY,
  run_item_id TEXT NOT NULL REFERENCES job_discovery_run_items(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2),
  status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','interrupted')),
  reason TEXT CHECK(reason IS NULL OR reason IN (
    'verified','missing_company','query_too_long','no_match','identity_mismatch',
    'not_job_description','page_unavailable','capture_too_large','page_truncated',
    'deadline_reached','cancelled','search_budget_zero'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL)),
  UNIQUE(run_item_id,sequence)
);

CREATE TABLE job_resolution_searches (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES job_resolution_attempts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 2),
  query TEXT NOT NULL CHECK(length(query) BETWEEN 1 AND 256 AND length(CAST(query AS BLOB)) <= 1024),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
  error_code TEXT CHECK(error_code IS NULL OR error_code IN (
    'INVALID_INPUT','UNSAFE_URL','NO_CAPABLE_PROVIDER','PROVIDER_UNAVAILABLE',
    'PROVIDER_FAILURE','RATE_LIMITED','TIMEOUT','QUEUE_FULL','CANCELLED',
    'CONTENT_LIMIT','BROWSER_UNAVAILABLE','BROWSER_LAUNCH_FAILED',
    'NAVIGATION_FAILED','INTERNAL_ERROR','WEB_FAILED'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL)),
  UNIQUE(attempt_id,ordinal)
);

CREATE TABLE job_resolution_results (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES job_resolution_searches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 20),
  url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048 AND length(CAST(url AS BLOB)) <= 8192),
  disposition TEXT NOT NULL CHECK(disposition IN (
    'seen','reading','not_opened','read_failed','rejected','accepted','interrupted'
  )),
  reason TEXT CHECK(reason IS NULL OR reason IN (
    'budget','duplicate','policy','accepted_earlier','stopped',
    'identity_mismatch','not_job_description','page_unavailable',
    'page_truncated','capture_too_large','WEB_FAILED',
    'INVALID_INPUT','UNSAFE_URL','NO_CAPABLE_PROVIDER','PROVIDER_UNAVAILABLE',
    'PROVIDER_FAILURE','RATE_LIMITED','TIMEOUT','QUEUE_FULL','CANCELLED',
    'CONTENT_LIMIT','BROWSER_UNAVAILABLE','BROWSER_LAUNCH_FAILED',
    'NAVIGATION_FAILED','INTERNAL_ERROR'
  )),
  capture_id TEXT REFERENCES job_opportunity_captures(id),
  CHECK((disposition='accepted' AND capture_id IS NOT NULL AND reason IS NULL)
    OR (disposition<>'accepted' AND capture_id IS NULL)),
  UNIQUE(search_id,ordinal)
);

CREATE INDEX idx_job_resolution_attempts_item ON job_resolution_attempts(run_item_id,sequence);
CREATE INDEX idx_job_resolution_searches_attempt ON job_resolution_searches(attempt_id,ordinal);
CREATE INDEX idx_job_resolution_results_search ON job_resolution_results(search_id,ordinal);

-- The parent run item must actually have admitted the source; the opportunity
-- attempt ceiling is checked at claim time in the existing opportunity row.
CREATE TRIGGER trg_job_resolution_attempt_admitted BEFORE INSERT ON job_resolution_attempts
WHEN NOT EXISTS (SELECT 1 FROM job_discovery_run_items WHERE id=NEW.run_item_id AND admitted=1)
BEGIN SELECT RAISE(ABORT,'resolution history requires admitted source'); END;

CREATE TRIGGER trg_job_resolution_attempt_limit BEFORE INSERT ON job_resolution_attempts
WHEN (SELECT count(*) FROM job_resolution_attempts a
  JOIN job_discovery_run_items i ON i.id=a.run_item_id
  JOIN job_opportunity_sources s ON s.id=i.source_id
  WHERE s.opportunity_id=(SELECT s2.opportunity_id FROM job_discovery_run_items i2
    JOIN job_opportunity_sources s2 ON s2.id=i2.source_id WHERE i2.id=NEW.run_item_id)) >= 2
  OR EXISTS (SELECT 1 FROM job_resolution_attempts a
    JOIN job_discovery_run_items i ON i.id=a.run_item_id
    JOIN job_opportunity_sources s ON s.id=i.source_id
    WHERE a.sequence=NEW.sequence AND s.opportunity_id=(SELECT s2.opportunity_id
      FROM job_discovery_run_items i2 JOIN job_opportunity_sources s2 ON s2.id=i2.source_id
      WHERE i2.id=NEW.run_item_id))
BEGIN SELECT RAISE(ABORT,'resolution opportunity history limit reached'); END;

CREATE TRIGGER trg_job_resolution_accepted_capture BEFORE UPDATE OF disposition,capture_id ON job_resolution_results
WHEN NEW.disposition='accepted' AND NOT EXISTS (
  SELECT 1 FROM job_opportunity_captures c
  JOIN job_resolution_searches q ON q.id=NEW.search_id
  JOIN job_resolution_attempts a ON a.id=q.attempt_id
  JOIN job_discovery_run_items i ON i.id=a.run_item_id
  JOIN job_opportunity_sources s ON s.id=i.source_id
  WHERE c.id=NEW.capture_id AND c.opportunity_id=s.opportunity_id
    AND json_extract(c.raw_readpage_json,'$.requestedUrl')=NEW.url
)
BEGIN SELECT RAISE(ABORT,'accepted result requires owned capture'); END;
