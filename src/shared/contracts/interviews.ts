import { z } from 'zod';

/** Public API major version for the `interviews` module. */
export const INTERVIEWS_API_VERSION = 1;

export const INTERVIEWS_MODULE_ID = 'interviews';

/** Subject free-text bound; matches the `interview_sessions.subject` CHECK. */
export const SUBJECT_MAX = 200;

/** Optional question-generation guidance bound; matches the DB CHECK. */
export const ADDITIONAL_GUIDANCE_MAX = 2000;

/** Quick-fire configured-question bounds and default. */
export const QUICK_FIRE_MIN_COUNT = 5;
export const QUICK_FIRE_MAX_COUNT = 10;
export const QUICK_FIRE_DEFAULT_COUNT = 5;

/**
 * User-selectable interview methods for v1. `mock` is reserved in the database
 * enum but is not implemented or selectable until a post-010 feature, so it is
 * deliberately absent from this public contract.
 */
export const INTERVIEW_METHODS = ['quick_fire', 'deep_loop'] as const;
export const interviewMethodSchema = z.enum(INTERVIEW_METHODS);
export type InterviewMethod = (typeof INTERVIEW_METHODS)[number];

/** Session lifecycle; only `draft` is user-creatable in stage 005. */
export const INTERVIEW_STATUSES = [
  'draft',
  'active',
  'completed',
  'abandoned',
] as const;
export const interviewStatusSchema = z.enum(INTERVIEW_STATUSES);
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/**
 * Immutable creation-time snapshot of the selected, user-approved career
 * target. Copied when a draft is created and preserved verbatim even if the
 * live target is later renamed or deleted.
 */
export const interviewTargetSnapshotSchema = z
  .object({
    role: z.string().max(SUBJECT_MAX),
    level: z.string().max(SUBJECT_MAX).nullable(),
    sector: z.string().max(SUBJECT_MAX).nullable(),
  })
  .strict();
export type InterviewTargetSnapshot = z.infer<
  typeof interviewTargetSnapshotSchema
>;

// --- Public entity shapes (camelCase wire projections) -----------------------

