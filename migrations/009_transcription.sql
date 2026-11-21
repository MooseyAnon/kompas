-- Career Workspace, shared audio domain speech-to-text (schema v5)
-- Forward-only, additive migration. Stage identifier is 008.2; this is the
-- FIFTH applied schema version (001_init=1, 005_interviews=2,
-- 007_interview_coaching=3, 008_audio=4). It never modifies earlier tables or
-- user data. All timestamps ISO-8601 UTC strings, all IDs UUIDv4. The migration
-- runner manages BEGIN/COMMIT and schema_migrations bookkeeping.

-- Durable transcription job: one attempt at transcribing a single finalized
-- audio recording with a given provider/model snapshot. A recording may have
-- many independent jobs (each retry is a new, attributable attempt). The row
-- carries only safe metadata: a provider id, engine/model snapshot, lifecycle
-- status, a safe failure code and an optional transcript id. It never stores a
-- filesystem path, command line, model stdout/stderr or recognised speech.
-- A `running`/`queued` job left behind by an unclean exit is reconciled to
-- `interrupted` (retryable) on startup; the original recording is untouched.
CREATE TABLE audio_transcription_jobs (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES audio_recordings(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  engine_version TEXT,
  model_id TEXT,
  locale TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  error_code TEXT,
  transcript_id TEXT REFERENCES audio_transcripts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_audio_stt_jobs_recording
  ON audio_transcription_jobs(recording_id, created_at DESC);
CREATE INDEX idx_audio_stt_jobs_status
  ON audio_transcription_jobs(status);

-- Immutable original engine transcript for a successful job attempt. The
-- `text` column is the raw recognised output (possibly empty when no speech was
-- detected, flagged by `is_empty`). This is the user's private speech content:
-- it lives only in this domain table and is returned only through an explicit
-- id-scoped read. It is NEVER written to telemetry or logs. There is no UPDATE
-- path: a transcript, once written, is never rewritten — a correction is a new
-- interview answer (008.3), not a mutation of the original.
CREATE TABLE audio_transcripts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES audio_transcription_jobs(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL REFERENCES audio_recordings(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  locale TEXT,
  text TEXT NOT NULL,
  is_empty INTEGER NOT NULL DEFAULT 0 CHECK (is_empty IN (0,1)),
  -- JSON array of {startMs,endMs,text} segments, or NULL when unavailable.
  segments_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audio_transcripts_recording
  ON audio_transcripts(recording_id, created_at DESC);
CREATE INDEX idx_audio_transcripts_job
  ON audio_transcripts(job_id);
