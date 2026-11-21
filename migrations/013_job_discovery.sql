-- Pack 013 / SQLite schema version 10 (installed in 013.1 after v9).
-- All six tables and the validation view are owned by Job Discovery.
-- Times are UTC ISO-8601 strings supplied by the domain service.
-- Shared Zod validation is repeated at IPC/domain boundaries. SQL validates
-- configurations independently, including direct writes and run snapshots.

CREATE TABLE job_saved_searches (
  id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Entire user-visible typed configuration lives in one JSON object.
  -- Validate its full nested shape with the shared Zod contract in service/IPC.
  config_json TEXT NOT NULL CHECK(
    json_valid(config_json) AND json_type(config_json) = 'object' AND
    json_extract(config_json, '$.schemaVersion') = 1 AND
    json_type(config_json, '$.name') = 'text' AND
    json_type(config_json, '$.active') IN ('true', 'false') AND
    json_type(config_json, '$.intent.targetRoles') = 'array' AND
    json_type(config_json, '$.query') = 'object' AND
    json_type(config_json, '$.run') = 'object' AND
    json_type(config_json, '$.sources') = 'object'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_job_saved_searches_profile
  ON job_saved_searches(profile_id, created_at DESC, id DESC);
CREATE INDEX idx_job_saved_searches_active
  ON job_saved_searches(profile_id, json_extract(config_json, '$.active'));

CREATE TABLE job_discovery_runs (
  id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  saved_search_id TEXT REFERENCES job_saved_searches(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed','cancelled','interrupted')),
  -- Snapshot exactly the same JobDiscoveryConfigurationV1 used by the UI;
  -- all query and run budgets are read from it. Historical runs are immutable.
  config_snapshot_json TEXT NOT NULL CHECK(
    json_valid(config_snapshot_json) AND json_type(config_snapshot_json) = 'object' AND
    json_extract(config_snapshot_json, '$.schemaVersion') = 1
  ),
  -- Generated queries are run OUTPUT, not separately editable configuration.
  query_plan_json TEXT NOT NULL CHECK(json_valid(query_plan_json) AND json_type(query_plan_json) = 'array'),
  stats_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(stats_json) AND json_type(stats_json) = 'object'),
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL))
);

CREATE INDEX idx_job_discovery_runs_recent
  ON job_discovery_runs(profile_id, started_at DESC, id DESC);
-- Only one active run per profile. Recover an orphaned running row on startup.
CREATE UNIQUE INDEX idx_job_discovery_runs_one_running
  ON job_discovery_runs(profile_id) WHERE status = 'running';

CREATE TABLE job_opportunities (
  id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  company TEXT,
  location TEXT,
  canonical_url TEXT,
  canonical_verified_at TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'discovered' CHECK(
    resolution_status IN ('discovered','unresolved','resolved','extraction_failed','extracted')
  ),
  review_decision TEXT NOT NULL DEFAULT 'new' CHECK(
    review_decision IN ('new','saved','dismissed','applied')
  ),
  application_id TEXT REFERENCES job_applications(id) ON DELETE SET NULL,
  match_json TEXT CHECK(match_json IS NULL OR json_valid(match_json)),
  match_computed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (canonical_url IS NULL AND canonical_verified_at IS NULL)
    OR (canonical_url IS NOT NULL AND canonical_verified_at IS NOT NULL)
  ),
  CHECK((match_json IS NULL AND match_computed_at IS NULL)
     OR (match_json IS NOT NULL AND match_computed_at IS NOT NULL))
);

CREATE INDEX idx_job_opportunities_browse
  ON job_opportunities(profile_id, review_decision, updated_at DESC, id DESC);
CREATE INDEX idx_job_opportunities_canonical
  ON job_opportunities(profile_id, canonical_url);
CREATE INDEX idx_job_opportunities_application
  ON job_opportunities(application_id);

CREATE TABLE job_opportunity_sources (
  id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES job_opportunities(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'saved_search' CHECK(source_type = 'saved_search'),
  provider TEXT NOT NULL CHECK(length(trim(provider)) > 0),
  -- Stable provider ID (e.g. LinkedIn job number, Indeed jk) or safe URL fingerprint.
  source_key TEXT NOT NULL CHECK(length(trim(source_key)) > 0),
  discovered_url TEXT NOT NULL CHECK(length(trim(discovered_url)) > 0),
  collection_url TEXT,
  listing_meta_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(listing_meta_json) AND json_type(listing_meta_json) = 'object'),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(profile_id, provider, source_key)
);