/** Full public session projection; omits internal profile ownership columns. */
export const interviewSessionSchema = z
  .object({
    id: z.string().min(1),
    method: interviewMethodSchema,
    subject: z.string().min(1).max(SUBJECT_MAX),
    careerTargetId: z.string().nullable(),
    targetSnapshot: interviewTargetSnapshotSchema.nullable(),
    questionCount: z.number().int().nullable(),
    /** User-authored question-generation guidance; null when none was given. */
    additionalGuidance: z
      .string()
      .min(1)
      .max(ADDITIONAL_GUIDANCE_MAX)
      .nullable(),
    status: interviewStatusSchema,
    phase: z.string().nullable(),
    /**
     * Hiring-bar criteria; null until calibrated by a later feature, never
     * faked.
     */
    barSnapshot: z.unknown().nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict();
export type InterviewSession = z.infer<typeof interviewSessionSchema>;

/** Smaller list projection; `targetRole` is read from the stable snapshot. */
export const interviewSessionSummarySchema = z
  .object({
    id: z.string().min(1),
    method: interviewMethodSchema,
    subject: z.string().min(1).max(SUBJECT_MAX),
    status: interviewStatusSchema,
    questionCount: z.number().int().nullable(),
    targetRole: z.string().nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type InterviewSessionSummary = z.infer<
  typeof interviewSessionSummarySchema
>;

/** Strict `{ sessionId }` request shared by most session-scoped operations. */
const sessionIdInputSchema = () =>
  z.object({ sessionId: z.string().uuid() }).strict();

/** Percentage score bound used by reviews, summaries and transcripts. */
const percentScoreSchema = z.number().min(0).max(100);

// --- sessions.list ----------------------------------------------------------

export const interviewSessionsListInputSchema = z.object({}).strict();
export const interviewSessionsListOutputSchema = z.object({
  items: z.array(interviewSessionSummarySchema),
});
export type InterviewSessionsListOutput = z.infer<
  typeof interviewSessionsListOutputSchema
>;

// --- sessions.get -----------------------------------------------------------

export const interviewSessionsGetInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export type InterviewSessionsGetInput = z.infer<
  typeof interviewSessionsGetInputSchema
>;

export const interviewSessionOutputSchema = z.object({
  session: interviewSessionSchema,
});
export type InterviewSessionOutput = z.infer<
  typeof interviewSessionOutputSchema
>;

// --- sessions.create --------------------------------------------------------

const subjectSchema = z.string().trim().min(1).max(SUBJECT_MAX);
const questionCountSchema = z.number().int();

/** C0/DEL control characters other than tab, line feed and carriage return. */
const UNSUPPORTED_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- deliberately rejects control characters.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Optional free-form guidance for question generation (style, practice goals,
 * past roles, companies). Trimmed; an empty or `null` value means "no
 * guidance". Overlength input is rejected rather than truncated. The text is
 * treated as lower-trust user context, never as an instruction to the app.
 */
const additionalGuidanceSchema = z
  .string()
  .trim()
  .max(ADDITIONAL_GUIDANCE_MAX)
  .refine((value) => !UNSUPPORTED_CONTROL_CHARS.test(value), {
    message: 'Guidance contains unsupported control characters.',
  })
  .nullable()
  .optional();

export const interviewSessionsCreateInputSchema = z
  .object({
    method: interviewMethodSchema,
    subject: subjectSchema,
    careerTargetId: z.string().uuid().nullable().optional(),
    questionCount: questionCountSchema.nullable().optional(),
    additionalGuidance: additionalGuidanceSchema,
  })
  .strict();
export type InterviewSessionsCreateInput = z.infer<
  typeof interviewSessionsCreateInputSchema
>;

// --- sessions.update --------------------------------------------------------

/**
 * Patch keys are optional (absent = unchanged). `method` cannot be changed.
 * `careerTargetId: null` clears the link and its snapshot; a UUID re-links and
 * re-snapshots. Count validity is enforced against the session's method.
 * `additionalGuidance: null` or an empty string clears the guidance.
 */
export const interviewSessionPatchSchema = z
  .object({
    subject: subjectSchema.optional(),
    careerTargetId: z.string().uuid().nullable().optional(),
    questionCount: questionCountSchema.nullable().optional(),
    additionalGuidance: additionalGuidanceSchema,
  })
  .strict();
export type InterviewSessionPatch = z.infer<typeof interviewSessionPatchSchema>;

export const interviewSessionsUpdateInputSchema = z
  .object({ id: z.string().uuid(), patch: interviewSessionPatchSchema })
  .strict();
export type InterviewSessionsUpdateInput = z.infer<
  typeof interviewSessionsUpdateInputSchema
>;

// --- sessions.delete --------------------------------------------------------

export const interviewSessionsDeleteInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export type InterviewSessionsDeleteInput = z.infer<
  typeof interviewSessionsDeleteInputSchema
>;

export const interviewDeletedOutputSchema = z.object({
  deleted: z.literal(true),
});
export type InterviewDeletedOutput = z.infer<
  typeof interviewDeletedOutputSchema
>;

// --- Grounded question generation (stage 007.1) -----------------------------

/**
 * Versioned, interview-owned prompt template identifier for comparison.
 * v2 (stage 07.0) adds the optional user-guidance block.
 */
export const INTERVIEW_QUESTION_PROMPT_VERSION = 'iq-v2';

/** Bounds for generated question/rubric content (defence-in-depth sizes). */
export const QUESTION_TEXT_MAX = 2000;
export const COMPETENCY_MAX = 120;
export const RUBRIC_CRITERIA_MIN = 1;
export const RUBRIC_CRITERIA_MAX = 5;
export const RUBRIC_CRITERION_TEXT_MAX = 400;

/**
 * Classification of how the question's content was grounded. This is a label,
 * never a citation or web reference.
 */
export const INTERVIEW_SOURCE_BASES = [
  'approved_target_and_model_general_knowledge',
  'model_general_knowledge',
] as const;
export const interviewSourceBasisSchema = z.enum(INTERVIEW_SOURCE_BASES);
export type InterviewSourceBasis = (typeof INTERVIEW_SOURCE_BASES)[number];

/**
 * Frozen, clearly-labelled assessment context for a session. A `provisional`
 * target hiring bar or a `practice` benchmark (no target). It is based on the
 * target/subject and explicit provisional expectations, never on user
 * performance, and is frozen before the first question is presented.
 */
export const interviewBarCriterionSchema = z
  .object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(400),
    weight: z.number().min(0).max(1),
  })
  .strict();
export type InterviewBarCriterion = z.infer<typeof interviewBarCriterionSchema>;

export const interviewBarBasisSchema = z
  .object({
    type: z.string().min(1).max(60),
    ref: z.string().max(64).nullable().optional(),
    summary: z.string().min(1).max(200),
  })
  .strict();

export const approvedOrProvisionalBarSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(['target_hiring_bar', 'practice_benchmark']),
    status: z.enum(['provisional', 'practice']),
    target: interviewTargetSnapshotSchema.nullable(),
    subject: z.string().min(1).max(SUBJECT_MAX),
    basis: z.array(interviewBarBasisSchema).max(8),
    assumptions: z.array(z.string().min(1).max(300)).max(8),
    criteria: z.array(interviewBarCriterionSchema).min(2).max(5),
    passThreshold: z.number().int().min(0).max(100),
  })
  .strict();
