import { z } from 'zod';

export const CV_IMPORTS_MODULE_ID = 'cvImports';
export const CV_IMPORTS_API_VERSION = 1;

const id = z.string().uuid();
const nonNegativeInt = z.number().int().nonnegative();

const CV_EVIDENCE_MAX = 500;
const CV_EXPERIENCES_MAX = 40;
const CV_LIST_MAX = 50;

const cvCandidateOriginSchema = z.enum(['deterministic', 'llm']);

/** A weaker model-proposed value surfaced alongside the primary candidate. */
const cvCandidateAlternativeSchema = z.object({
  value: z.string().max(200),
  evidence: z.string().max(CV_EVIDENCE_MAX),
  origin: z.literal('llm'),
});

export const cvCandidateSchema = z.object({
  value: z.string().max(1000).nullable(),
  status: z.enum(['detected', 'ambiguous', 'missing', 'needs_review']),
  origin: cvCandidateOriginSchema.nullable(),
  evidence: z.string().max(CV_EVIDENCE_MAX).nullable(),
  blockIndex: nonNegativeInt.nullable(),
  reasons: z.array(z.string().max(60)).max(8),
  alternative: cvCandidateAlternativeSchema.optional(),
});
export type CvCandidate = z.infer<typeof cvCandidateSchema>;

export const cvExperienceSchema = z.object({
  category: z.enum(['employment', 'education', 'project', 'other']),
  roleTitle: cvCandidateSchema,
  organisation: cvCandidateSchema,
  startDate: cvCandidateSchema,
  endDate: cvCandidateSchema,
  description: cvCandidateSchema,
});

const cvProjectDetailSchema = z.object({
  description: z.array(z.string().max(2000)).max(40),
  technologies: z.array(z.string().max(200)).max(60),
});

/** A model inference for a field the CV does not state directly. */
const cvFieldInferenceSchema = z.object({
  field: z.enum(['currentRole', 'currentStage']),
  value: z.string().max(300),
  reason: z.string().max(800),
  evidence: z.string().max(700),
});

/** Raw per-section text kept privately for review; not canonical data. */
const cvDraftDetailsSchema = z.object({
  work: z.array(z.array(z.string().max(2000)).max(60)).max(CV_EXPERIENCES_MAX),
  education: z
    .array(z.array(z.string().max(700)).max(30))
    .max(CV_EXPERIENCES_MAX),
  projects: z.array(cvProjectDetailSchema).max(CV_EXPERIENCES_MAX),
  skills: z.array(z.array(z.string().max(1000)).max(20)).max(50),
  inferences: z.array(cvFieldInferenceSchema).max(20),
});

const cvModelProvenanceSchema = z.object({
  providerId: z.string().max(64),
  modelId: z.string().max(128),
  requestId: z.string().uuid(),
  completedAt: z.string(),
  schemaVersion: z.literal(1),
});

const cvDraftProfileSchema = z.object({
  displayName: cvCandidateSchema,
  currentRole: cvCandidateSchema,
  location: cvCandidateSchema,
  currentStage: cvCandidateSchema,
  summary: cvCandidateSchema,
});

const cvDraftExtrasSchema = z.object({
  email: cvCandidateSchema,
  phone: cvCandidateSchema,
  skills: z.array(cvCandidateSchema).max(50),
});

export const cvDraftSchema = z.object({
  parserVersion: z.enum([
    'cv-v1',
    'cv-extract-full-v1',
    'cv-extract-four-pass-v2',
    'cv-extract-four-pass-v3',
  ]),
  adapterId: z.string().max(40),
  adapterVersion: z.string().max(20),
  profile: cvDraftProfileSchema,
  experiences: z.array(cvExperienceSchema).max(CV_EXPERIENCES_MAX),
  extras: cvDraftExtrasSchema,
  /**
   * Additive private projection; old cv-v1 records have no details or metadata.
   */
  details: cvDraftDetailsSchema.optional(),
  modelProvenance: cvModelProvenanceSchema.optional(),
});
export type CvDraft = z.infer<typeof cvDraftSchema>;

export const cvDiagnosticsSchema = z.object({
  detected: nonNegativeInt,
  ambiguous: nonNegativeInt,
  missing: nonNegativeInt,
  modelAttempted: z.boolean(),
  modelResolved: nonNegativeInt,
  modelStatus: z.enum([
    'not_needed',
    'unavailable',
    'succeeded',
    'invalid',
    'failed',
    'cancelled',
  ]),
  warnings: z.array(z.string().max(60)).max(20),
  errorCode: z.string().max(60).nullable(),
  durationMs: nonNegativeInt,
});
export type CvDiagnostics = z.infer<typeof cvDiagnosticsSchema>;

export const cvImportSchema = z.object({
  id,
  documentId: id.nullable(),
  status: z.enum(['processing', 'ready', 'partial', 'failed', 'cancelled']),
  sourceSha256: z.string().length(64),
  appliedStatus: z.literal('not_applied'),
  draft: cvDraftSchema.nullable(),
  diagnostics: cvDiagnosticsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CvImport = z.infer<typeof cvImportSchema>;

// --- cvImports.* IPC inputs/outputs ------------------------------------------

export const cvStartInputSchema = z.object({ documentId: id }).strict();

export const cvIdInputSchema = z.object({ importId: id }).strict();

export const cvListInputSchema = z
  .object({ limit: z.number().int().min(1).max(CV_LIST_MAX).optional() })
  .strict();

export const cvImportOutputSchema = z.object({ item: cvImportSchema });

export const cvListOutputSchema = z.object({
  items: z.array(cvImportSchema.omit({ draft: true })).max(CV_LIST_MAX),
});

export const cvCancelOutputSchema = z.object({ cancelled: z.boolean() });

export const cvDiscardOutputSchema = z.object({ discarded: z.literal(true) });
