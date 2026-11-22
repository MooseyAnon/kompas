import { z } from 'zod';
import { pageReadResultSchema } from './web';
import { INFERENCE_LIMITS } from './inference';

export const JOB_DISCOVERY_MODULE_ID = 'jobDiscovery';
export const JOB_DISCOVERY_API_VERSION = 1;

/**
 * Application ceilings; SQL validates deadline structure, not its policy
 * maximum.
 */
export const JOB_DISCOVERY_LIMITS = Object.freeze({
  maxQueries: 4,
  maxNewCandidates: 10,
  maxInspectedCandidates: 100,
  maxCollectionPages: 5,
  maxTargetedSearchesPerCandidate: 2,
  maxPagesPerTargetedSearch: 5,
  maxConcurrentWebOperations: 2,
  maxConcurrentExtractions: 1,
  maxTransientRetries: 1,
  deadlineMs: 5_400_000,
});

const text = (max: number) => z.string().trim().min(1).max(max);

const bounded = (key: keyof typeof JOB_DISCOVERY_LIMITS, min = 1) =>
  z.number().int().min(min).max(JOB_DISCOVERY_LIMITS[key]);

/** Case-insensitive, so `Engineer` and `engineer` count as one role. */
const hasDistinctRoles = (roles: string[]) =>
  new Set(roles.map((role) => role.toLowerCase())).size === roles.length;

const hasDistinctValues = (values: string[]) =>
  new Set(values).size === values.length;

const intentSchema = z.strictObject({
  targetRoles: z
    .array(text(200))
    .min(1)
    .max(5)
    .refine(hasDistinctRoles, 'Target roles must be distinct.'),
  seniority: text(120).nullable(),
  field: text(200).nullable(),
  location: text(200).nullable(),
  targetYear: z.number().int().min(2000).max(2100).nullable(),
  companies: z.array(text(200)).max(10),
  keywords: z.array(text(200)).max(10),
});

const querySchema = z.strictObject({
  strategy: z.literal('deterministic_v1'),
  maxQueries: bounded('maxQueries'),
});

const sourcesSchema = z.strictObject({
  collectionProviders: z
    .array(z.enum(['linkedin', 'indeed']))
    .min(1)
    .max(2)
    .refine(hasDistinctValues, 'Providers must be distinct.'),
});

/** Budgets that may be zero disable that stage rather than being invalid. */
const runLimitsSchema = z.strictObject({
  maxNewCandidates: bounded('maxNewCandidates'),
  maxInspectedCandidates: bounded('maxInspectedCandidates'),
  maxCollectionPages: bounded('maxCollectionPages', 0),
  maxTargetedSearchesPerCandidate: bounded(
    'maxTargetedSearchesPerCandidate',
    0,
  ),
  maxPagesPerTargetedSearch: bounded('maxPagesPerTargetedSearch', 0),
  maxConcurrentWebOperations: bounded('maxConcurrentWebOperations'),
  maxConcurrentExtractions: bounded('maxConcurrentExtractions'),
  maxTransientRetries: bounded('maxTransientRetries', 0),
  deadlineMs: bounded('deadlineMs'),
});

export const jobDiscoveryConfigurationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  name: text(120),
  active: z.boolean(),
  intent: intentSchema,
  query: querySchema,
  sources: sourcesSchema,
  run: runLimitsSchema,
});
export type JobDiscoveryConfigurationV1 = z.infer<
  typeof jobDiscoveryConfigurationV1Schema
>;

/**
 * Materialize all defaults once, before create; no implied runtime overrides.
 */
export function newJobDiscoveryConfiguration(): JobDiscoveryConfigurationV1 {
  const { maxQueries, ...run } = JOB_DISCOVERY_LIMITS;
  return {
    schemaVersion: 1,
    name: '',
    active: true,
    intent: {
      targetRoles: [],
      seniority: null,
      field: null,
      location: null,
      targetYear: null,
      companies: [],
      keywords: [],
    },
    query: { strategy: 'deterministic_v1', maxQueries },
    sources: { collectionProviders: ['linkedin', 'indeed'] },
    run,
  };
}

