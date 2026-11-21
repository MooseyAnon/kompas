import { z } from 'zod';
import {
  approvedOrProvisionalBarSchema,
  interviewCoachingViewSchema,
  interviewMethodSchema,
  interviewReviewDecisionSchema,
  interviewReviewViewSchema,
  interviewSessionSchema,
  interviewStatusSchema,
  SUBJECT_MAX,
} from './interviews';

/** Maximum items per insights page; output arrays share the same bound. */
const PAGE_LIMIT_MAX = 50;
const PAGE_LIMIT_DEFAULT = 20;

const MAX_ROUNDS_PER_SESSION = 64;
const MAX_QUESTIONS_PER_ROUND = 16;
const MAX_PROGRESS_POINTS = 100;

const questionKindSchema = () => z.enum(['primary', 'follow_up']);
const percentScoreSchema = () => z.number().min(0).max(100);
const countSchema = () => z.number().int().nonnegative();

// --- Inputs -----------------------------------------------------------------

/** Keyset pagination fields shared by the list inputs. */
const page = {
  cursor: z.string().uuid().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
};

const subject = z.string().trim().min(1).max(SUBJECT_MAX).optional();

export const insightsSessionsInputSchema = z
  .object({
    ...page,
    method: interviewMethodSchema.optional(),
    status: interviewStatusSchema.optional(),
    subject,
  })
  .strict();

export const insightsQuestionsInputSchema = z
  .object({
    ...page,
    method: interviewMethodSchema.optional(),
    subject,
    competency: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const insightsDetailInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();

export const insightsProgressInputSchema = z
  .object({ method: interviewMethodSchema.optional(), subject })
  .strict();

// --- Sessions and questions ------------------------------------------------

const counts = z
  .object({
    questions: countSchema(),
    answered: countSchema(),
    reviewed: countSchema(),
    scored: countSchema(),
    unscored: countSchema(),
  })
  .strict();

export const insightsSessionSchema = z
  .object({
    id: z.string().uuid(),
    subject: z.string(),
    method: interviewMethodSchema,
    status: interviewStatusSchema,
    targetRole: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    updatedAt: z.string(),
    questionCount: z.number().int().nullable(),
    counts,
  })
  .strict();
export type InsightsSession = z.infer<typeof insightsSessionSchema>;

export const insightsSessionsOutputSchema = z
  .object({
    items: z.array(insightsSessionSchema).max(PAGE_LIMIT_MAX),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();

export const insightsQuestionSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    roundId: z.string().uuid(),
    roundOrdinal: z.number().int(),
    kind: questionKindSchema(),
    reassessmentOfRoundId: z.string().uuid().nullable(),
    question: z.string(),
    competency: z.string().nullable(),
    subject: z.string(),
    method: interviewMethodSchema,
    createdAt: z.string(),
    answered: z.boolean(),
    decision: interviewReviewDecisionSchema.nullable(),
  })
  .strict();
export type InsightsQuestion = z.infer<typeof insightsQuestionSchema>;

export const insightsQuestionsOutputSchema = z
  .object({
    items: z.array(insightsQuestionSchema).max(PAGE_LIMIT_MAX),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();

// --- Session detail ---------------------------------------------------------

const detailQuestion = z
  .object({
    id: z.string().uuid(),
    kind: questionKindSchema(),
    question: z.string(),
    competency: z.string().nullable(),
    createdAt: z.string(),
    answer: z.string().nullable(),
  })
  .strict();

/** A round with its questions/answers and any committed review or coaching. */
const detailRound = z
  .object({
    id: z.string().uuid(),
    ordinal: z.number().int(),
    reassessmentOfRoundId: z.string().uuid().nullable(),
    questions: z.array(detailQuestion).max(MAX_QUESTIONS_PER_ROUND),
    review: interviewReviewViewSchema.nullable(),
    coaching: interviewCoachingViewSchema.nullable(),
  })
  .strict();

export const insightsDetailOutputSchema = z
  .object({
    session: interviewSessionSchema,
    bar: approvedOrProvisionalBarSchema.nullable(),
    rounds: z.array(detailRound).max(MAX_ROUNDS_PER_SESSION),
  })
  .strict();
export type InsightsDetail = z.infer<typeof insightsDetailOutputSchema>;

// --- Progress ---------------------------------------------------------------

export const insightsProgressRowSchema = z
  .object({
    sessionId: z.string().uuid(),
    subject: z.string(),
    method: interviewMethodSchema,
    status: interviewStatusSchema,
    completedAt: z.string().nullable(),
    barKey: z.string().nullable(),
    roundId: z.string().uuid().nullable(),
    competency: z.string().nullable(),
    reassessmentOfRoundId: z.string().uuid().nullable(),
    decision: interviewReviewDecisionSchema.nullable(),
    score: percentScoreSchema().nullable(),
  })
  .strict();
export type InsightsProgressRow = z.infer<typeof insightsProgressRowSchema>;

export const insightsPointSchema = z
  .object({
    sessionId: z.string().uuid(),
    completedAt: z.string(),
    score: percentScoreSchema(),
    scoredRoundCount: z.number().int().positive(),
  })
  .strict();
export type InsightsPoint = z.infer<typeof insightsPointSchema>;

export const insightsProgressOutputSchema = z
  .object({
    subject: z.string().nullable(),
    method: interviewMethodSchema.nullable(),
    sessions: countSchema(),
    scoredRounds: countSchema(),
    unscoredRounds: countSchema(),
    pendingRounds: countSchema(),
    reassessments: countSchema(),
    pass: countSchema(),
    fail: countSchema(),
    averageScore: percentScoreSchema().nullable(),
    points: z.array(insightsPointSchema).max(MAX_PROGRESS_POINTS),
    variedBars: z.boolean(),
    limited: z.boolean(),
  })
  .strict();
export type InsightsProgress = z.infer<typeof insightsProgressOutputSchema>;
