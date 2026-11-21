-- Preserve existing experiences while allowing known year/month precision.
CREATE TABLE experiences_with_precision (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('employment','education','project','other')),
  organisation TEXT,
  role_title TEXT NOT NULL CHECK (length(trim(role_title)) > 0),
  start_date TEXT,
  end_date TEXT,
  description TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'user_confirmed'
    CHECK (verification_status IN ('user_confirmed','unconfirmed')),
  source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_date IS NULL OR (
    (length(start_date) = 4 AND start_date GLOB '[0-9][0-9][0-9][0-9]' AND start_date >= '0001') OR
    (length(start_date) = 7 AND start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND substr(start_date, 1, 4) >= '0001' AND substr(start_date, 6, 2) BETWEEN '01' AND '12') OR
    (length(start_date) = 10 AND start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND coalesce(date(start_date, '+0 days') = start_date, 0))
  )),
  CHECK (end_date IS NULL OR (
    (length(end_date) = 4 AND end_date GLOB '[0-9][0-9][0-9][0-9]' AND end_date >= '0001') OR
    (length(end_date) = 7 AND end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND substr(end_date, 1, 4) >= '0001' AND substr(end_date, 6, 2) BETWEEN '01' AND '12') OR
    (length(end_date) = 10 AND end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND coalesce(date(end_date, '+0 days') = end_date, 0))
  )),
  CHECK (start_date IS NULL OR end_date IS NULL OR
    (CASE length(end_date)
      WHEN 4 THEN end_date || '-12-31'
      WHEN 7 THEN date(end_date || '-01', '+1 month', '-1 day')
      ELSE end_date
    END) >= (CASE length(start_date)
      WHEN 4 THEN start_date || '-01-01'
      WHEN 7 THEN start_date || '-01'
      ELSE start_date
    END)
  )
);

INSERT INTO experiences_with_precision
  (id, profile_id, category, organisation, role_title, start_date, end_date,
   description, verification_status, source_document_id, created_at, updated_at)
SELECT id, profile_id, category, organisation, role_title, start_date, end_date,
       description, verification_status, source_document_id, created_at, updated_at
FROM experiences;
DROP TABLE experiences;
ALTER TABLE experiences_with_precision RENAME TO experiences;
CREATE INDEX idx_experiences_profile ON experiences(profile_id, category);