export const savedSearchSchema = z.strictObject({
  id: z.uuid(),
  config: jobDiscoveryConfigurationV1Schema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedSearch = z.infer<typeof savedSearchSchema>;

export const savedSearchIdInput = z.strictObject({ id: z.uuid() });

export const savedSearchCreateInput = z.strictObject({
  config: jobDiscoveryConfigurationV1Schema,
});

export const savedSearchUpdateInput = savedSearchCreateInput.extend({
  id: z.uuid(),
});

export const savedSearchActiveInput = savedSearchIdInput.extend({
  active: z.boolean(),
});

export const savedSearchListInput = z.strictObject({
  limit: z.number().int().min(1).max(50).default(50),
  cursor: z.uuid().optional(),
});
export type SavedSearchListInput = z.input<typeof savedSearchListInput>;

export const savedSearchOutput = z.strictObject({ item: savedSearchSchema });

export const savedSearchListOutput = z.strictObject({
  items: z.array(savedSearchSchema).max(50),
  nextCursor: z.uuid().nullable(),
});
export type SavedSearchPage = z.infer<typeof savedSearchListOutput>;

/**
 * A plan is derived from a saved configuration; it is never editable settings.
 */
export const discoveryQueryPlanSchema = z
  .array(z.string().min(1).max(256))
  .min(1)
  .max(JOB_DISCOVERY_LIMITS.maxQueries);

export const discoveryRunStatsSchema = z.strictObject({
  queriesPlanned: z.number().int().min(1).max(JOB_DISCOVERY_LIMITS.maxQueries),
  collectionPagesRead: z.number().int().nonnegative(),
  inspectedCandidates: z.number().int().nonnegative(),
  newCandidates: z.number().int().nonnegative(),
  targetedSearches: z.number().int().nonnegative(),
  targetedPagesRead: z.number().int().nonnegative(),
  extractions: z.number().int().nonnegative(),
  transientRetries: z.number().int().nonnegative(),
});
export type DiscoveryRunStats = z.infer<typeof discoveryRunStatsSchema>;

export const discoveryRunDiagnosticSchema = z.strictObject({
  code: z.enum([
    'INTERRUPTED_ON_RESTART',
    'CANCELLED_BY_USER',
    'WEB_RATE_LIMITED',
    'WEB_CHALLENGE',
    'WEB_UNAVAILABLE',
    'WEB_FAILED',
    'PAGE_BLOCKED',
    'DEADLINE_REACHED',
    'EXECUTION_FAILED',
    'POSSIBLE_DUPLICATE',
  ]),
  at: z.iso.datetime(),
});

export const discoveryRunSummarySchema = z.strictObject({
  id: z.uuid(),
  savedSearchId: z.uuid().nullable(),
  status: z.enum([
    'running',
    'completed',
    'partial',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  stats: discoveryRunStatsSchema,
  diagnostics: z.array(discoveryRunDiagnosticSchema),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type DiscoveryRunSummary = z.infer<typeof discoveryRunSummarySchema>;

export const discoveryRunSchema = discoveryRunSummarySchema.extend({
  configSnapshot: jobDiscoveryConfigurationV1Schema,
  queryPlan: discoveryQueryPlanSchema,
});
export type DiscoveryRun = z.infer<typeof discoveryRunSchema>;

export const discoveryRunStartInput = z.strictObject({
  savedSearchId: z.uuid(),
});

export const discoveryRunIdInput = z.strictObject({ id: z.uuid() });

export const discoveryRunListInput = savedSearchListInput;

export const discoveryRunOutput = z.strictObject({ item: discoveryRunSchema });

export const discoveryWorkflowExecuteOutput = z.strictObject({
  accepted: z.literal(true),
});

export const discoverySearchProgressSchema = z.strictObject({
  operationActive: z.boolean(),
  queueLength: z.number().int().nonnegative(),
  position: z.number().int().positive().nullable(),
  state: z.enum(['idle', 'waiting', 'running']),
  waitingMs: z.number().int().nonnegative(),
  nextEligibleAt: z.iso.datetime().nullable(),
});
export type DiscoverySearchProgress = z.infer<
  typeof discoverySearchProgressSchema
>;

export const discoverySearchProgressOutput = z.strictObject({
  progress: discoverySearchProgressSchema,
});

const workflowStepSchema = z.strictObject({
  status: z.enum([
    'pending',
    'active',
    'succeeded',
    'failed',
    'skipped',
    'interrupted',
  ]),
  reason: z.string().max(100).nullable(),
  retryAvailable: z.boolean(),
});

const workflowDiscoveryProgressSchema = z.strictObject({
  planned: z.number().int().min(1).max(JOB_DISCOVERY_LIMITS.maxQueries),
  submitted: z.number().int().nonnegative().nullable(),
  settled: z.number().int().nonnegative().nullable(),
  search: discoverySearchProgressSchema,
});

const workflowActiveStepSchema = z.strictObject({
  sourceId: z.uuid(),
  step: z.enum(['resolution', 'extraction', 'matching']),
});

const workflowCountsSchema = z.strictObject({
  admitted: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  jdReady: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

const workflowMilestonesSchema = z.strictObject({
  firstAdmittedAt: z.iso.datetime().nullable(),
  firstVerifiedAt: z.iso.datetime().nullable(),
  firstJdReadyAt: z.iso.datetime().nullable(),
  firstMatchedAt: z.iso.datetime().nullable(),
});

/** Per-candidate progress through resolution, extraction and matching. */
const workflowCandidateSchema = z.strictObject({
  opportunityId: z.uuid(),
  sourceId: z.uuid(),
  provider: z.string().max(64),
  title: z.string().max(400),
  resolution: workflowStepSchema.extend({
    attempts: z.number().int().min(0).max(2),
  }),
  extraction: workflowStepSchema.extend({
    omittedFields: z.array(z.string().max(100)).max(50),
  }),
  match: workflowStepSchema.extend({
    freshness: z.enum(['stale_extraction', 'unknown_skills']).nullable(),
    computedAt: z.iso.datetime().nullable(),
  }),
});

export const discoveryWorkflowStateSchema = z.strictObject({
  id: z.uuid(),
  status: discoveryRunSummarySchema.shape.status,
  workActive: z.boolean(),
  discovery: workflowDiscoveryProgressSchema,
  activeSteps: z.array(workflowActiveStepSchema).max(10),
  counts: workflowCountsSchema,
  milestones: workflowMilestonesSchema,
  diagnostics: z.array(discoveryRunDiagnosticSchema).max(20),
  candidates: z
    .array(workflowCandidateSchema)
    .max(JOB_DISCOVERY_LIMITS.maxNewCandidates),
});
export type DiscoveryWorkflowState = z.infer<
  typeof discoveryWorkflowStateSchema
>;

export const discoveryWorkflowStateOutput = z.strictObject({
  state: discoveryWorkflowStateSchema,
});

export const discoveryRunListOutput = z.strictObject({
  items: z.array(discoveryRunSummarySchema).max(50),
  nextCursor: z.uuid().nullable(),
});
export type DiscoveryRunPage = z.infer<typeof discoveryRunListOutput>;

export const discoveryPlanOutput = z.strictObject({
  queries: discoveryQueryPlanSchema,
});

export const discoveryCandidateSchema = z.strictObject({
  id: z.uuid(),
  sourceId: z.uuid(),
  provider: z.string().min(1).max(64),
  sourceKey: z.string().min(1).max(2048),
  discoveredUrl: z.url(),
  collectionUrl: z.url().nullable(),
  title: z.string().min(1).max(400),
  company: z.string().max(200).nullable(),
  location: z.string().max(200).nullable(),
  postingAge: z.string().max(100).nullable(),
  canonicalUrl: z.url().nullable(),
  resolutionStatus: z.enum([
    'discovered',
    'unresolved',
    'resolved',
    'extraction_failed',
    'extracted',
  ]),
  resolutionReason: z
    .enum([
      'verified',
      'missing_company',
      'query_too_long',
      'no_match',
      'identity_mismatch',
      'not_job_description',
      'page_unavailable',
      'capture_too_large',
      'page_truncated',
      'deadline_reached',
      'cancelled',
    ])
    .nullable(),
  resolutionAttempts: z.number().int().min(0).max(2),
  retryAvailable: z.boolean(),
});
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;

export const discoverySourceInput = discoveryRunIdInput.extend({
  sourceId: z.uuid(),
});

/** Resolution attempts and targeted searches per attempt (both capped at 2). */
const MAX_RESOLUTION_ATTEMPTS = 2;
const MAX_TARGETED_SEARCH_RESULTS = 20;

const resolutionSearchResultSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(MAX_TARGETED_SEARCH_RESULTS),
  url: z.string().min(1).max(2048),
  disposition: z.enum([
    'seen',
    'reading',
    'not_opened',
    'read_failed',
    'rejected',
    'accepted',
    'interrupted',
  ]),
  reason: z.string().max(64).nullable(),
  captureId: z.uuid().nullable(),
});

const resolutionSearchSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(MAX_RESOLUTION_ATTEMPTS),
  query: z.string().min(1).max(256),
  status: z.enum([
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  errorCode: z.string().max(64).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  results: z
    .array(resolutionSearchResultSchema)
    .max(MAX_TARGETED_SEARCH_RESULTS),
});

const resolutionAttemptSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  sourceId: z.uuid(),
  provider: z.string().min(1).max(64),
  discoveredUrl: z.url(),
  sequence: z.number().int().min(1).max(MAX_RESOLUTION_ATTEMPTS),
  status: z.enum(['running', 'completed', 'cancelled', 'interrupted']),
  reason: z.union([
    discoveryCandidateSchema.shape.resolutionReason,
    z.literal('search_budget_zero'),
  ]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  searches: z.array(resolutionSearchSchema).max(MAX_RESOLUTION_ATTEMPTS),
});

const resolutionSourceSchema = z.strictObject({
  opportunityId: z.uuid(),
  sourceId: z.uuid(),
  provider: z.string().min(1).max(64),
  discoveredUrl: z.url(),
});

/**
 * Only resolver-owned, actually observed work; older attempts may have no rows.
 */
export const resolutionDiagnosticsOutput = z.strictObject({
  source: resolutionSourceSchema,
  attempts: z.array(resolutionAttemptSchema).max(MAX_RESOLUTION_ATTEMPTS),
  /**
   * Opportunity-scoped attempt count can include older runs without history.
   */
  totalAttempts: z.number().int().min(0).max(MAX_RESOLUTION_ATTEMPTS),
});
export type ResolutionDiagnostics = z.infer<typeof resolutionDiagnosticsOutput>;

export const discoveryCandidateOutput = z.strictObject({
  item: discoveryCandidateSchema,
});

export const discoveryCaptureSchema = z.strictObject({
  id: z.uuid(),
  sourceUrl: z.url(),
  rawReadPage: pageReadResultSchema,
  capturedAt: z.iso.datetime(),
});
export type DiscoveryCapture = z.infer<typeof discoveryCaptureSchema>;

export const discoveryCapturesOutput = z.strictObject({
  items: z.array(discoveryCaptureSchema).max(12),
});

export const discoveryCandidatesOutput = z.strictObject({
  items: z
    .array(discoveryCandidateSchema)
    .max(JOB_DISCOVERY_LIMITS.maxNewCandidates),
});

const groundedField = z.strictObject({
  text: z.string().max(1500),
  evidence: z.string().max(1500),
});

const inferenceField = z.strictObject({
  value: z.string().max(300),
  evidence: z.string().max(700),
  reason: z.string().max(700),
});

/**
 * Derived, evidence-checked interpretation; never replaces the raw ReadPage.
 */
export const extractedJdSchema = z.strictObject({
  schemaVersion: z.literal(1),
  classification: z.literal('job_description'),
  title: groundedField.nullable(),
  company: groundedField.nullable(),
  location: groundedField.nullable(),
  responsibilities: z.array(groundedField).max(40),
  requiredSkills: z.array(groundedField).max(50),
  preferredSkills: z.array(groundedField).max(50),
  educationRequirements: z.array(groundedField).max(20),
  minimumYearsExperience: z
    .strictObject({
      value: z.number().int().min(0).max(60),
      evidence: z.string().max(500),
    })
    .nullable(),
  seniority: inferenceField.nullable(),
  estimatedExperienceBand: inferenceField.nullable(),
  employmentType: groundedField.nullable(),
  workArrangement: groundedField.nullable(),
  salaryText: groundedField.nullable(),
  inferences: z
    .array(
      z.strictObject({ field: z.string().max(120), ...inferenceField.shape }),
    )
    .max(20),
});
export type ExtractedJd = z.infer<typeof extractedJdSchema>;

export const jdExtractionSchema = z.strictObject({
  id: z.uuid(),
  captureId: z.uuid(),
  status: z.enum(['running', 'extracted', 'failed']),
  errorCode: z
    .enum([
      'INVALID_SCHEMA',
      'MODEL_UNAVAILABLE',
      'MODEL_FAILED',
      'RESOURCE_LIMIT',
      'DEADLINE_REACHED',
      'CANCELLED',
      'NOT_JOB_DESCRIPTION',
      'INTERRUPTED',
    ])
    .nullable(),
  jd: extractedJdSchema.nullable(),
  diagnostics: z.array(z.string().max(100)).max(50),
  provenance: z
    .strictObject({
      providerId: z.string().max(64),
      modelId: z.string().max(128),
      requestId: z.uuid(),
      thinking: z.literal(false),
      configurationVersion: z.literal(1),
      promptVersion: z.enum(['jd-extract-v1', 'jd-extract-v2']),
      timeoutMs: z.number().int().min(100).max(INFERENCE_LIMITS.maxTimeoutMs),
    })
    .nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type JdExtraction = z.infer<typeof jdExtractionSchema>;

export const jdExtractionsOutput = z.strictObject({
  items: z.array(jdExtractionSchema).max(20),
});

const alignmentSchema = z.enum(['match', 'different', 'unknown']);

/** A versioned, display-only score over evidence-backed required skills. */
export const discoveryMatchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  opportunityId: z.uuid(),
  extractionId: z.uuid().nullable(),
  status: z.enum(['scored', 'unscored']),
  reason: z.enum([
    'COVERAGE',
    'NO_REQUIRED_SKILLS',
    'NO_CONFIRMED_SKILLS',
    'PROFILE_UNAVAILABLE',
    'NO_EXTRACTION',
  ]),
  coverage: z.number().min(0).max(1).nullable(),
  matched: z.array(z.string().max(1500)).max(50),
  unmatched: z.array(z.string().max(1500)).max(50),
  requiredCount: z.number().int().min(0).max(50),
  scorerVersion: z.literal('required-skills-v1'),
  profileSkillFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  explicitMinimumYears: z.number().int().min(0).max(60).nullable(),
  alignment: z.strictObject({
    location: alignmentSchema,
    years: alignmentSchema,
    seniority: alignmentSchema,
  }),
  computedAt: z.iso.datetime(),
});
export type DiscoveryMatch = z.infer<typeof discoveryMatchSchema>;

export const discoveryMatchesOutput = z.strictObject({
  items: z
    .array(discoveryMatchSchema)
    .max(JOB_DISCOVERY_LIMITS.maxNewCandidates),
});

export const discoveryReviewSchema = z.strictObject({
  opportunityId: z.uuid(),
  sourceId: z.uuid(),
  decision: z.enum(['new', 'saved', 'dismissed', 'applied']),
  applicationId: z.uuid().nullable(),
  applicationSnapshotCaptured: z.boolean(),
  snapshot: z.enum(['available', 'no_verified_jd', 'incomplete', 'too_large']),
});
export type DiscoveryReview = z.infer<typeof discoveryReviewSchema>;

export const discoveryReviewsOutput = z.strictObject({
  items: z.array(discoveryReviewSchema).max(10),
});

export const discoveryReviewOutput = z.strictObject({
  item: discoveryReviewSchema,
});

export const discoveryDecideInput = discoverySourceInput.extend({
  decision: z.enum(['saved', 'dismissed', 'new']),
});

export const discoveryTrackInput = discoverySourceInput.extend({
  confirmUnverified: z.boolean(),
  withoutSnapshot: z.boolean(),
});

/**
 * Review spans all known opportunities, including non-admitted observations.
 */
export const opportunityListInput = z.strictObject({
  decision: z.enum(['new', 'saved', 'dismissed', 'all']).default('new'),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
});

export const opportunityIdInput = z.strictObject({ opportunityId: z.uuid() });

export const opportunityDecideInput = opportunityIdInput.extend({
  decision: z.enum(['new', 'saved', 'dismissed']),
});

export const opportunityApplyInput = opportunityIdInput.extend({
  confirmUnverified: z.boolean(),
  withoutSnapshot: z.boolean(),
  allowDuplicate: z.boolean(),
});

export const opportunityApplyPreviewOutput = z.strictObject({
  applicationId: z.uuid().nullable(),
  unverified: z.boolean(),
  snapshot: discoveryReviewSchema.shape.snapshot,
  manualMatchId: z.uuid().nullable(),
  dismissed: z.boolean(),
});
export type OpportunityApplyPreview = z.infer<
  typeof opportunityApplyPreviewOutput
>;

export const opportunityApplyOutput = z.strictObject({
  applicationId: z.uuid(),
});

export const opportunitySourceSchema = z.strictObject({
  id: z.uuid(),
  provider: z.string().min(1).max(64),
  discoveredUrl: z.url(),
  collectionUrl: z.url().nullable(),
  postingAge: z.string().max(100).nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});

export const opportunitySummarySchema = z.strictObject({
  opportunityId: z.uuid(),
  title: z.string().min(1).max(400),
  company: z.string().max(200).nullable(),
  location: z.string().max(200).nullable(),
  latestSource: opportunitySourceSchema.nullable(),
  decision: discoveryReviewSchema.shape.decision,
  applicationId: z.uuid().nullable(),
  verified: z.boolean(),
  extractionStatus: z.enum([
    'no_verified_capture',
    'missing',
    'running',
    'failed',
    'ready',
  ]),
  matchStatus: z.enum(['missing', 'scored', 'unscored', 'stale_extraction']),
  coverage: z.number().min(0).max(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type OpportunitySummary = z.infer<typeof opportunitySummarySchema>;

export const opportunityListOutput = z.strictObject({
  items: z.array(opportunitySummarySchema).max(50),
  nextCursor: z.string().max(512).nullable(),
});

export const opportunityDetailSchema = opportunitySummarySchema.extend({
  sources: z.array(opportunitySourceSchema).max(50),
  sourcesTruncated: z.boolean(),
  canonicalUrl: z.url().nullable(),
  verifiedCaptureId: z.uuid().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  postingText: z.string().max(32768).nullable(),
  postingTextTruncated: z.boolean(),
  extraction: jdExtractionSchema.nullable(),
  match: discoveryMatchSchema.nullable(),
  skillFreshness: z.enum(['unknown', 'stale_extraction']).nullable(),
});
export type OpportunityDetail = z.infer<typeof opportunityDetailSchema>;

export const opportunityDetailOutput = z.strictObject({
  item: opportunityDetailSchema,
});

export const opportunityDecideOutput = z.strictObject({
  item: opportunitySummarySchema,
});