export type ApprovedOrProvisionalBar = z.infer<
  typeof approvedOrProvisionalBarSchema
>;

/** Safe provenance shown alongside a generated question (no prompt/profile). */
export const interviewQuestionProvenanceSchema = z
  .object({
    origin: z.literal('generated'),
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
    promptVersion: z.string().min(1).max(40),
    sourceBasis: interviewSourceBasisSchema,
    validation: z.literal('passed'),
    generatedAt: z.string().min(1),
  })
  .strict();
export type InterviewQuestionProvenance = z.infer<
  typeof interviewQuestionProvenanceSchema
>;

/**
 * Renderer-facing projection of a generated primary question. Exposes the
 * question, competency, a safe rubric summary (criteria labels only) and
 * provenance. The full hidden scoring reference stays in the domain DB.
 */
export const interviewQuestionViewSchema = z
  .object({
    id: z.string().min(1),
    roundId: z.string().min(1),
    question: z.string().min(1).max(QUESTION_TEXT_MAX),
    competency: z.string().min(1).max(COMPETENCY_MAX),
    createdAt: z.string().min(1),
    rubricSummary: z.array(z.string().min(1).max(200)).max(5).nullable(),
    provenance: interviewQuestionProvenanceSchema,
  })
  .strict();
export type InterviewQuestionView = z.infer<typeof interviewQuestionViewSchema>;

// --- questions.generate -----------------------------------------------------

export const interviewQuestionsGenerateInputSchema = sessionIdInputSchema();
export type InterviewQuestionsGenerateInput = z.infer<
  typeof interviewQuestionsGenerateInputSchema
>;

export const interviewQuestionsGenerateOutputSchema = z.object({
  session: interviewSessionSchema,
  question: interviewQuestionViewSchema,
});
export type InterviewQuestionsGenerateOutput = z.infer<
  typeof interviewQuestionsGenerateOutputSchema
>;

// --- questions.preview.get --------------------------------------------------

export const interviewQuestionsPreviewGetInputSchema = sessionIdInputSchema();
export type InterviewQuestionsPreviewGetInput = z.infer<
  typeof interviewQuestionsPreviewGetInputSchema
>;

export const interviewQuestionsPreviewGetOutputSchema = z.object({
  question: interviewQuestionViewSchema.nullable(),
  bar: approvedOrProvisionalBarSchema.nullable(),
});
export type InterviewQuestionsPreviewGetOutput = z.infer<
  typeof interviewQuestionsPreviewGetOutputSchema
>;

// --- questions.preview.clear ------------------------------------------------

export const interviewQuestionsPreviewClearInputSchema = sessionIdInputSchema();
export type InterviewQuestionsPreviewClearInput = z.infer<
  typeof interviewQuestionsPreviewClearInputSchema
>;

export const interviewQuestionsPreviewClearOutputSchema = z.object({
  cleared: z.boolean(),
});
export type InterviewQuestionsPreviewClearOutput = z.infer<
  typeof interviewQuestionsPreviewClearOutputSchema
>;

// --- Deep-loop review, coaching and reassessment (stage 007.2) --------------

/** Versioned, interview-owned prompt identifiers for the 007.2 tasks. */
export const INTERVIEW_REVIEW_PROMPT_VERSION = 'ir-v1';
export const INTERVIEW_COACH_PROMPT_VERSION = 'ic-v1';
/** v2 (stage 07.0) inherits the question prompt's optional guidance block. */
export const INTERVIEW_PARALLEL_PROMPT_VERSION = 'ip-v2';

/** Bounds for a submitted answer (defence-in-depth sizes). */
export const ANSWER_TEXT_MIN = 1;
export const ANSWER_TEXT_MAX = 8000;