CREATE INDEX idx_job_opportunity_sources_opportunity
  ON job_opportunity_sources(opportunity_id, first_seen_at);

CREATE TABLE job_opportunity_captures (
  id TEXT PRIMARY KEY NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES job_opportunities(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL CHECK(length(trim(source_url)) > 0),
  reader_schema_version INTEGER,
  raw_readpage_json TEXT NOT NULL CHECK(json_valid(raw_readpage_json) AND json_type(raw_readpage_json) = 'object' AND length(CAST(raw_readpage_json AS BLOB)) <= 2097152),
  capture_status TEXT NOT NULL DEFAULT 'captured' CHECK(capture_status IN ('captured','extracted','failed')),
  extracted_jd_json TEXT CHECK(extracted_jd_json IS NULL OR json_valid(extracted_jd_json)),
  jd_schema_version INTEGER,
  inference_meta_json TEXT CHECK(inference_meta_json IS NULL OR json_valid(inference_meta_json)),
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
  captured_at TEXT NOT NULL,
  processed_at TEXT,
  CHECK(
    (capture_status = 'captured' AND extracted_jd_json IS NULL)
    OR (capture_status = 'failed' AND extracted_jd_json IS NULL)
    OR (capture_status = 'extracted' AND extracted_jd_json IS NOT NULL)
  )
);

CREATE INDEX idx_job_opportunity_captures_history
  ON job_opportunity_captures(opportunity_id, captured_at DESC, id DESC);

CREATE TABLE job_discovery_run_items (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES job_discovery_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES job_opportunity_sources(id) ON DELETE CASCADE,
  admitted INTEGER NOT NULL CHECK(admitted IN (0,1)),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'admitted','duplicate','resolved','unresolved','extracted','failed','skipped','cancelled'
  )),
  error_code TEXT,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, source_id)
);

CREATE INDEX idx_job_discovery_run_items_run
  ON job_discovery_run_items(run_id, admitted, observed_at, id);

-- Never mutate the captured source evidence. Retry or re-extraction should
-- create a new capture rather than silently changing an old capture.
CREATE TRIGGER trg_job_opportunity_captures_raw_immutable
BEFORE UPDATE OF source_url, reader_schema_version, raw_readpage_json, captured_at
ON job_opportunity_captures
WHEN
  NEW.source_url IS NOT OLD.source_url OR
  NEW.reader_schema_version IS NOT OLD.reader_schema_version OR
  NEW.raw_readpage_json IS NOT OLD.raw_readpage_json OR
  NEW.captured_at IS NOT OLD.captured_at
BEGIN
  SELECT RAISE(ABORT, 'captured job page evidence cannot be changed');
END;

-- Once an extraction has been stored, do not revise its interpretation in-place.
CREATE TRIGGER trg_job_opportunity_captures_extraction_immutable
BEFORE UPDATE OF extracted_jd_json, jd_schema_version, inference_meta_json,
                 capture_status, processed_at
ON job_opportunity_captures
WHEN OLD.extracted_jd_json IS NOT NULL AND (
  NEW.extracted_jd_json IS NOT OLD.extracted_jd_json OR
  NEW.jd_schema_version IS NOT OLD.jd_schema_version OR
  NEW.inference_meta_json IS NOT OLD.inference_meta_json OR
  NEW.capture_status IS NOT OLD.capture_status OR
  NEW.processed_at IS NOT OLD.processed_at
)
BEGIN
  SELECT RAISE(ABORT, 'extracted JD evidence cannot be overwritten');
END;

-- Prevent admission of more than ten NEW candidates to one run at the SQL
-- boundary; orchestration must also enforce the stricter full resource budget.
CREATE TRIGGER trg_job_discovery_run_items_admission_insert
BEFORE INSERT ON job_discovery_run_items
WHEN NEW.admitted = 1 AND
  (SELECT COUNT(*) FROM job_discovery_run_items
   WHERE run_id = NEW.run_id AND admitted = 1) >= 10
