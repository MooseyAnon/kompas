# ADR 006 — Several locations, levels and setups, plus contract and salary

Status: accepted (UI restyle, GND search filters)
Date: 2026-11-20

## Context

The GND search filters let people pick several locations, experience levels
and work setups, plus contract types and a minimum yearly salary. The frozen
`JobDiscoveryConfigurationV1` holds a single `location`, a free-text
`seniority` and (ADR 005) a single `workArrangement`. Zod and the SQL view
`job_discovery_invalid_configurations` reject unknown keys.

## Decision

- Add five optional keys to `intent`, additively. `schemaVersion` stays `1`.
  Every existing saved search and run snapshot stays valid unchanged.
  - `locations`: up to 5 distinct strings (case-insensitive), 1–200 chars.
  - `workArrangements`: distinct subset of `remote | hybrid | on_site`.
  - `experienceLevels`: distinct subset of
    `entry | junior | mid | senior | expert` (0–1, 1–3, 3–5, 5–10, 10+ years).
  - `contractTypes`: distinct subset of
    `full_time | part_time | contract | temporary | internship | apprenticeship`.
  - `salary`: `{ minimum: int 0–1,000,000 | null, currency: GBP | EUR | USD,
    onlyWithSalary: boolean }`, yearly.
- An absent or empty list means "any". When a list is present it replaces its
  single-value counterpart for planning. The UI keeps `location` equal to the
  first location and `workArrangement` equal to the single setup (or `any`),
  so older readers still show something sensible.
- Migration `024_search_preferences` (schema v26) recreates the shared SQL
  validator and its three triggers, allowing each key when present and
  checking its values. No rows are rewritten.
- Query planning pairs roles with locations round-robin, so the first queries
  cover every role and every place. Levels rotate across those queries as
  board terms (graduate, junior, senior, lead; mid-level adds nothing). A
  single remote or hybrid setup, or a single non-full-time contract type,
  adds its term. With several picked, no term is added, so none is excluded.
  Salary adds no query term.
- Filtering the found roles by setup, contract, level, location and salary
  happens in the renderer, on fields JD extraction already records. A role
  whose listing does not say passes, except `onlyWithSalary`, which hides
  roles that state no salary.

## Consequences

- No IPC action, envelope or major version changes; the command catalogue is
  unaffected.
- Salary parsing is best-effort (`£45k`, `£40,000–£50,000`, daily and hourly
  rates annualised); unparseable text passes rather than hiding a role.
- Tests: planner behaviour, Zod and SQL acceptance and rejection, and
  migration version expectations bumped to v26.
