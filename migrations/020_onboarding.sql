-- Schema v22: classify existing installations once, during upgrade.
-- The seeded empty profile and technical operation records are not evidence of use.
INSERT INTO settings (key, value_json, updated_at)
SELECT 'onboarding.completed', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1 FROM profiles WHERE id = 'local' AND (
    length(trim(display_name)) > 0 OR current_stage IS NOT NULL OR
    length(trim(coalesce(current_role, ''))) > 0 OR
    length(trim(coalesce(location, ''))) > 0 OR
    length(trim(coalesce(summary, ''))) > 0
  )
  UNION ALL SELECT 1 FROM career_targets WHERE profile_id = 'local'
  UNION ALL SELECT 1 FROM experiences WHERE profile_id = 'local'
  UNION ALL SELECT 1 FROM identity_skills WHERE profile_id = 'local'
  UNION ALL SELECT 1 FROM documents WHERE profile_id = 'local'
  UNION ALL SELECT 1 FROM job_applications WHERE profile_id = 'local'
  UNION ALL SELECT 1 FROM interview_sessions WHERE profile_id = 'local'
  UNION ALL SELECT 1 FROM job_saved_searches WHERE profile_id = 'local'
)
ON CONFLICT(key) DO NOTHING;
