-- Fence work from an earlier process or a previous pause/abandon.
ALTER TABLE interview_sessions ADD COLUMN generation_epoch INTEGER NOT NULL DEFAULT 0;
