-- Career Workspace, interview voice answers (schema v6)
-- Forward-only, additive migration. Stage identifier is 008.3; this is the
-- SIXTH applied schema version (001_init=1, 005_interviews=2,
-- 007_interview_coaching=3, 008_audio=4, 009_transcription=5). It never modifies
-- earlier tables or user data. All timestamps ISO-8601 UTC strings, all IDs
-- UUIDv4. The migration runner manages BEGIN/COMMIT and schema_migrations.
--
-- These two interview-owned relations correlate the shared Audio domain's
-- recordings/transcripts to an interview question without the Audio module ever
-- depending on Interviews (the FK direction is Interviews -> Audio). Interviews
-- never reads a filesystem path through these tables; it addresses audio by
-- opaque recording/transcript id only and validates ownership via the Audio
-- façade before linking.

-- Crash-safe pending voice draft for a single (session, question). Holds the
-- retained recording id (if the user recorded before submitting) and the last
-- edited answer text the user is composing. It survives an app/window restart
-- so a half-finished voice answer can be recovered and completed after resume.
-- One draft per question (PK). The draft is NOT the committed answer: the
-- immutable answer is only written by the existing answers.submit path. A draft
-- is cleared on submit or explicit discard; the underlying recording persists
-- independently (ON DELETE SET NULL) and is never deleted by draft cleanup.
CREATE TABLE interview_answer_drafts (
  session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,
  recording_id TEXT REFERENCES audio_recordings(id) ON DELETE SET NULL,
  -- The user's editable answer-in-progress. Bounded to the answer text cap.
  -- This is private user content; it is never written to telemetry or logs.
  draft_text TEXT CHECK (draft_text IS NULL OR length(draft_text) <= 8000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, question_id)
);
CREATE INDEX idx_interview_answer_drafts_session
  ON interview_answer_drafts(session_id);

-- Immutable association between one committed interview answer and the audio
-- recording (and optional original transcript) it was spoken from. Written
-- transactionally with the answer in the existing submit path. `answer_id` is
-- UNIQUE, so an answer can carry at most one audio link and a retried/double
-- submit cannot fork the association. Deleting the interview cascades this link
-- away but NEVER deletes the retained recording in `audio_recordings`
-- (retention of recorded answers is deliberate; a retention policy is future
-- work). There is no UPDATE path: a committed answer's audio link is fixed.
CREATE TABLE interview_answer_audio (
  id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL UNIQUE REFERENCES interview_answers(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL REFERENCES audio_recordings(id),
  transcript_id TEXT REFERENCES audio_transcripts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_interview_answer_audio_recording
  ON interview_answer_audio(recording_id);
CREATE INDEX idx_interview_answer_audio_session
  ON interview_answer_audio(session_id, question_id);
