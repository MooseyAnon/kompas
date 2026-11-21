import { z } from 'zod';
import { documentCategorySchema } from './documents';
import { webReadPageInputSchema, webErrorCodeSchema } from './web';

export const APPLICATIONS_MODULE_ID = 'applications';
export const APPLICATIONS_API_VERSION = 1;
export const JOB_SNAPSHOT_MAX_BYTES = 48 * 1024;

const id = z.string().uuid();

const required = (max: number) => z.string().trim().min(1).max(max);

const optional = (max: number) => z.string().trim().max(max).nullable();

const instant = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString());

const date = z.iso.date();

const url = z.url({ protocol: /^https?$/ }).max(2048);

export const stageKindSchema = z.enum([
  'saved',
  'applied',
  'screening',
  'interview',
  'assessment',
  'offer',
  'rejected',
  'withdrawn',
  'other',
]);
export type StageKind = z.infer<typeof stageKindSchema>;

export const stageSourceSchema = z.enum(['user', 'email', 'agent', 'import']);

export const noteSourceSchema = z.enum([
  'self_reported',
  'recruiter_feedback',
  'other',
]);

export const documentPurposeSchema = z.enum([
  'submitted_cv',
  'submitted_cover_letter',
  'supporting',
]);

const snapshotBlock = z
  .object({
    type: z.enum(['heading', 'paragraph', 'list']),
    text: z.string().min(1).max(20000),
  })
  .strict();

/** A snapshot must carry some posting content, as prose or as blocks. */
function hasSnapshotContent(snapshot: {
  descriptionText: string;
  contentBlocks: unknown[];
}): boolean {
  return (
    snapshot.descriptionText.trim().length > 0 ||
    snapshot.contentBlocks.length > 0
  );
}

export const jobSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.enum(['manual', 'web', 'email', 'other']),
    sourceUrl: url.nullable().default(null),
    capturedAt: instant,
    title: z.string().max(200).nullable().default(null),
    company: z.string().max(200).nullable().default(null),
    location: z.string().max(200).nullable().default(null),
    descriptionText: z.string().max(48000).default(''),
    contentBlocks: z.array(snapshotBlock).max(100).default([]),
  })
  .strict()
  .refine(hasSnapshotContent, {
    message: 'Enter a description or at least one content block.',
  });
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;

export type JobSnapshotInput = z.input<typeof jobSnapshotSchema>;

/**
 * True when the snapshot's UTF-8 JSON encoding fits `JOB_SNAPSHOT_MAX_BYTES`.
 */
export const snapshotWithinLimit = (snapshot: JobSnapshot) =>
  new TextEncoder().encode(JSON.stringify(snapshot)).length <=
  JOB_SNAPSHOT_MAX_BYTES;

const stageFields = z
  .object({
    stageLabel: required(200),
    stageKind: stageKindSchema.nullable().optional(),
    stageSubtype: optional(120).optional(),
    occurredAt: instant.optional(),
  })
  .strict();

export const stageEventSchema = z.object({
  id,
  applicationId: id,
  stageLabel: z.string(),
  stageKind: stageKindSchema.nullable(),
  stageSubtype: z.string().nullable(),
  occurredAt: z.string(),
  recordedAt: z.string(),
  source: stageSourceSchema,
  sourceRef: z.string().nullable(),
  sourceEvidence: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .nullable(),
  correctsEventId: id.nullable(),
});
export type StageEvent = z.infer<typeof stageEventSchema>;

export const applicationSchema = z.object({
  id,
  companyName: z.string(),
  roleTitle: z.string(),
  location: z.string().nullable(),
  jobUrl: z.string().nullable(),
  appliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  currentStage: stageEventSchema,
});
export type Application = z.infer<typeof applicationSchema>;

