-- ADR 007: an optional profile picture, either one of the bundled sprout
-- mascots ('mascot:<name>') or a small photo stored as a data URL. Existing
-- profiles get NULL; the app picks a mascot for them on first view.
ALTER TABLE profiles ADD COLUMN avatar TEXT
  CHECK (avatar IS NULL OR (length(avatar) <= 200000 AND (
    avatar IN ('mascot:sprout', 'mascot:flop', 'mascot:wriggle', 'mascot:peek',
      'mascot:nose', 'mascot:strut', 'mascot:twins', 'mascot:blob')
    OR avatar GLOB 'data:image/png;base64,*'
    OR avatar GLOB 'data:image/jpeg;base64,*'
    OR avatar GLOB 'data:image/webp;base64,*')));
