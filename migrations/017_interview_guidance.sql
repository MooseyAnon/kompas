-- Optional user-authored question-generation guidance (stage 07.0).
-- Existing sessions keep NULL ("no guidance"); the bound matches the IPC contract.
ALTER TABLE interview_sessions ADD COLUMN additional_guidance TEXT
  CHECK (
    additional_guidance IS NULL
    OR length(additional_guidance) BETWEEN 1 AND 2000
  );
