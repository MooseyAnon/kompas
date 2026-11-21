import { z } from 'zod';
import { isExperienceDate } from './experience-dates';

/** Public API major version for the `identity` module. */
export const IDENTITY_API_VERSION = 1;

export const IDENTITY_MODULE_ID = 'identity';

/** Field length limits shared by the API and enforced by the DB schema. */
export const DISPLAY_NAME_MAX = 120;
export const ROLE_TITLE_MAX = 200;
export const SHORT_TEXT_MAX = 200;
export const LONG_TEXT_MAX = 10_000;

/** Career stage enum; matches the `profiles.current_stage` CHECK. */
export const CAREER_STAGES = [
  'student',
  'graduate',
  'employed',
  'career_change',
  'other',
] as const;
export const careerStageSchema = z.enum(CAREER_STAGES);
export type CareerStage = (typeof CAREER_STAGES)[number];

/** Experience category enum; matches the `experiences.category` CHECK. */
export const EXPERIENCE_CATEGORIES = [
  'employment',
  'education',
  'project',
  'other',
] as const;
export const experienceCategorySchema = z.enum(EXPERIENCE_CATEGORIES);
export type ExperienceCategory = (typeof EXPERIENCE_CATEGORIES)[number];

/** Verification status; UI-created items are always `user_confirmed`. */
export const VERIFICATION_STATUSES = ['user_confirmed', 'unconfirmed'] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const isoDateSchema = z.string().trim().refine(isExperienceDate, {
  message: 'Dates must be a valid YYYY, YYYY-MM or YYYY-MM-DD.',
});

/**
 * A trimmed, non-blank role/title (profiles have no inherent required title).
 */
const roleTitleSchema = z.string().trim().min(1).max(ROLE_TITLE_MAX);
/**
 * Trimmed free text of up to `SHORT_TEXT_MAX`, nullable where the column
 * allows.
 */
const shortTextSchema = z.string().trim().max(SHORT_TEXT_MAX);
const longTextSchema = z.string().trim().max(LONG_TEXT_MAX);

const entityIdSchema = z.string().uuid();

/**
 * Maximum experiences accepted in, or returned from, a single CV import apply.
 */
const IMPORT_EXPERIENCES_MAX = 40;

const timestampSchema = z.string().min(1);

// --- Public entity shapes (camelCase wire projections) -----------------------

export const profileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().max(DISPLAY_NAME_MAX),
  currentStage: careerStageSchema.nullable(),
  currentRole: z.string().max(ROLE_TITLE_MAX).nullable(),
  location: z.string().max(SHORT_TEXT_MAX).nullable(),
  summary: z.string().max(LONG_TEXT_MAX).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Profile = z.infer<typeof profileSchema>;

export const targetSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  roleTitle: z.string().min(1).max(ROLE_TITLE_MAX),
  targetLevel: z.string().max(SHORT_TEXT_MAX).nullable(),
  sector: z.string().max(SHORT_TEXT_MAX).nullable(),
  location: z.string().max(SHORT_TEXT_MAX).nullable(),
  active: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Target = z.infer<typeof targetSchema>;

export const experienceSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  category: experienceCategorySchema,
  organisation: z.string().max(SHORT_TEXT_MAX).nullable(),
  roleTitle: z.string().min(1).max(ROLE_TITLE_MAX),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  description: z.string().max(LONG_TEXT_MAX),
  verificationStatus: verificationStatusSchema,
  sourceDocumentId: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Experience = z.infer<typeof experienceSchema>;

/** Skills become canonical only through explicit user entry/replacement. */
export const confirmedSkillsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(100);

export const skillsReplaceInputSchema = z.strictObject({
  names: confirmedSkillsSchema,
});

export const skillsOutputSchema = z.strictObject({
  names: confirmedSkillsSchema,
});

// --- profile.get / profile.update -------------------------------------------

export const profileGetInputSchema = z.object({}).strict();
export type ProfileGetInput = z.infer<typeof profileGetInputSchema>;

export const profileGetOutputSchema = z.object({ profile: profileSchema });
export type ProfileGetOutput = z.infer<typeof profileGetOutputSchema>;

/**
 * Patch keys are optional (absent = unchanged). Nullable keys accept `null` to
 * explicitly clear the field. `displayName` is never null (empty string
 * clears).
 */
export const profilePatchSchema = z
  .object({
    displayName: z.string().trim().max(DISPLAY_NAME_MAX).optional(),
    currentStage: careerStageSchema.nullable().optional(),
    currentRole: shortTextSchema.nullable().optional(),
    location: shortTextSchema.nullable().optional(),
    summary: longTextSchema.nullable().optional(),
  })
  .strict();
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export const profileUpdateInputSchema = z
  .object({ patch: profilePatchSchema })
  .strict();
export type ProfileUpdateInput = z.infer<typeof profileUpdateInputSchema>;

