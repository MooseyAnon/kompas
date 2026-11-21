-- Schema v15: durable Applications-owned correlation for a trusted Discovery handoff.
ALTER TABLE job_applications ADD COLUMN discovery_opportunity_id TEXT;
CREATE UNIQUE INDEX idx_applications_discovery_opportunity
  ON job_applications(discovery_opportunity_id) WHERE discovery_opportunity_id IS NOT NULL;
CREATE TRIGGER trg_applications_discovery_correlation_insert
BEFORE INSERT ON job_applications WHEN NEW.discovery_opportunity_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM job_opportunities WHERE id=NEW.discovery_opportunity_id AND profile_id=NEW.profile_id
)
BEGIN SELECT RAISE(ABORT, 'application discovery owner mismatch'); END;
CREATE TRIGGER trg_applications_discovery_correlation_immutable
BEFORE UPDATE OF discovery_opportunity_id ON job_applications
WHEN NEW.discovery_opportunity_id IS NOT OLD.discovery_opportunity_id
BEGIN SELECT RAISE(ABORT, 'application discovery correlation is immutable'); END;
CREATE TRIGGER trg_job_opportunities_correlated_application
BEFORE UPDATE OF application_id ON job_opportunities
WHEN NEW.application_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM job_applications WHERE id=NEW.application_id AND profile_id=NEW.profile_id
    AND (discovery_opportunity_id=NEW.id OR discovery_opportunity_id IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'application correlation mismatch'); END;