/** Bounds for persisted coaching/review free text. */
export const FEEDBACK_TEXT_MAX = 1200;
export const COACH_TEXT_MAX = 2000;

/** A review decision that can be surfaced to the renderer. */
export const INTERVIEW_REVIEW_DECISIONS = ['pass', 'fail', 'unscored'] as const;
export const interviewReviewDecisionSchema = z.enum(INTERVIEW_REVIEW_DECISIONS);
export type InterviewReviewDecision =
  (typeof INTERVIEW_REVIEW_DECISIONS)[number];

/** Safe model provenance surfaced with a review or coaching record. */
export const interviewModelProvenanceSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
    promptVersion: z.string().min(1).max(40),
    validation: z.enum(['passed', 'unscored']),
    generatedAt: z.string().min(1),
  })
  .strict();
export type InterviewModelProvenance = z.infer<
  typeof interviewModelProvenanceSchema
>;

/** A single scored criterion in a review projection. */
export const interviewReviewCriterionSchema = z
  .object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    weight: z.number().min(0).max(1),
    score: percentScoreSchema.nullable(),
    evidence: z.string().max(FEEDBACK_TEXT_MAX).nullable(),
    rationale: z.string().max(FEEDBACK_TEXT_MAX).nullable(),
  })
  .strict();
export type InterviewReviewCriterion = z.infer<
  typeof interviewReviewCriterionSchema
>;

/**
 * Renderer-facing projection of a committed review. The weighted `score` and
 * `decision` are computed deterministically by the application from the frozen
 * bar; the model never sets them directly. Marked `provisional` for the UI.
 */
export const interviewReviewViewSchema = z
  .object({
    id: z.string().min(1),
    roundId: z.string().min(1),
    decision: interviewReviewDecisionSchema,
    score: percentScoreSchema.nullable(),
    provisional: z.literal(true),
    barKind: z.enum(['target_hiring_bar', 'practice_benchmark']).nullable(),
    passThreshold: z.number().int().min(0).max(100).nullable(),
    criteria: z.array(interviewReviewCriterionSchema).max(5),
    strengths: z.array(z.string().min(1).max(FEEDBACK_TEXT_MAX)).max(8),
    gaps: z.array(z.string().min(1).max(FEEDBACK_TEXT_MAX)).max(8),
    needsMoreEvidence: z.boolean(),
    unscoredReason: z.string().max(200).nullable(),
    modelProvenance: interviewModelProvenanceSchema,
    createdAt: z.string().min(1),
  })
  .strict();
export type InterviewReviewView = z.infer<typeof interviewReviewViewSchema>;

/**
 * Renderer-facing projection of a coaching record (only after a failed review).
 */
export const interviewCoachingViewSchema = z
  .object({
    id: z.string().min(1),
    roundId: z.string().min(1),
    diagnosis: z.string().min(1).max(COACH_TEXT_MAX),
    advice: z.array(z.string().min(1).max(COACH_TEXT_MAX)).min(1).max(5),
    workedExample: z.string().max(COACH_TEXT_MAX).nullable(),
    reassessmentFocus: z.string().min(1).max(COACH_TEXT_MAX),
    modelProvenance: interviewModelProvenanceSchema,
    createdAt: z.string().min(1),
  })
  .strict();
export type InterviewCoachingView = z.infer<typeof interviewCoachingViewSchema>;

// --- answers.submit ---------------------------------------------------------

/**
 * Optional association of a committed answer to the audio recording (and
 * optional original transcript) it was spoken from. Stage 008.3: the review
 * pipeline still receives plain `answerText` only; this metadata is validated
 * against the Audio façade and stored atomically with the answer so the source
 * recording can be replayed later. Ids are opaque — no path, model or engine
 * detail crosses this boundary.
 */
export const interviewAnswerAudioLinkSchema = z
  .object({
    recordingId: z.string().uuid(),
    transcriptId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type InterviewAnswerAudioLink = z.infer<
  typeof interviewAnswerAudioLinkSchema
>;

export const interviewAnswersSubmitInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    questionId: z.string().uuid(),
    answerText: z.string().trim().min(ANSWER_TEXT_MIN).max(ANSWER_TEXT_MAX),
    audio: interviewAnswerAudioLinkSchema.optional(),
  })
  .strict();
export type InterviewAnswersSubmitInput = z.infer<
  typeof interviewAnswersSubmitInputSchema
>;