export const applicationNoteSchema = z.object({
  id,
  applicationId: id,
  stageEventId: id.nullable(),
  body: z.string(),
  source: noteSourceSchema,
  observedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApplicationNote = z.infer<typeof applicationNoteSchema>;

export const applicationDocumentSchema = z.object({
  id,
  applicationId: id,
  documentId: id.nullable(),
  purpose: documentPurposeSchema,
  originalName: z.string(),
  category: documentCategorySchema,
  mediaType: z.string(),
  sha256: z.string(),
  linkedAt: z.string(),
  submittedAt: z.string().nullable(),
  unlinkedAt: z.string().nullable(),
  unlinkReason: z.string().nullable(),
  unavailable: z.boolean(),
});
export type ApplicationDocument = z.infer<typeof applicationDocumentSchema>;

export const applicationDetailSchema = z.object({
  application: applicationSchema,
  snapshot: jobSnapshotSchema.nullable(),
  stages: z.array(stageEventSchema),
  notes: z.array(applicationNoteSchema),
  documents: z.array(applicationDocumentSchema),
});
export type ApplicationDetail = z.infer<typeof applicationDetailSchema>;

const metadataFields = z
  .object({
    companyName: required(200),
    roleTitle: required(200),
    location: optional(200).optional(),
    jobUrl: url.nullable().optional(),
    appliedAt: date.nullable().optional(),
  })
  .strict();

export const createApplicationInput = metadataFields
  .extend({
    initialStage: stageFields.optional(),
    snapshot: jobSnapshotSchema.optional(),
  })
  .strict();
export type CreateApplicationInput = z.infer<typeof createApplicationInput>;

const isManualSnapshot = (snapshot: JobSnapshot) =>
  snapshot.source === 'manual';

export const manualCreateApplicationInput = createApplicationInput.refine(
  (input) => !input.snapshot || isManualSnapshot(input.snapshot),
  { message: 'Manual capture must use manual provenance.' },
);

export const updateApplicationInput = z
  .object({
    id,
    patch: metadataFields.partial().strict(),
  })
  .strict();
export type UpdateApplicationInput = z.infer<typeof updateApplicationInput>;

export const listApplicationsInput = z
  .object({
    archived: z.boolean().default(false),
    kind: stageKindSchema.optional(),
    search: z.string().trim().max(200).optional(),
    cursor: id.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ListApplicationsInput = z.infer<typeof listApplicationsInput>;

export const applicationIdInput = z.object({ id }).strict();

export const manualCaptureInput = z
  .object({
    id,
    snapshot: jobSnapshotSchema.refine(isManualSnapshot),
  })
  .strict();

// The public renderer actions do not accept a stage source or evidence. Future
// trusted in-process ingestion calls the service with an explicit source.
export const transitionInput = z
  .object({ applicationId: id })
  .extend(stageFields.shape)
  .strict();
export type TransitionInput = z.infer<typeof transitionInput>;

export const correctStageInput = transitionInput;

export const createNoteInput = z
  .object({
    applicationId: id,
    body: required(10000),
    source: noteSourceSchema,
    stageEventId: id.nullable().optional(),
    observedAt: instant.nullable().optional(),
  })
  .strict();

export const updateNoteInput = z
  .object({
    applicationId: id,
    id,
    patch: createNoteInput.omit({ applicationId: true }).partial().strict(),
  })
  .strict();

export const removeNoteInput = z.object({ applicationId: id, id }).strict();

export const linkDocumentInput = z
  .object({
    applicationId: id,
    documentId: id,
    purpose: documentPurposeSchema,
    submittedAt: instant.nullable().optional(),
  })
  .strict();

export const unlinkDocumentInput = z
  .object({
    applicationId: id,
    id,
    reason: required(500).optional(),
  })
  .strict();

export const applicationOutput = z.object({ item: applicationSchema });

export const detailOutput = z.object({ item: applicationDetailSchema });

export const listOutput = z.object({
  items: z.array(applicationSchema),
  nextCursor: id.nullable(),
});

export const stageOutput = z.object({ item: stageEventSchema });

export const noteOutput = z.object({ item: applicationNoteSchema });

export const documentOutput = z.object({ item: applicationDocumentSchema });

export const snapshotOutput = z.object({ snapshot: jobSnapshotSchema });

export const doneOutput = z.object({ done: z.literal(true) });

export const importPreviewInput = webReadPageInputSchema;

export const importPreviewReason = z.enum([
  'page_unavailable',
  'page_incomplete',
  'not_job_description',
  'identity_unconfirmed',
  'model_unavailable',
  'extraction_failed',
  'snapshot_too_large',
  'snapshot_incomplete',
]);

export const importPreviewOutput = z
  .object({
    suppliedUrl: url,
    observedUrl: url.nullable(),
    readSucceeded: z.boolean(),
    extractionSucceeded: z.boolean(),
    snapshotAvailable: z.boolean(),
    reason: importPreviewReason.nullable(),
    webError: webErrorCodeSchema.nullable(),
    companyName: optional(200),
    roleTitle: optional(200),
    location: optional(200),
    // User-confirmed manual provenance only; never assert a trusted Web
    // capture.
    snapshot: jobSnapshotSchema.nullable(),
  })
  .strict();
export type ImportPreview = z.infer<typeof importPreviewOutput>;