export const profileUpdateOutputSchema = z.object({ profile: profileSchema });
export type ProfileUpdateOutput = z.infer<typeof profileUpdateOutputSchema>;

// --- targets.* --------------------------------------------------------------

export const targetsListInputSchema = z.object({}).strict();

export const targetsListOutputSchema = z.object({
  items: z.array(targetSchema),
});
export type TargetsListOutput = z.infer<typeof targetsListOutputSchema>;

export const targetsCreateInputSchema = z
  .object({
    roleTitle: roleTitleSchema,
    targetLevel: shortTextSchema.nullable().optional(),
    sector: shortTextSchema.nullable().optional(),
    location: shortTextSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type TargetsCreateInput = z.infer<typeof targetsCreateInputSchema>;

export const targetPatchSchema = z
  .object({
    roleTitle: roleTitleSchema.optional(),
    targetLevel: shortTextSchema.nullable().optional(),
    sector: shortTextSchema.nullable().optional(),
    location: shortTextSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type TargetPatch = z.infer<typeof targetPatchSchema>;

export const targetsUpdateInputSchema = z
  .object({ id: z.string().uuid(), patch: targetPatchSchema })
  .strict();
export type TargetsUpdateInput = z.infer<typeof targetsUpdateInputSchema>;

export const targetsDeleteInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export type TargetsDeleteInput = z.infer<typeof targetsDeleteInputSchema>;

export const targetItemOutputSchema = z.object({ item: targetSchema });
export type TargetItemOutput = z.infer<typeof targetItemOutputSchema>;

export const deletedOutputSchema = z.object({ deleted: z.literal(true) });
export type DeletedOutput = z.infer<typeof deletedOutputSchema>;

// --- experiences.* ----------------------------------------------------------

export const experiencesListInputSchema = z.object({}).strict();

export const experiencesListOutputSchema = z.object({
  items: z.array(experienceSchema),
});
export type ExperiencesListOutput = z.infer<typeof experiencesListOutputSchema>;

export const experiencesCreateInputSchema = z
  .object({
    category: experienceCategorySchema,
    roleTitle: roleTitleSchema,
    organisation: shortTextSchema.nullable().optional(),
    startDate: isoDateSchema.nullable().optional(),
    endDate: isoDateSchema.nullable().optional(),
    description: longTextSchema.optional(),
  })
  .strict();
export type ExperiencesCreateInput = z.infer<
  typeof experiencesCreateInputSchema
>;

export const experiencePatchSchema = z
  .object({
    category: experienceCategorySchema.optional(),
    roleTitle: roleTitleSchema.optional(),
    organisation: shortTextSchema.nullable().optional(),
    startDate: isoDateSchema.nullable().optional(),
    endDate: isoDateSchema.nullable().optional(),
    description: longTextSchema.optional(),
  })
  .strict();
export type ExperiencePatch = z.infer<typeof experiencePatchSchema>;

export const experiencesUpdateInputSchema = z
  .object({ id: z.string().uuid(), patch: experiencePatchSchema })
  .strict();
export type ExperiencesUpdateInput = z.infer<
  typeof experiencesUpdateInputSchema
>;

export const experiencesDeleteInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export type ExperiencesDeleteInput = z.infer<
  typeof experiencesDeleteInputSchema
>;

export const experienceItemOutputSchema = z.object({ item: experienceSchema });
export type ExperienceItemOutput = z.infer<typeof experienceItemOutputSchema>;

// --- import apply / summary -------------------------------------------------

/**
 * Per-experience review decision: add new, replace an existing one, or keep it.
 */
const importExperienceDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('add'),
    value: experiencesCreateInputSchema,
  }),
  z.object({
    decision: z.literal('replace'),
    id: entityIdSchema,
    value: experiencesCreateInputSchema,
  }),
  z.object({ decision: z.literal('keep'), id: entityIdSchema }),
]);

/** One reviewed import, atomically applied once. All choices are explicit. */
export const applyImportInputSchema = z
  .object({
    importId: entityIdSchema,
    profile: profilePatchSchema,
    skills: confirmedSkillsSchema.optional(),
    experiences: z
      .array(importExperienceDecisionSchema)
      .max(IMPORT_EXPERIENCES_MAX),
  })
  .strict();
export type ApplyImportInput = z.infer<typeof applyImportInputSchema>;

export const applyImportOutputSchema = z.object({
  profile: profileSchema,
  experiences: z.array(experienceSchema).max(IMPORT_EXPERIENCES_MAX),
  alreadyApplied: z.boolean(),
});
export type ApplyImportOutput = z.infer<typeof applyImportOutputSchema>;

export const summaryGenerateInputSchema = z.object({}).strict();

export const summaryGenerateOutputSchema = z.object({
  draft: z.string().min(1).max(2000),
});