BEGIN
  SELECT RAISE(ABORT, 'discovery run candidate admission limit reached');
END;

CREATE TRIGGER trg_job_discovery_run_items_admission_update
BEFORE UPDATE OF admitted, run_id ON job_discovery_run_items
WHEN NEW.admitted = 1 AND (OLD.admitted = 0 OR NEW.run_id IS NOT OLD.run_id) AND
  (SELECT COUNT(*) FROM job_discovery_run_items
   WHERE run_id = NEW.run_id AND admitted = 1) >= 10
BEGIN
  SELECT RAISE(ABORT, 'discovery run candidate admission limit reached');
END;

-- Enforce source/opportunity ownership within profile (otherwise FKs alone
-- would allow a foreign profile to refer to an opportunity via a source row).
CREATE TRIGGER trg_job_opportunity_sources_profile_insert
BEFORE INSERT ON job_opportunity_sources
WHEN NOT EXISTS (
  SELECT 1 FROM job_opportunities
  WHERE id = NEW.opportunity_id AND profile_id = NEW.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'source opportunity belongs to a different profile');
END;

CREATE TRIGGER trg_job_opportunity_sources_profile_update
BEFORE UPDATE OF opportunity_id, profile_id ON job_opportunity_sources
WHEN NOT EXISTS (
  SELECT 1 FROM job_opportunities
  WHERE id = NEW.opportunity_id AND profile_id = NEW.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'source opportunity belongs to a different profile');
END;

-- Run and source must share a profile. The source owns the opportunity
-- reference; avoid duplicating it here so a verified cross-source merge can
-- reparent an alias without rewriting historical run observations.
CREATE TRIGGER trg_job_discovery_run_items_owner_insert
BEFORE INSERT ON job_discovery_run_items
WHEN NOT EXISTS (
  SELECT 1 FROM job_discovery_runs r
  JOIN job_opportunity_sources s ON s.id = NEW.source_id
  WHERE r.id = NEW.run_id AND r.profile_id = s.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'discovery run item identity or profile mismatch');
END;

CREATE TRIGGER trg_job_discovery_run_items_owner_update
BEFORE UPDATE OF run_id, source_id ON job_discovery_run_items
WHEN NOT EXISTS (
  SELECT 1 FROM job_discovery_runs r
  JOIN job_opportunity_sources s ON s.id = NEW.source_id
  WHERE r.id = NEW.run_id AND r.profile_id = s.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'discovery run item identity or profile mismatch');
END;

-- Protect opportunity-to-application profile ownership from a broken handoff.
CREATE TRIGGER trg_job_opportunities_application_owner_update
BEFORE UPDATE OF application_id, profile_id ON job_opportunities
WHEN NEW.application_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM job_applications a
  WHERE a.id = NEW.application_id AND a.profile_id = NEW.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'linked application belongs to a different profile');
END;

-- A discovery run must reference a saved search from the same profile.
CREATE TRIGGER trg_job_discovery_runs_search_owner_insert
BEFORE INSERT ON job_discovery_runs
WHEN NEW.saved_search_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM job_saved_searches
  WHERE id = NEW.saved_search_id AND profile_id = NEW.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'saved search belongs to a different profile');
END;

CREATE TRIGGER trg_job_discovery_runs_search_owner_update
BEFORE UPDATE OF saved_search_id, profile_id ON job_discovery_runs
WHEN NEW.saved_search_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM job_saved_searches
  WHERE id = NEW.saved_search_id AND profile_id = NEW.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'saved search belongs to a different profile');
END;

CREATE TRIGGER trg_job_opportunities_application_owner_insert
BEFORE INSERT ON job_opportunities
WHEN NEW.application_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM job_applications a
  WHERE a.id = NEW.application_id AND a.profile_id = NEW.profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'linked application belongs to a different profile');
END;

-- Editing the saved search cannot rewrite the settings or query plan that
-- launched a past run. Create the plan/snapshot at run insertion time.
CREATE TRIGGER trg_job_discovery_runs_plan_immutable
BEFORE UPDATE OF config_snapshot_json, query_plan_json, profile_id
ON job_discovery_runs
WHEN NEW.config_snapshot_json IS NOT OLD.config_snapshot_json OR
     NEW.query_plan_json IS NOT OLD.query_plan_json OR
     NEW.profile_id IS NOT OLD.profile_id
