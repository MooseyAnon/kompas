-- Career Workspace, interviews domain (schema v2)
-- Forward-only migration. Stage identifier is 005; this is the SECOND applied
-- schema version (001_init is version 1). All timestamps ISO-8601 UTC strings,
-- all IDs UUIDv4. Migration runner manages BEGIN/COMMIT and schema_migrations.
-- Never modifies 001_init tables or user data.

-- One configured interview. Only `draft` sessions are user-creatable in 005.
CREATE TABLE interview_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  career_target_id TEXT REFERENCES career_targets(id) ON DELETE SET NULL,
  target_snapshot_json TEXT
    CHECK (target_snapshot_json IS NULL OR json_valid(target_snapshot_json)),
  method TEXT NOT NULL CHECK (method IN ('quick_fire','deep_loop','mock')),
  subject TEXT NOT NULL
    CHECK (length(trim(subject)) > 0 AND length(subject) <= 200),
  question_count INTEGER,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','completed','abandoned')),
  phase TEXT,
  bar_snapshot_json TEXT
    CHECK (bar_snapshot_json IS NULL OR json_valid(bar_snapshot_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  -- Quick-fire requires a 5..10 count; every other method has no count.
  CHECK (
    (method = 'quick_fire' AND question_count BETWEEN 5 AND 10)
    OR (method <> 'quick_fire' AND question_count IS NULL)
  )
);
CREATE INDEX idx_interview_sessions_recent
  ON interview_sessions(profile_id, created_at DESC);
CREATE INDEX idx_interview_sessions_status
  ON interview_sessions(profile_id, status);
CREATE INDEX idx_interview_sessions_target
  ON interview_sessions(career_target_id);

-- One assessable question group. Quick-fire question = its own round; a
-- deep-loop round holds one primary question plus its follow-ups.
CREATE TABLE interview_rounds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  reassessment_of_round_id TEXT
    REFERENCES interview_rounds(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','awaiting_review','completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX idx_interview_rounds_session
  ON interview_rounds(session_id, ordinal);
CREATE INDEX idx_interview_rounds_reassessment
  ON interview_rounds(reassessment_of_round_id);

-- A question within a round. Exactly one primary per round (partial unique).
CREATE TABLE interview_questions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES interview_rounds(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN ('primary','follow_up')),
  question_text TEXT NOT NULL CHECK (length(trim(question_text)) > 0),
  competency TEXT,
  rubric_json TEXT CHECK (rubric_json IS NULL OR json_valid(rubric_json)),
  source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json)),
  created_at TEXT NOT NULL,
  UNIQUE (round_id, ordinal)
);
CREATE UNIQUE INDEX idx_interview_questions_primary
  ON interview_questions(round_id) WHERE kind = 'primary';
CREATE INDEX idx_interview_questions_round
  ON interview_questions(round_id, ordinal);

-- A user's response. One response per question in 005.
CREATE TABLE interview_answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL UNIQUE
    REFERENCES interview_questions(id) ON DELETE CASCADE,
  answer_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Review of one assessable round. No AI-generated content is written in 005.
CREATE TABLE interview_reviews (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL UNIQUE
    REFERENCES interview_rounds(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('pass','fail','unscored')),
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  feedback_json TEXT NOT NULL CHECK (json_valid(feedback_json)),
  rubric_snapshot_json TEXT
    CHECK (rubric_snapshot_json IS NULL OR json_valid(rubric_snapshot_json)),
  created_at TEXT NOT NULL
);
