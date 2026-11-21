import initSql from '../../../../migrations/001_init.sql?raw';
import interviewsSql from '../../../../migrations/005_interviews.sql?raw';
import interviewCoachingSql from '../../../../migrations/007_interview_coaching.sql?raw';
import audioSql from '../../../../migrations/008_audio.sql?raw';
import transcriptionSql from '../../../../migrations/009_transcription.sql?raw';
import interviewVoiceSql from '../../../../migrations/010_interview_voice.sql?raw';
import cvImportsSql from '../../../../migrations/011_cv_imports.sql?raw';
import profileImportSql from '../../../../migrations/012_profile_import_apply.sql?raw';
import applicationsSql from '../../../../migrations/012_applications.sql?raw';
import jobDiscoverySql from '../../../../migrations/013_job_discovery.sql?raw';
import identityDedupeSql from '../../../../migrations/013_identity_dedupe.sql?raw';
import canonicalResolutionSql from '../../../../migrations/013_canonical_resolution.sql?raw';
import jdExtractionSql from '../../../../migrations/013_jd_extraction.sql?raw';
import skillMatchingSql from '../../../../migrations/013_skill_matching.sql?raw';
import reviewHandoffSql from '../../../../migrations/013_review_handoff.sql?raw';
import searchRateLimitSql from '../../../../migrations/014_search_rate_limit.sql?raw';
import interviewPublicationsSql from '../../../../migrations/015_interview_publications.sql?raw';
import interviewRecoverySql from '../../../../migrations/016_interview_recovery.sql?raw';
import interviewGuidanceSql from '../../../../migrations/017_interview_guidance.sql?raw';
import discoveryReadmissionSql from '../../../../migrations/018_discovery_readmission.sql?raw';
import resolutionDiagnosticsSql from '../../../../migrations/019_resolution_diagnostics.sql?raw';
import onboardingSql from '../../../../migrations/020_onboarding.sql?raw';
import experienceDatePrecisionSql from '../../../../migrations/021_experience_date_precision.sql?raw';
import targetedPageLimitSql from '../../../../migrations/022_targeted_page_limit.sql?raw';

/** A single forward-only schema migration. */
export interface Migration {
  version: number;

  name: string;

  sql: string;
}

const foundationMigrations: Migration[] = [
  { version: 1, name: '001_init', sql: initSql },
  { version: 2, name: '005_interviews', sql: interviewsSql },
  { version: 3, name: '007_interview_coaching', sql: interviewCoachingSql },
  { version: 4, name: '008_audio', sql: audioSql },
  { version: 5, name: '009_transcription', sql: transcriptionSql },
  { version: 6, name: '010_interview_voice', sql: interviewVoiceSql },
  { version: 7, name: '011_cv_imports', sql: cvImportsSql },
  { version: 8, name: '012_profile_import_apply', sql: profileImportSql },
  { version: 9, name: '012_applications', sql: applicationsSql },
];

const discoveryMigrations: Migration[] = [
  { version: 10, name: '013_job_discovery', sql: jobDiscoverySql },
  { version: 11, name: '013_identity_dedupe', sql: identityDedupeSql },
  {
    version: 12,
    name: '013_canonical_resolution',
    sql: canonicalResolutionSql,
  },
  { version: 13, name: '013_jd_extraction', sql: jdExtractionSql },
  { version: 14, name: '013_skill_matching', sql: skillMatchingSql },
  { version: 15, name: '013_review_handoff', sql: reviewHandoffSql },
  { version: 16, name: '014_search_rate_limit', sql: searchRateLimitSql },
];

const interviewLifecycleMigrations: Migration[] = [
  {
    version: 17,
    name: '015_interview_publications',
    sql: interviewPublicationsSql,
  },
  { version: 18, name: '016_interview_recovery', sql: interviewRecoverySql },
  { version: 19, name: '017_interview_guidance', sql: interviewGuidanceSql },
];

const refinementMigrations: Migration[] = [
  {
    version: 20,
    name: '018_discovery_readmission',
    sql: discoveryReadmissionSql,
  },
  {
    version: 21,
    name: '019_resolution_diagnostics',
    sql: resolutionDiagnosticsSql,
  },
  { version: 22, name: '020_onboarding', sql: onboardingSql },
  {
    version: 23,
    name: '021_experience_date_precision',
    sql: experienceDatePrecisionSql,
  },
  { version: 24, name: '022_targeted_page_limit', sql: targetedPageLimitSql },
];

/**
 * Ordered list of migrations. Each SQL file is embedded verbatim at build time
 * so the same authoritative DDL runs in development, tests and the packaged app
 * (where it lives in ASAR).
 *
 * The migration `version` is the SQLite schema version, which is independent of
 * the product stage number. Stage 005 ships the interviews domain as schema
 * version **2** — the file is named `005_interviews.sql` for stage traceability
 * while remaining the second applied migration. Stage 007.2 adds the owned
 * `interview_coaching` table as schema version **3** (`007_interview_coaching.sql`).
 * Stage 008.1 adds the shared Audio domain's `audio_recordings` table as schema
 * version **4** (`008_audio.sql`). Stage 008.2 adds the Audio domain's
 * speech-to-text tables `audio_transcription_jobs` and `audio_transcripts` as
 * schema version **5** (`009_transcription.sql`). Stage 008.3 adds the
 * interview-owned voice correlation tables `interview_answer_drafts` and
 * `interview_answer_audio` as schema version **6** (`010_interview_voice.sql`).
 */
export const MIGRATIONS: Migration[] = [
  ...foundationMigrations,
  ...discoveryMigrations,
  ...interviewLifecycleMigrations,
  ...refinementMigrations,
];