BEGIN
  SELECT RAISE(ABORT, 'historical discovery run configuration is immutable');
END;

-- This read-only projection shares one SQL validator between mutable saved
-- configs and immutable run snapshots. It stores no second configuration.
-- COALESCE is essential: SQLite CHECK/WHEN otherwise accepts missing JSON keys.
CREATE VIEW job_discovery_invalid_configurations AS
WITH configurations(kind, id, config) AS (
  SELECT 'search', id, config_json FROM job_saved_searches
  UNION ALL
  SELECT 'run', id, config_snapshot_json FROM job_discovery_runs
)
SELECT kind, id FROM configurations WHERE NOT COALESCE((
  json_type(config) = 'object'
  AND (SELECT count(*) FROM json_each(config)) = 7
  AND json_type(config, '$.schemaVersion') = 'integer'
  AND json_extract(config, '$.schemaVersion') = 1
  AND json_type(config, '$.name') = 'text'
  AND length(trim(json_extract(config, '$.name'))) BETWEEN 1 AND 120
  AND json_type(config, '$.active') IN ('true', 'false')
  AND json_type(config, '$.intent') = 'object'
  AND (SELECT count(*) FROM json_each(config, '$.intent')) = 7
  AND json_type(config, '$.intent.targetRoles') = 'array'
  AND json_array_length(config, '$.intent.targetRoles') BETWEEN 1 AND 5
  AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.intent.targetRoles')
    WHERE type <> 'text' OR length(trim(value)) NOT BETWEEN 1 AND 200)
  AND (SELECT count(DISTINCT lower(trim(value))) FROM json_each(config, '$.intent.targetRoles'))
    = json_array_length(config, '$.intent.targetRoles')
  AND json_type(config, '$.intent.seniority') IN ('null', 'text')
  AND (json_type(config, '$.intent.seniority') = 'null'
    OR length(trim(json_extract(config, '$.intent.seniority'))) BETWEEN 1 AND 120)
  AND json_type(config, '$.intent.field') IN ('null', 'text')
  AND (json_type(config, '$.intent.field') = 'null'
    OR length(trim(json_extract(config, '$.intent.field'))) BETWEEN 1 AND 200)
  AND json_type(config, '$.intent.location') IN ('null', 'text')
  AND (json_type(config, '$.intent.location') = 'null'
    OR length(trim(json_extract(config, '$.intent.location'))) BETWEEN 1 AND 200)
  AND json_type(config, '$.intent.targetYear') IN ('null', 'integer')
  AND (json_type(config, '$.intent.targetYear') = 'null'
    OR json_extract(config, '$.intent.targetYear') BETWEEN 2000 AND 2100)
  AND json_type(config, '$.intent.companies') = 'array'
  AND json_array_length(config, '$.intent.companies') <= 10
  AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.intent.companies')
    WHERE type <> 'text' OR length(trim(value)) NOT BETWEEN 1 AND 200)
  AND json_type(config, '$.intent.keywords') = 'array'
  AND json_array_length(config, '$.intent.keywords') <= 10
  AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.intent.keywords')
    WHERE type <> 'text' OR length(trim(value)) NOT BETWEEN 1 AND 200)
  AND json_type(config, '$.query') = 'object'
  AND (SELECT count(*) FROM json_each(config, '$.query')) = 2
  AND json_extract(config, '$.query.strategy') = 'deterministic_v1'
  AND json_type(config, '$.query.maxQueries') = 'integer'
  AND json_extract(config, '$.query.maxQueries') BETWEEN 1 AND 4
  AND json_type(config, '$.sources') = 'object'
  AND (SELECT count(*) FROM json_each(config, '$.sources')) = 1
  AND json_type(config, '$.sources.collectionProviders') = 'array'
  AND json_array_length(config, '$.sources.collectionProviders') BETWEEN 1 AND 2
  AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.sources.collectionProviders')
    WHERE type <> 'text' OR value NOT IN ('linkedin', 'indeed'))
  AND (SELECT count(DISTINCT value) FROM json_each(config, '$.sources.collectionProviders'))
    = json_array_length(config, '$.sources.collectionProviders')
  AND json_type(config, '$.run') = 'object'
  AND (SELECT count(*) FROM json_each(config, '$.run')) = 9
  AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.run') WHERE type <> 'integer'
    OR value < CASE WHEN key IN ('maxCollectionPages', 'maxTargetedSearchesPerCandidate',
      'maxPagesPerTargetedSearch', 'maxTransientRetries') THEN 0 ELSE 1 END
    OR value > CASE key
      WHEN 'maxNewCandidates' THEN 10 WHEN 'maxInspectedCandidates' THEN 100
      WHEN 'maxCollectionPages' THEN 5 WHEN 'maxTargetedSearchesPerCandidate' THEN 2
      WHEN 'maxPagesPerTargetedSearch' THEN 3 WHEN 'maxConcurrentWebOperations' THEN 2
      WHEN 'maxConcurrentExtractions' THEN 1 WHEN 'maxTransientRetries' THEN 1
      WHEN 'deadlineMs' THEN 900000 ELSE -1 END)
  -- Duplicate JSON object keys must not substitute for a missing/unknown key.
  AND NOT EXISTS (SELECT 1 FROM json_tree(config) AS node WHERE node.type = 'object'
    AND (SELECT count(*) FROM json_each(node.value)) <> (SELECT count(DISTINCT key) FROM json_each(node.value)))
), 0);

