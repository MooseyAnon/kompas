# ADR 005 — Optional work arrangement on saved searches

Status: accepted (UI restyle, GND onboarding)
Date: 2026-11-19

## Context

The GND onboarding asks for a work arrangement (open to all, remote, hybrid,
on-site) alongside location. The frozen `JobDiscoveryConfigurationV1`
(013 configuration contract) has no field for it, and both Zod and the SQL
view `job_discovery_invalid_configurations` reject unknown keys.

## Decision

- Add an optional `intent.workArrangement` of
  `'any' | 'remote' | 'hybrid' | 'on_site'` to `JobDiscoveryConfigurationV1`.
  Absent means `'any'`. `schemaVersion` stays `1`: the change is additive and
  every existing saved search and run snapshot remains valid unchanged.
- `newJobDiscoveryConfiguration()` does not add the key, so default
  configurations keep their original shape.
- Migration `021_work_arrangement` (schema v23) recreates the shared SQL
  validator and its three triggers, allowing the key when present and
  restricting it to the four values. No rows are rewritten.
- Query planning appends `remote` or `hybrid` as an optional phrase, under the
  same length rules as seniority and field. `on_site` and `any` add nothing,
  because most listings are on-site by default.

## Consequences

- No IPC action, envelope or major version changes; the command catalogue
  snapshot is unaffected.
- Matching does not yet compare the preference with a job's extracted
  `workArrangement` (JD extraction already records it); that can follow.
- Tests: planner behaviour, Zod rejection, SQL acceptance and rejection,
  and migration version expectations bumped to v23.