export const interviewAnswersSubmitOutputSchema = z.object({
  answerId: z.string().min(1),
  roundId: z.string().min(1),
  sessionStatus: interviewStatusSchema,
  phase: z.string().nullable(),
});
export type InterviewAnswersSubmitOutput = z.infer<
  typeof interviewAnswersSubmitOutputSchema
>;

// --- answers.draft.* (Stage 008.3 crash-safe voice draft) -------------------

/**
 * A persisted, recoverable voice answer draft for a single (session, question).
 * `recordingId` is the retained source recording (if any) and `draftText` is
 * the user's editable answer-in-progress. Null means no draft is stored yet.
 */
export const interviewAnswerDraftSchema = z
  .object({
    sessionId: z.string().uuid(),
    questionId: z.string().uuid(),
    recordingId: z.string().uuid().nullable(),
    draftText: z.string().max(ANSWER_TEXT_MAX).nullable(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type InterviewAnswerDraft = z.infer<typeof interviewAnswerDraftSchema>;

export const interviewAnswersDraftGetInputSchema = z
  .object({ sessionId: z.string().uuid(), questionId: z.string().uuid() })
  .strict();
export type InterviewAnswersDraftGetInput = z.infer<
  typeof interviewAnswersDraftGetInputSchema
>;
export const interviewAnswersDraftGetOutputSchema = z.object({
  draft: interviewAnswerDraftSchema.nullable(),
});
export type InterviewAnswersDraftGetOutput = z.infer<
  typeof interviewAnswersDraftGetOutputSchema
>;

export const interviewAnswersDraftSaveInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    questionId: z.string().uuid(),
    recordingId: z.string().uuid().nullable().optional(),
    draftText: z.string().max(ANSWER_TEXT_MAX).nullable().optional(),
  })
  .strict();
export type InterviewAnswersDraftSaveInput = z.infer<
  typeof interviewAnswersDraftSaveInputSchema
>;
export const interviewAnswersDraftSaveOutputSchema = z.object({
  draft: interviewAnswerDraftSchema,
});
export type InterviewAnswersDraftSaveOutput = z.infer<
  typeof interviewAnswersDraftSaveOutputSchema
>;

export const interviewAnswersDraftClearInputSchema = z
  .object({ sessionId: z.string().uuid(), questionId: z.string().uuid() })
  .strict();
export type InterviewAnswersDraftClearInput = z.infer<
  typeof interviewAnswersDraftClearInputSchema
>;
export const interviewAnswersDraftClearOutputSchema = z.object({
  cleared: z.literal(true),
});
export type InterviewAnswersDraftClearOutput = z.infer<
  typeof interviewAnswersDraftClearOutputSchema
>;

// --- answers.audio.get (committed association, for replay) -------------------

/** The immutable committed audio link for an answered question, or null. */
export const interviewAnswerAudioSchema = z
  .object({
    answerId: z.string().min(1),
    recordingId: z.string().min(1),
    transcriptId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  })
  .strict();
export type InterviewAnswerAudio = z.infer<typeof interviewAnswerAudioSchema>;

export const interviewAnswersAudioGetInputSchema = z
  .object({ sessionId: z.string().uuid(), questionId: z.string().uuid() })
  .strict();
export type InterviewAnswersAudioGetInput = z.infer<
  typeof interviewAnswersAudioGetInputSchema
>;
export const interviewAnswersAudioGetOutputSchema = z.object({
  audio: interviewAnswerAudioSchema.nullable(),
});
export type InterviewAnswersAudioGetOutput = z.infer<
  typeof interviewAnswersAudioGetOutputSchema
>;

// --- reviews.run ------------------------------------------------------------

export const interviewReviewsRunInputSchema = z
  .object({ sessionId: z.string().uuid(), roundId: z.string().uuid() })
  .strict();
export type InterviewReviewsRunInput = z.infer<
  typeof interviewReviewsRunInputSchema
>;

export const interviewReviewsRunOutputSchema = z.object({
  review: interviewReviewViewSchema,
});
export type InterviewReviewsRunOutput = z.infer<
  typeof interviewReviewsRunOutputSchema
>;

// --- reviews.get ------------------------------------------------------------

export const interviewReviewsGetInputSchema = z
  .object({ sessionId: z.string().uuid(), roundId: z.string().uuid() })
  .strict();
export type InterviewReviewsGetInput = z.infer<
  typeof interviewReviewsGetInputSchema
>;

export const interviewReviewsGetOutputSchema = z.object({
  review: interviewReviewViewSchema.nullable(),
  coaching: interviewCoachingViewSchema.nullable(),
});
export type InterviewReviewsGetOutput = z.infer<
  typeof interviewReviewsGetOutputSchema
>;

// --- coaching.run -----------------------------------------------------------

export const interviewCoachingRunInputSchema = z
  .object({ sessionId: z.string().uuid(), roundId: z.string().uuid() })
  .strict();
export type InterviewCoachingRunInput = z.infer<
  typeof interviewCoachingRunInputSchema
>;

export const interviewCoachingRunOutputSchema = z.object({
  coaching: interviewCoachingViewSchema,
});
export type InterviewCoachingRunOutput = z.infer<
  typeof interviewCoachingRunOutputSchema
>;

// --- reassessment.generate --------------------------------------------------

export const interviewReassessmentGenerateInputSchema = z
  .object({ sessionId: z.string().uuid(), failedRoundId: z.string().uuid() })
  .strict();
export type InterviewReassessmentGenerateInput = z.infer<
  typeof interviewReassessmentGenerateInputSchema
>;

export const interviewReassessmentGenerateOutputSchema = z.object({
  newRoundId: z.string().min(1),
  question: interviewQuestionViewSchema,
});
export type InterviewReassessmentGenerateOutput = z.infer<
  typeof interviewReassessmentGenerateOutputSchema
>;

// --- Interactive sessions (stage 007.3) -------------------------------------

/**
 * Versioned, interview-owned prompt identifier for bounded interviewer
 * follow-up questions. A distinct identifier from the primary/reassessment
 * question prompt so provenance makes the task clear. v2 (stage 07.0) adds the
 * optional user-guidance block.
 */
export const INTERVIEW_FOLLOW_UP_PROMPT_VERSION = 'if-v2';

/** Default interviewer follow-up budget per deep-loop round (hard cap). */
export const DEEP_LOOP_FOLLOW_UP_BUDGET = 2;

/** Bounded ephemeral streamed progress text surfaced to the UI. */
export const PROGRESS_TEXT_MAX = 2000;

/**
 * Durable, explicitly-validated session phases for the interactive runner.
 * Stored in the existing free-text `interview_sessions.phase` column; the
 * session service only ever writes one of these values. `preview`/`deep_loop`
 * remain accepted for the pre-007.3 single-question slices.
 */
export const INTERVIEW_SESSION_PHASES = [
  'preparing',
  'answering',
  'follow_up',
  'awaiting_review',
  'reviewed',
  'coached',
  'assessed',
  'completed',
  'abandoned',
] as const;
export const interviewSessionPhaseSchema = z.enum(INTERVIEW_SESSION_PHASES);
export type InterviewSessionPhase = (typeof INTERVIEW_SESSION_PHASES)[number];

/** Transient in-memory operation status for a session's current model call. */
export const INTERVIEW_OPERATION_STATUSES = [
  'idle',
  'running',
  'failed',
  'cancelled',
] as const;
export const interviewOperationStatusSchema = z.enum(
  INTERVIEW_OPERATION_STATUSES,
);
export type InterviewOperationStatus =
  (typeof INTERVIEW_OPERATION_STATUSES)[number];

// --- sessions.start ---------------------------------------------------------

export const interviewSessionsStartInputSchema = sessionIdInputSchema();
export type InterviewSessionsStartInput = z.infer<
  typeof interviewSessionsStartInputSchema
>;

export const interviewSessionsStartOutputSchema = z.object({
  session: interviewSessionSchema,
  phase: z.string().nullable(),
  progressId: z.string().nullable(),
});
export type InterviewSessionsStartOutput = z.infer<
  typeof interviewSessionsStartOutputSchema
>;

// --- sessions.progress ------------------------------------------------------

export const interviewSessionsProgressInputSchema = sessionIdInputSchema();
export type InterviewSessionsProgressInput = z.infer<
  typeof interviewSessionsProgressInputSchema
>;

export const interviewSessionsProgressOutputSchema = z.object({
  phase: z.string().nullable(),
  operationStatus: interviewOperationStatusSchema,
  /**
   * Bounded, ephemeral partial generation text; cleared when the op settles.
   */
  progressText: z.string().max(PROGRESS_TEXT_MAX).nullable(),
  /** Safe, non-sensitive label describing the running operation, if any. */
  operation: z.string().nullable(),
  /** User-facing recoverable error for a failed/cancelled operation. */
  errorMessage: z.string().max(400).nullable(),
  questionCount: z.number().int().nonnegative(),
  answeredCount: z.number().int().nonnegative(),
  reviewedCount: z.number().int().nonnegative(),
  canSubmit: z.boolean(),
  canRetry: z.boolean(),
});
export type InterviewSessionsProgressOutput = z.infer<
  typeof interviewSessionsProgressOutputSchema
>;

// --- sessions.advance -------------------------------------------------------

export const interviewSessionsAdvanceInputSchema = sessionIdInputSchema();
export type InterviewSessionsAdvanceInput = z.infer<
  typeof interviewSessionsAdvanceInputSchema
>;

export const interviewSessionsAdvanceOutputSchema = z.object({
  session: interviewSessionSchema,
  currentQuestion: interviewQuestionViewSchema.nullable(),
  phase: z.string().nullable(),
  progressId: z.string().nullable(),
});
export type InterviewSessionsAdvanceOutput = z.infer<
  typeof interviewSessionsAdvanceOutputSchema
>;

// --- sessions.finish --------------------------------------------------------

export const interviewSessionsFinishInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    outcome: z.enum(['completed', 'abandoned']),
  })
  .strict();