CREATE TRIGGER trg_job_saved_searches_config_insert
AFTER INSERT ON job_saved_searches
WHEN EXISTS (SELECT 1 FROM job_discovery_invalid_configurations WHERE kind = 'search' AND id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'invalid job discovery configuration');
END;
CREATE TRIGGER trg_job_saved_searches_config_update
AFTER UPDATE OF config_json ON job_saved_searches
WHEN EXISTS (SELECT 1 FROM job_discovery_invalid_configurations WHERE kind = 'search' AND id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'invalid job discovery configuration');
END;
CREATE TRIGGER trg_job_discovery_runs_config_insert
AFTER INSERT ON job_discovery_runs
WHEN EXISTS (SELECT 1 FROM job_discovery_invalid_configurations WHERE kind = 'run' AND id = NEW.id)
  OR json_extract(NEW.config_snapshot_json, '$.active') IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'invalid or inactive job discovery configuration');
END;

-- Ownership never transfers between profiles. Aliases may be reparented only
-- within their existing profile, checked by the source ownership triggers.
CREATE TRIGGER trg_job_saved_searches_owner_immutable
BEFORE UPDATE OF profile_id ON job_saved_searches WHEN NEW.profile_id IS NOT OLD.profile_id
BEGIN SELECT RAISE(ABORT, 'saved search owner is immutable'); END;
-- ON DELETE SET NULL may detach history, but it may never be reassigned.
CREATE TRIGGER trg_job_discovery_runs_search_immutable
BEFORE UPDATE OF saved_search_id ON job_discovery_runs
WHEN NEW.saved_search_id IS NOT NULL AND NEW.saved_search_id IS NOT OLD.saved_search_id
BEGIN SELECT RAISE(ABORT, 'historical saved search cannot be reassigned'); END;
CREATE TRIGGER trg_job_opportunities_owner_immutable
BEFORE UPDATE OF profile_id ON job_opportunities WHEN NEW.profile_id IS NOT OLD.profile_id
BEGIN SELECT RAISE(ABORT, 'opportunity owner is immutable'); END;
CREATE TRIGGER trg_job_opportunity_sources_owner_immutable
BEFORE UPDATE OF profile_id ON job_opportunity_sources WHEN NEW.profile_id IS NOT OLD.profile_id
BEGIN SELECT RAISE(ABORT, 'source owner is immutable'); END;
CREATE TRIGGER trg_job_opportunity_captures_owner_immutable
BEFORE UPDATE OF opportunity_id ON job_opportunity_captures WHEN NEW.opportunity_id IS NOT OLD.opportunity_id
BEGIN SELECT RAISE(ABORT, 'capture owner is immutable'); END;
