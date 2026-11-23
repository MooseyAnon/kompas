-- Forward-only replacement (ADRs 005 and 006): saved searches and run snapshots may
-- carry optional intent.workArrangement, intent.locations, workArrangements, experienceLevels,
-- contractTypes and salary. Configurations without them, all of them before
-- this version, stay valid unchanged; nothing is rewritten. Keeps ADR 005's
-- workArrangement and 023's targeted page ceiling.
DROP TRIGGER trg_job_saved_searches_config_insert;
DROP TRIGGER trg_job_saved_searches_config_update;
DROP TRIGGER trg_job_discovery_runs_config_insert;
DROP VIEW job_discovery_invalid_configurations;

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
  AND (SELECT count(*) FROM json_each(config, '$.intent'))
    = 7 + (json_type(config, '$.intent.workArrangement') IS NOT NULL)
      + (json_type(config, '$.intent.locations') IS NOT NULL)
      + (json_type(config, '$.intent.workArrangements') IS NOT NULL)
      + (json_type(config, '$.intent.experienceLevels') IS NOT NULL)
      + (json_type(config, '$.intent.contractTypes') IS NOT NULL)
      + (json_type(config, '$.intent.salary') IS NOT NULL)
  AND (json_type(config, '$.intent.workArrangement') IS NULL
    OR (json_type(config, '$.intent.workArrangement') = 'text'
      AND json_extract(config, '$.intent.workArrangement')
        IN ('any', 'remote', 'hybrid', 'on_site')))
  AND (json_type(config, '$.intent.locations') IS NULL
    OR (json_type(config, '$.intent.locations') = 'array'
      AND json_array_length(config, '$.intent.locations') <= 5
      AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.intent.locations')
        WHERE type <> 'text' OR length(trim(value)) NOT BETWEEN 1 AND 200)
      AND (SELECT count(DISTINCT lower(trim(value))) FROM json_each(config, '$.intent.locations'))
        = json_array_length(config, '$.intent.locations')))
  AND (json_type(config, '$.intent.workArrangements') IS NULL
    OR (json_type(config, '$.intent.workArrangements') = 'array'
      AND json_array_length(config, '$.intent.workArrangements') <= 3
      AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.intent.workArrangements')
        WHERE type <> 'text' OR value NOT IN ('remote', 'hybrid', 'on_site'))
      AND (SELECT count(DISTINCT value) FROM json_each(config, '$.intent.workArrangements'))
        = json_array_length(config, '$.intent.workArrangements')))
  AND (json_type(config, '$.intent.experienceLevels') IS NULL
    OR (json_type(config, '$.intent.experienceLevels') = 'array'
      AND json_array_length(config, '$.intent.experienceLevels') <= 5
      AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.intent.experienceLevels')
        WHERE type <> 'text' OR value NOT IN ('entry', 'junior', 'mid', 'senior', 'expert'))
      AND (SELECT count(DISTINCT value) FROM json_each(config, '$.intent.experienceLevels'))
        = json_array_length(config, '$.intent.experienceLevels')))
  AND (json_type(config, '$.intent.contractTypes') IS NULL
    OR (json_type(config, '$.intent.contractTypes') = 'array'
      AND json_array_length(config, '$.intent.contractTypes') <= 6
      AND NOT EXISTS (SELECT 1 FROM json_each(config, '$.intent.contractTypes')
        WHERE type <> 'text' OR value NOT IN ('full_time', 'part_time', 'contract', 'temporary', 'internship', 'apprenticeship'))
      AND (SELECT count(DISTINCT value) FROM json_each(config, '$.intent.contractTypes'))
        = json_array_length(config, '$.intent.contractTypes')))
  AND (json_type(config, '$.intent.salary') IS NULL
    OR (json_type(config, '$.intent.salary') = 'object'
      AND (SELECT count(*) FROM json_each(config, '$.intent.salary')) = 3
      AND json_type(config, '$.intent.salary.minimum') IN ('null', 'integer')
      AND (json_type(config, '$.intent.salary.minimum') = 'null'
        OR json_extract(config, '$.intent.salary.minimum') BETWEEN 0 AND 1000000)
      AND json_type(config, '$.intent.salary.currency') = 'text'
      AND json_extract(config, '$.intent.salary.currency') IN ('GBP', 'EUR', 'USD')
      AND json_type(config, '$.intent.salary.onlyWithSalary') IN ('true', 'false')))
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
    OR (key <> 'deadlineMs' AND value > CASE key
      WHEN 'maxNewCandidates' THEN 10 WHEN 'maxInspectedCandidates' THEN 100
      WHEN 'maxCollectionPages' THEN 5 WHEN 'maxTargetedSearchesPerCandidate' THEN 2
      WHEN 'maxPagesPerTargetedSearch' THEN 5 WHEN 'maxConcurrentWebOperations' THEN 2
      WHEN 'maxConcurrentExtractions' THEN 1 WHEN 'maxTransientRetries' THEN 1
      ELSE -1 END))
  AND NOT EXISTS (SELECT 1 FROM json_tree(config) AS node WHERE node.type = 'object'
    AND (SELECT count(*) FROM json_each(node.value)) <> (SELECT count(DISTINCT key) FROM json_each(node.value)))
), 0);

CREATE TRIGGER trg_job_saved_searches_config_insert
AFTER INSERT ON job_saved_searches
WHEN EXISTS (SELECT 1 FROM job_discovery_invalid_configurations WHERE kind = 'search' AND id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'invalid job discovery configuration'); END;
CREATE TRIGGER trg_job_saved_searches_config_update
AFTER UPDATE OF config_json ON job_saved_searches
WHEN EXISTS (SELECT 1 FROM job_discovery_invalid_configurations WHERE kind = 'search' AND id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'invalid job discovery configuration'); END;
CREATE TRIGGER trg_job_discovery_runs_config_insert
AFTER INSERT ON job_discovery_runs
WHEN EXISTS (SELECT 1 FROM job_discovery_invalid_configurations WHERE kind = 'run' AND id = NEW.id)
  OR json_extract(NEW.config_snapshot_json, '$.active') IS NOT 1
BEGIN SELECT RAISE(ABORT, 'invalid or inactive job discovery configuration'); END;