export type InterviewSessionsFinishInput = z.infer<
  typeof interviewSessionsFinishInputSchema
>;

/** Per-round outcome row in a derived session summary. */
export const interviewSummaryRoundSchema = z
  .object({
    roundId: z.string().min(1),
    ordinal: z.number().int(),
    competency: z.string().nullable(),
    decision: interviewReviewDecisionSchema.nullable(),
    score: percentScoreSchema.nullable(),
    isReassessment: z.boolean(),
  })
  .strict();
export type InterviewSummaryRound = z.infer<typeof interviewSummaryRoundSchema>;

const NARRATIVE_ITEM_MAX = 200;
const NARRATIVE_ITEMS_MAX = 4;

/** Optional model-written narrative attached to a published session summary. */
const summaryNarrativeSchema = z
  .object({
    strengths: z
      .array(z.string().max(NARRATIVE_ITEM_MAX))
      .max(NARRATIVE_ITEMS_MAX),
    gaps: z.array(z.string().max(NARRATIVE_ITEM_MAX)).max(NARRATIVE_ITEMS_MAX),
    recommendations: z
      .array(z.string().max(NARRATIVE_ITEM_MAX))
      .max(NARRATIVE_ITEMS_MAX),
  })
  .strict();

/**
 * A session summary derived from persisted reviews. It is an honest roll-up of
 * committed outcomes only — never a fabricated all-pass score — and carries no
 * canonical-identity competency claim.
 */
