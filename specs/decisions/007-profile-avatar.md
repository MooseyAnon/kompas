# ADR 007 — Profile picture: a sprout mascot or a small photo

Status: accepted (UI restyle, GND profile)
Date: 2026-11-20

## Context

The GND profile card shows a picture. Everyone starts with one of eight
hand-drawn sprout mascots, picked at random, and can swap it for another
mascot or a photo of their own. The profile had no field for a picture.

## Decision

- Add an optional `avatar` to `Profile` and to `profile.update`'s patch:
  either `mascot:<name>` for one of the eight bundled mascots (`sprout`,
  `flop`, `wriggle`, `peek`, `nose`, `strut`, `twins`, `blob`), or a PNG,
  JPEG or WebP data URL of at most 200,000 characters. `null` clears it.
- Migration `025_profile_avatar` (schema v27) adds a nullable `avatar`
  column to `profiles` with a CHECK of the same rules. Existing profiles get
  `NULL`; no rows are rewritten.
- The renderer resizes a chosen photo to 256px (JPEG) before saving, so it
  fits comfortably. A profile with no picture is given a random mascot the
  first time its card is shown, and that choice is saved.
- Photos stay in the local database like every other profile field; nothing
  is uploaded anywhere.

## Consequences

- No new IPC actions; `profile.get` and `profile.update` gain one optional
  field, so older fixtures without it remain valid.
- The profile audit log records the picture like other fields, so a photo
  adds up to ~200 KB per change to it.
- Tests: Zod and SQL acceptance and rejection, migration versions bumped to
  v27.
