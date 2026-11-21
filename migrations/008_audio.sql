-- Career Workspace, shared audio domain (schema v4)
-- Forward-only, additive migration. Stage identifier is 008.1; this is the
-- FOURTH applied schema version (001_init=1, 005_interviews=2,
-- 007_interview_coaching=3). Never modifies earlier tables or user data.
-- All timestamps ISO-8601 UTC strings, all IDs UUIDv4. The migration runner
-- manages BEGIN/COMMIT and schema_migrations bookkeeping.

-- One durable, finalized (or in-flight) audio recording stored as a managed
-- private file (PCM16 mono 16 kHz WAV). The audio bytes live on disk only; the
-- row holds metadata and the store-relative locator, never an absolute path and
-- never raw speech. `state` separates a committed, playable recording from one
-- that is still finalizing or failed, so interrupted work is never served as a
-- completed asset.
CREATE TABLE audio_recordings (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'finalizing'
    CHECK (state IN ('finalizing','ready','failed')),
  media_type TEXT NOT NULL,
  codec TEXT NOT NULL,
  sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
  channels INTEGER NOT NULL CHECK (channels > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT,
  -- Optional, user-facing label only; never a transcript or spoken words.
  label TEXT CHECK (label IS NULL OR length(label) <= 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_audio_recordings_recent
  ON audio_recordings(profile_id, created_at DESC);
CREATE INDEX idx_audio_recordings_state
  ON audio_recordings(state);