export const interviewSessionSummarySchemaResult = z
  .object({
    method: interviewMethodSchema,
    subject: z.string().min(1).max(SUBJECT_MAX),
    totalRounds: z.number().int().nonnegative(),
    answeredCount: z.number().int().nonnegative(),
    reviewedCount: z.number().int().nonnegative(),
    passCount: z.number().int().nonnegative(),
    failCount: z.number().int().nonnegative(),
    unscoredCount: z.number().int().nonnegative(),
    averageScore: percentScoreSchema.nullable(),
    complete: z.boolean(),
    recommendation: z.string().max(400).nullable(),
    narrative: summaryNarrativeSchema.nullable().optional(),
    narrativeUnavailable: z.boolean().optional(),
    publishedAt: z.string().nullable().optional(),
    narrativeProvenance: interviewModelProvenanceSchema.optional(),
    rounds: z.array(interviewSummaryRoundSchema).max(64),
  })
  .strict();
export type InterviewSessionSummaryResult = z.infer<
  typeof interviewSessionSummarySchemaResult
>;

export const interviewSessionsFinishOutputSchema = z.object({
  session: interviewSessionSchema,
  summary: interviewSessionSummarySchemaResult,
});
export type InterviewSessionsFinishOutput = z.infer<
  typeof interviewSessionsFinishOutputSchema
>;

// --- sessions.cancelOperation -----------------------------------------------

export const interviewSessionsCancelInputSchema = sessionIdInputSchema();
export type InterviewSessionsCancelInput = z.infer<
  typeof interviewSessionsCancelInputSchema
>;

export const interviewSessionsCancelOutputSchema = z.object({
  cancelled: z.boolean(),
});
export type InterviewSessionsCancelOutput = z.infer<
  typeof interviewSessionsCancelOutputSchema
>;

// --- sessions.transcript ----------------------------------------------------

