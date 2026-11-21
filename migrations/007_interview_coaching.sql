-- Career Workspace, interviews domain coaching (schema v3)
-- Forward-only migration. Stage identifier is 007.2; this is the THIRD applied
-- schema version (001_init is v1, 005_interviews is v2). All timestamps are
-- ISO-8601 UTC strings, all IDs UUIDv4. The migration runner manages
-- BEGIN/COMMIT and schema_migrations. Never modifies earlier tables or data.

-- One coaching result per failed deep-loop round. Coaching is produced only
-- after a genuinely below-bar review and is owned entirely by the interviews
-- domain. The bounded, validated advice/focus/provenance lives in content_json.
CREATE TABLE interview_coaching (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL UNIQUE
    REFERENCES interview_rounds(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_interview_coaching_round
  ON interview_coaching(round_id);
