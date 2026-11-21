-- One immutable Quick-fire publication per session. Backfill legacy completed
-- sessions without rewriting their existing answers or reviews.
CREATE TABLE interview_publications (
  session_id TEXT PRIMARY KEY REFERENCES interview_sessions(id) ON DELETE CASCADE,
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  published_at TEXT NOT NULL
);

INSERT INTO interview_publications (session_id, summary_json, published_at)
SELECT id, NULL, COALESCE(completed_at, updated_at)
FROM interview_sessions WHERE method = 'quick_fire' AND status = 'completed';