export const interviewSessionsTranscriptInputSchema = sessionIdInputSchema();
export type InterviewSessionsTranscriptInput = z.infer<
  typeof interviewSessionsTranscriptInputSchema
>;

/** The kind of a single chronological transcript entry. */
export const INTERVIEW_TURN_TYPES = [
  'question',
  'answer',
  'review',
  'coaching',
] as const;
export const interviewTurnTypeSchema = z.enum(INTERVIEW_TURN_TYPES);
export type InterviewTurnType = (typeof INTERVIEW_TURN_TYPES)[number];

/**
 * One flattened, chronological transcript turn. `text` carries the
 * question/answer/diagnosis text; review turns carry `decision`/`score`.
 */
export const interviewTranscriptTurnSchema = z
  .object({
    type: interviewTurnTypeSchema,
    roundId: z.string().min(1),
    roundOrdinal: z.number().int(),
    questionKind: z.enum(['primary', 'follow_up']).nullable(),
    text: z.string().max(ANSWER_TEXT_MAX).nullable(),
    competency: z.string().max(COMPETENCY_MAX).nullable(),
    decision: interviewReviewDecisionSchema.nullable(),
    score: percentScoreSchema.nullable(),
    createdAt: z.string().min(1),
  })
  .strict();
export type InterviewTranscriptTurn = z.infer<
  typeof interviewTranscriptTurnSchema
>;

export const interviewSessionsTranscriptOutputSchema = z.object({
  items: z.array(interviewTranscriptTurnSchema).max(512),
  summary: interviewSessionSummarySchemaResult.nullable(),
});
export type InterviewSessionsTranscriptOutput = z.infer<
  typeof interviewSessionsTranscriptOutputSchema
>;

// --- High-level workflow (06.2; API major 1) -------------------------------

export const interviewWorkflowIdInputSchema = sessionIdInputSchema();

export const interviewWorkflowAnswerInputSchema =
  interviewAnswersSubmitInputSchema;

/**
 * User intents a snapshot may advertise. `request_coaching` and
 * `request_reassessment` (06.4) are explicit Deep Loop choices after a failed
 * review; Quick-fire never advertises them.
 */
export const interviewWorkflowActionSchema = z.enum([
  'start',
  'answer',
  'continue',
  'retry',
  'request_coaching',
  'request_reassessment',
  'request_results',
  'pause',
  'abandon',
]);
export type InterviewWorkflowAction = z.infer<
  typeof interviewWorkflowActionSchema
>;

/**
 * Deep Loop round guidance (06.4): the backend-owned follow-up/reassessment
 * limits for the active round and any learning recommendation. Absent for
 * Quick-fire snapshots.
 */
export const interviewDeepLoopGuidanceSchema = z
  .object({
    roundId: z.string().min(1),
    isReassessment: z.boolean(),
    followUpLimit: z.number().int().min(0).max(DEEP_LOOP_FOLLOW_UP_BUDGET),
    followUpsAsked: z.number().int().nonnegative(),
    reassessmentDepth: z.number().int().nonnegative(),
    reassessmentCap: z.number().int().positive(),
    recommendation: z.string().max(400).nullable(),
  })
  .strict();
export type InterviewDeepLoopGuidance = z.infer<
  typeof interviewDeepLoopGuidanceSchema
>;

export const interviewWorkflowStateSchema = z
  .object({
    session: interviewSessionSchema,
    currentQuestion: interviewQuestionViewSchema.nullable(),
    progress: interviewSessionsProgressOutputSchema,
    operationId: z.string().uuid().nullable(),
    availableActions: z.array(interviewWorkflowActionSchema),
    feedback: interviewReviewsGetOutputSchema.nullable(),
    result: interviewSessionSummarySchemaResult.nullable(),
    deepLoop: interviewDeepLoopGuidanceSchema.nullable().optional(),
  })
  .strict();
export type InterviewWorkflowState = z.infer<
  typeof interviewWorkflowStateSchema
>;

export const interviewWorkflowStateOutputSchema = z
  .object({ state: interviewWorkflowStateSchema })
  .strict();

/** `workflow.continue` carries every non-answer onward choice. */
export const interviewWorkflowContinueInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    action: z.enum([
      'continue',
      'retry',
      'request_coaching',
      'request_reassessment',
    ]),
  })
  .strict();
export type InterviewWorkflowContinueInput = z.infer<
  typeof interviewWorkflowContinueInputSchema
>;
