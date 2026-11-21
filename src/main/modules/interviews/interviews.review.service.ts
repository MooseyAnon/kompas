import {
  INTERVIEW_COACH_PROMPT_VERSION,
  INTERVIEW_PARALLEL_PROMPT_VERSION,
  INTERVIEW_REVIEW_PROMPT_VERSION,
  type ApprovedOrProvisionalBar,
  type GenerationRequestInput,
  type GenerationResult,
  type InterviewAnswersSubmitInput,
  type InterviewAnswersSubmitOutput,
  type InterviewCoachingRunOutput,
  type InterviewCoachingView,
  type InterviewQuestionView,
  type InterviewReassessmentGenerateOutput,
  type InterviewReviewView,
  type InterviewReviewsGetOutput,
  type InterviewReviewsRunOutput,
  type InterviewSession,
  type JsonValue,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { TelemetryService } from '../telemetry/telemetry.service';
import {
  buildQuestionMessages,
  questionResponseFormat,
  validateGeneratedQuestion,
  type ValidatedQuestion,
} from './interviews.question-prompt';
import {
  buildCoachMessages,
  buildCoachRepairMessage,
  coachResponseFormat,
  validateCoaching,
  type ValidatedCoaching,
} from './interviews.coach-prompt';
import {
  buildReviewMessages,
  buildReviewRepairMessage,
  reviewResponseFormat,
  validateReview,
  type ReviewComputation,
} from './interviews.review-prompt';
import type { InterviewAudioCoordinator } from './interviews.audio';
import type {
  AnswerAudioLink,
  DeepLoopRoundRecord,
  InterviewsRepository,
} from './interviews.repository';
import {
  DEFAULT_REASSESSMENT_CAP,
  reassessmentChainHasCycle,
} from './interviews.workflow';
import {
  collectConfirmedFacts,
  newId,
  now,
  parseBar,
  recordTelemetry,
  sessionNotFound,
  shorten,
  type InterviewsIdentityReader,
  type InterviewsInferenceClient,
  type TelemetryDetail,
  type TelemetryOutcome,
} from './interviews.shared';
import {
  feedbackGaps,
  offlineProvenance,
  parseCoaching,
  parseFeedback,
  parseSnapshot,
  type BarKind,
  type StoredCoaching,
  type StoredCriterion,
  type StoredFeedback,
  type StoredProvenance,
} from './interviews.review-codec';

/** Narrow inference surface the deep-loop service needs (shared with 007.1). */
export interface InterviewInferenceClient extends InterviewsInferenceClient {}

/** Minimal read-only identity context used only to ground a parallel question. */
export interface IdentityContextReader extends InterviewsIdentityReader {}

export interface InterviewReviewServiceDeps {
  repository: InterviewsRepository;
  identity: IdentityContextReader;
  inference?: InterviewInferenceClient;
  audio?: InterviewAudioCoordinator;
  telemetry?: TelemetryService;
}

/** Prior questions are truncated to this length when excluded from prompts. */
const EXCLUDED_QUESTION_MAX_CHARS = 160;

/** At most this many rubric lines are shown for a reassessment question. */
const REASSESSMENT_RUBRIC_SUMMARY_LIMIT = 5;

/** Token-overlap ratio above which two questions count as near-duplicates. */
const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.8;

/** One first attempt plus at most one bounded repair attempt. */
const MAX_GENERATION_ATTEMPTS = 2;

const ALREADY_ANSWERED_MESSAGE =
  'This question has already been answered. Answers cannot be changed.';

const QUESTION_NOT_FOUND_MESSAGE = 'That question could not be found.';

/** Telemetry context for committing an answer without lifecycle promotion. */
interface SimpleAnswerMeta {
  method: string;
  sessionStatus: InterviewAnswersSubmitOutput['sessionStatus'];
  phase: string | null;
  startedAt: string;
}

/**
 * In-process Deep Loop review/coaching/reassessment service (stage 007.2).
 *
 * It commits a user's answer before any inference, runs a separate versioned
 * reviewer prompt and computes the weighted pass/fail deterministically against
 * the frozen bar, conditionally coaches only a genuinely failed round, and
 * generates one materially distinct linked reassessment question. No model may
 * alter the session bar, a committed review or a verified profile; it uses the
 * injected provider-neutral inference service with an empty tool allowlist.
 */
export class InterviewReviewService {
  private readonly repository: InterviewsRepository;
  private readonly identity: IdentityContextReader;
  private readonly inference?: InterviewInferenceClient;
  private readonly audio?: InterviewAudioCoordinator;
  private readonly telemetry?: TelemetryService;
  /** Per-round in-flight guard against concurrent review/coaching generation. */
  private readonly inFlight = new Set<string>();
  private readonly granularCalls = new Map<string, Set<AbortController>>();
  private onQuickFireAnswer?: (sessionId: string, roundId: string) => void;

  constructor(deps: InterviewReviewServiceDeps) {
    this.repository = deps.repository;
    this.identity = deps.identity;
    this.inference = deps.inference;
    this.audio = deps.audio;
    this.telemetry = deps.telemetry;
  }

  /** Granular IPC calls share the session cancellation boundary with the workflow. */
  async runGranular<T>(
    sessionId: string,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const calls =
      this.granularCalls.get(sessionId) ?? new Set<AbortController>();
    calls.add(controller);
    this.granularCalls.set(sessionId, calls);

    try {
      return await call(controller.signal);
    } finally {
      calls.delete(controller);
      if (calls.size === 0) this.granularCalls.delete(sessionId);
    }
  }

  abortSession(sessionId: string): void {
    for (const controller of this.granularCalls.get(sessionId) ?? []) {
      controller.abort();
    }
  }

  setQuickFireAnswerHandler(
    handler: (sessionId: string, roundId: string) => void,
  ): void {
    this.onQuickFireAnswer = handler;
  }

  isActive(): boolean {
    return this.inFlight.size > 0;
  }

  /**
   * Commit one answer before review. Durably persists the answer (immutable,
   * no duplicate), promoting a `draft` deep-loop session to `active` on its
   * first primary answer. Quick-fire primary answers and deep-loop follow-up
   * answers are committed without any lifecycle promotion (the interactive
   * runner owns those transitions).
   */
  submitAnswer(
    input: InterviewAnswersSubmitInput,
  ): InterviewAnswersSubmitOutput {
    const startedAt = now();
    const session = this.repository.getSession(input.sessionId);
    if (!session) {
      throw sessionNotFound();
    }

    if (session.status === 'completed' || session.status === 'abandoned') {
      throw new AppError(
        'CONFLICT',
        'This interview is no longer in progress.',
      );
    }

    const resolved = this.repository.resolveQuestionRound(
      input.sessionId,
      input.questionId,
    );
    if (!resolved) {
      throw new AppError('NOT_FOUND', QUESTION_NOT_FOUND_MESSAGE);
    }

    if (resolved.hasAnswer) {
      throw new AppError('CONFLICT', ALREADY_ANSWERED_MESSAGE);
    }

    // Stage 008.3: validate any optional audio association against the Audio
    // façade BEFORE the answer transaction. A forged/stale/cross-recording id
    // fails closed here; the review pipeline still receives only `answerText`.
    const audio = this.resolveAudioLink(input);
    const meta: SimpleAnswerMeta = {
      method: session.method,
      sessionStatus: session.status,
      phase: session.phase,
      startedAt,
    };

    // Quick-fire reviews are independent and scheduled after each durable answer.
    if (session.method === 'quick_fire') {
      return this.submitQuickFireAnswer(input, session, resolved, audio, meta);
    }

    // Deep-loop follow-up: committed in-place; the runner moves the phase on.
    if (resolved.kind === 'follow_up') {
      if (session.status !== 'active') {
        throw new AppError(
          'CONFLICT',
          'Start the interview before answering follow-up questions.',
        );
      }

      return this.commitSimpleAnswer(
        input,
        resolved,
        'in_progress',
        audio,
        meta,
      );
    }

    return this.submitDeepLoopPrimaryAnswer(input, session, audio, startedAt);
  }

  /** The committed review and coaching (if any) for a round. */
  getRoundReview(
    sessionId: string,
    roundId: string,
  ): InterviewReviewsGetOutput {
    const round = this.loadRound(sessionId, roundId);
    const session = this.repository.getSession(sessionId);
    const isHiddenQuickFire =
      session?.method === 'quick_fire' &&
      !this.repository.getPublication(sessionId);
    if (isHiddenQuickFire) {
      return { review: null, coaching: null };
    }

    const reviewRow = this.repository.getReviewByRound(round.roundId);
    const review = reviewRow ? this.toReviewView(reviewRow) : null;
    const coachingRow = this.repository.getCoachingByRound(round.roundId);
    const coaching = coachingRow ? this.toCoachingView(coachingRow) : null;

    return { review, coaching };
  }

  /** Trusted in-process synthesis reads held reviews; never a renderer command. */
  getRoundReviewForSynthesis(
    sessionId: string,
    roundId: string,
  ): InterviewReviewView {
    this.loadRound(sessionId, roundId);
    const row = this.repository.getReviewByRound(roundId);
    if (!row) throw new AppError('CONFLICT', 'Review is not ready.');

    return this.toReviewView(row);
  }

  /**
   * Evaluate one answered round against the frozen bar. Idempotent: a committed
   * review is returned as-is and never duplicated. The application computes the
   * weighted score/decision; the model only proposes per-criterion assessment.
   */
  async reviewRound(
    sessionId: string,
    roundId: string,
    signal?: AbortSignal,
  ): Promise<InterviewReviewsRunOutput> {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw sessionNotFound();
    }

    if (session.method === 'quick_fire') {
      throw new AppError(
        'CONFLICT',
        'Quick-fire interviews cannot be reviewed one question at a time yet.',
      );
    }

    return this.evaluateRound(session, roundId, signal);
  }

  /**
   * Un-gated review used by the interactive session runner (e.g. the quick-fire
   * batch assessment). Same deterministic, application-computed scoring against
   * the frozen bar as {@link reviewRound}; never writes a second review.
   */
  async reviewRoundForSession(
    sessionId: string,
    roundId: string,
    signal?: AbortSignal,
    expectedEpoch?: number,
  ): Promise<InterviewReviewsRunOutput> {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw sessionNotFound();
    }

    return this.evaluateRound(session, roundId, signal, expectedEpoch);
  }

  /**
   * Generate coaching for a genuinely failed round. Idempotent and independent
   * of the review: a coaching failure leaves the answer and review intact.
   */
  async generateCoaching(
    sessionId: string,
    roundId: string,
    signal?: AbortSignal,
    operationEpoch?: number,
  ): Promise<InterviewCoachingRunOutput> {
    const startedAt = now();
    const expectedEpoch =
      operationEpoch ?? this.repository.generationEpoch(sessionId);
    const round = this.loadRound(sessionId, roundId);
    const feedbackJson = this.assertCoachable(sessionId, round);

    const existing = this.repository.getCoachingByRound(round.roundId);
    if (existing) {
      return { coaching: this.toCoachingView(existing) };
    }

    if (round.answerText === null) {
      throw new AppError('CONFLICT', 'The answer for this round is missing.');
    }

    const guard = `coach:${round.roundId}:${expectedEpoch}`;
    if (this.inFlight.has(guard)) {
      throw new AppError(
        'CONFLICT',
        'Coaching is already being generated for this question.',
      );
    }

    this.inFlight.add(guard);
    try {
      const raced = this.repository.getCoachingByRound(round.roundId);
      if (raced) {
        return { coaching: this.toCoachingView(raced) };
      }

      return await this.generateAndPersistCoaching(
        round,
        round.answerText,
        feedbackJson,
        { signal, expectedEpoch, startedAt },
      );
    } finally {
      this.inFlight.delete(guard);
    }
  }

  /**
   * Generate a materially distinct reassessment question in a new linked round.
   * Requires a failed, coached round and enforces the reassessment-chain cap,
   * same-session and cycle checks. The session bar and prior rounds are never
   * modified.
   */
  async generateReassessment(
    sessionId: string,
    failedRoundId: string,
    signal?: AbortSignal,
    operationEpoch?: number,
  ): Promise<InterviewReassessmentGenerateOutput> {
    const startedAt = now();
    const expectedEpoch =
      operationEpoch ?? this.repository.generationEpoch(sessionId);
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw sessionNotFound();
    }

    if (session.method === 'quick_fire')
      throw new AppError(
        'CONFLICT',
        'Reassessment is not available for Quick-fire.',
      );

    const round = this.loadRound(sessionId, failedRoundId);
    this.assertReassessable(sessionId, round);

    const guard = `reassess:${round.roundId}:${expectedEpoch}`;
    if (this.inFlight.has(guard)) {
      throw new AppError(
        'CONFLICT',
        'A new question is already being generated for this competency.',
      );
    }

    this.inFlight.add(guard);
    try {
      const bar = parseBar(session.barSnapshot);
      if (!bar) {
        throw new AppError(
          'CONFLICT',
          'This interview has no assessment benchmark, so a new question ' +
            'cannot be generated.',
        );
      }

      return await this.generateAndPersistReassessment(session, round, bar, {
        signal,
        expectedEpoch,
        startedAt,
      });
    } finally {
      this.inFlight.delete(guard);
    }
  }

  // --- internals ------------------------------------------------------------

  private submitQuickFireAnswer(
    input: InterviewAnswersSubmitInput,
    session: InterviewSession,
    resolved: { roundId: string; kind: string },
    audio: AnswerAudioLink | undefined,
    meta: SimpleAnswerMeta,
  ): InterviewAnswersSubmitOutput {
    if (resolved.kind !== 'primary') {
      throw new AppError(
        'CONFLICT',
        'Only the primary question can be answered in this stage.',
      );
    }

    if (session.status !== 'active') {
      throw new AppError(
        'CONFLICT',
        'Start the interview before answering its questions.',
      );
    }

    const committed = this.commitSimpleAnswer(
      input,
      resolved,
      'awaiting_review',
      audio,
      meta,
    );
    this.onQuickFireAnswer?.(input.sessionId, committed.roundId);

    return committed;
  }

  /** Deep-loop primary: the existing promotion path (draft -> active). */
  private submitDeepLoopPrimaryAnswer(
    input: InterviewAnswersSubmitInput,
    session: InterviewSession,
    audio: AnswerAudioLink | undefined,
    startedAt: string,
  ): InterviewAnswersSubmitOutput {
    try {
      const result = this.repository.submitAnswer({
        sessionId: input.sessionId,
        questionId: input.questionId,
        answerId: newId(),
        answerText: input.answerText,
        audio,
        now: now(),
      });
      this.record('answers.submit', startedAt, 'success', {
        method: session.method,
        sessionStatus: result.sessionStatus,
      });

      return result;
    } catch (error) {
      this.failAnswerCommit(input, startedAt, error);
    }
  }

  /**
   * Resolve and validate an optional answer audio association against the Audio
   * façade. Returns a persistable link (with a fresh id) or undefined when the
   * answer is typed-only. A forged, stale or cross-recording id fails closed.
   */
  private resolveAudioLink(
    input: InterviewAnswersSubmitInput,
  ): AnswerAudioLink | undefined {
    if (!input.audio) {
      return undefined;
    }

    if (!this.audio) {
      throw new AppError(
        'INVALID_INPUT',
        'Voice answers are not available in this build.',
      );
    }

    const recordingId = this.audio.assertReadyRecording(
      input.audio.recordingId,
    );
    const transcriptId = input.audio.transcriptId ?? null;
    if (transcriptId !== null) {
      this.audio.assertTranscriptForRecording(transcriptId, recordingId);
    }

    return { id: newId(), recordingId, transcriptId };
  }

  /** Commit a quick-fire primary or deep-loop follow-up answer in place. */
  private commitSimpleAnswer(
    input: InterviewAnswersSubmitInput,
    resolved: { roundId: string },
    roundStatus: 'awaiting_review' | 'in_progress',
    audio: AnswerAudioLink | undefined,
    meta: SimpleAnswerMeta,
  ): InterviewAnswersSubmitOutput {
    const answerId = newId();
    try {
      this.repository.commitAnswer({
        roundId: resolved.roundId,
        sessionId: input.sessionId,
        questionId: input.questionId,
        answerId,
        answerText: input.answerText,
        roundStatus,
        audio,
        now: now(),
      });
    } catch (error) {
      this.failAnswerCommit(input, meta.startedAt, error);
    }

    this.record('answers.submit', meta.startedAt, 'success', {
      method: meta.method,
      sessionStatus: meta.sessionStatus,
    });

    return {
      answerId,
      roundId: resolved.roundId,
      sessionStatus: meta.sessionStatus,
      phase: meta.phase,
    };
  }

  /**
   * Translate a failed answer write. A racing duplicate loses the unique answer
   * key and surfaces as the usual "already answered" conflict (unrecorded);
   * anything else is recorded and rethrown as a safe AppError.
   */
  private failAnswerCommit(
    input: InterviewAnswersSubmitInput,
    startedAt: string,
    error: unknown,
  ): never {
    const existing = this.repository.resolveQuestionRound(
      input.sessionId,
      input.questionId,
    );
    if (existing?.hasAnswer) {
      throw new AppError('CONFLICT', ALREADY_ANSWERED_MESSAGE);
    }

    this.record('answers.submit', startedAt, 'failure', {
      errorCode: error instanceof AppError ? error.code : 'INTERNAL',
    });
    throw error instanceof AppError ? error : new AppError('INTERNAL');
  }

  private async evaluateRound(
    session: InterviewSession,
    roundId: string,
    signal?: AbortSignal,
    operationEpoch?: number,
  ): Promise<InterviewReviewsRunOutput> {
    const startedAt = now();
    const sessionId = session.id;
    const expectedEpoch =
      operationEpoch ?? this.repository.generationEpoch(sessionId);
    const round = this.loadRound(sessionId, roundId);

    // Idempotent: never write a second review for a round.
    const existing = this.repository.getReviewByRound(round.roundId);
    if (existing) {
      return { review: this.toReviewView(existing) };
    }

    if (round.answerText === null || round.answerId === null) {
      throw new AppError(
        'CONFLICT',
        'Submit an answer before requesting a review.',
      );
    }

    const bar = parseBar(session.barSnapshot);
    if (!bar) {
      return this.persistMissingBarReview(round, expectedEpoch, startedAt);
    }

    const guard = `review:${round.roundId}:${expectedEpoch}`;
    if (this.inFlight.has(guard)) {
      throw new AppError(
        'CONFLICT',
        'A review is already being generated for this question.',
      );
    }

    this.inFlight.add(guard);
    try {
      // Re-check after acquiring the guard (defends against a replay race).
      const raced = this.repository.getReviewByRound(round.roundId);
      if (raced) {
        return { review: this.toReviewView(raced) };
      }

      return await this.generateAndPersistReview(round, round.answerText, bar, {
        signal,
        expectedEpoch,
        startedAt,
      });
    } finally {
      this.inFlight.delete(guard);
    }
  }

  /** No usable bar: record a truthful unscored review, never a fake score. */
  private persistMissingBarReview(
    round: DeepLoopRoundRecord,
    expectedEpoch: number,
    startedAt: string,
  ): InterviewReviewsRunOutput {
    const view = this.persistReview(
      round,
      {
        decision: 'unscored',
        score: null,
        criteria: [],
        strengths: [],
        gaps: [],
        needsMoreEvidence: false,
        unscoredReason: 'missing_bar',
        barKind: null,
        passThreshold: null,
        provenance: offlineProvenance('unscored'),
      },
      expectedEpoch,
    );
    this.record('reviews.run', startedAt, 'success', {});

    return { review: view };
  }

  private async generateAndPersistReview(
    round: DeepLoopRoundRecord,
    answerText: string,
    bar: ApprovedOrProvisionalBar,
    context: GenerationContext,
  ): Promise<InterviewReviewsRunOutput> {
    const { signal, expectedEpoch, startedAt } = context;
    const model = await this.resolveModel();
    const run = await this.runReviewGeneration(
      round,
      answerText,
      bar,
      model,
      signal,
    );

    if (signal?.aborted)
      throw new AppError('CONFLICT', 'Review cancelled. Retry when ready.');

    if (run.kind === 'error') {
      this.record('reviews.run', startedAt, 'failure', {
        errorCode: 'CONFLICT',
        providerId: model.providerId,
        modelId: model.modelId,
      });
      throw new AppError('CONFLICT', reviewFailureMessage(run.errorCode));
    }

    const provenance = this.provenanceFor(
      model,
      INTERVIEW_REVIEW_PROMPT_VERSION,
      run.requestId,
      run.kind === 'valid' ? 'passed' : 'unscored',
    );

    if (run.kind === 'unscored') {
      const view = this.persistReview(
        round,
        unscoredReviewData(bar, run.reason, provenance),
        expectedEpoch,
      );
      this.record('reviews.run', startedAt, 'success', {
        providerId: model.providerId,
        modelId: model.modelId,
        retried: run.retried,
      });

      return { review: view };
    }

    const view = this.persistReview(
      round,
      scoredReviewData(bar, run.value, provenance),
      expectedEpoch,
    );
    this.record('reviews.run', startedAt, 'success', {
      providerId: model.providerId,
      modelId: model.modelId,
      promptVersion: INTERVIEW_REVIEW_PROMPT_VERSION,
      retried: run.retried,
    });

    return { review: view };
  }

  private async runReviewGeneration(
    round: DeepLoopRoundRecord,
    answerText: string,
    bar: ApprovedOrProvisionalBar,
    model: ResolvedModel,
    signal: AbortSignal | undefined,
  ): Promise<GenRun<ReviewComputation>> {
    const followUps = this.repository
      .listRoundQnA(round.roundId)
      .flatMap((x) =>
        x.kind === 'follow_up' && x.answer !== null
          ? [{ question: x.question, answer: x.answer }]
          : [],
      );

    // Evidence may be quoted from the primary answer or any follow-up reply.
    const answerHaystack = [answerText, ...followUps.map((f) => f.answer)].join(
      '\n',
    );
    const messages = buildReviewMessages({
      question: round.questionText,
      answer: answerText,
      bar,
      followUps,
    });

    return this.runGeneration(
      model,
      messages,
      buildReviewRepairMessage(),
      reviewResponseFormat,
      true,
      signal,
      (output): Classification<ReviewComputation> => {
        const result = validateReview(output, bar, answerHaystack);
        if ('ok' in result && result.ok) {
          return { kind: 'valid', value: result.value };
        }

        if ('kind' in result && result.kind === 'unscored') {
          return { kind: 'unscored', reason: result.reason };
        }

        return { kind: 'retry' };
      },
    );
  }

  /** Only a failed, reviewed deep-loop round can be coached. */
  private assertCoachable(
    sessionId: string,
    round: DeepLoopRoundRecord,
  ): string {
    if (this.repository.getSession(sessionId)?.method === 'quick_fire')
      throw new AppError(
        'CONFLICT',
        'Coaching is not available for Quick-fire.',
      );

    const review = this.repository.getReviewByRound(round.roundId);
    if (!review) {
      throw new AppError('CONFLICT', 'Review the answer before coaching.');
    }

    if (review.decision !== 'fail') {
      throw new AppError(
        'CONFLICT',
        'Coaching is only available for an answer that scored below the bar.',
      );
    }

    return review.feedbackJson;
  }

  private async generateAndPersistCoaching(
    round: DeepLoopRoundRecord,
    answerText: string,
    feedbackJson: string,
    context: GenerationContext,
  ): Promise<InterviewCoachingRunOutput> {
    const { signal, expectedEpoch, startedAt } = context;
    const gaps = feedbackGaps(feedbackJson);
    const model = await this.resolveModel();
    const messages = buildCoachMessages({
      question: round.questionText,
      answer: answerText,
      gaps,
      competency: round.competency ?? 'general',
    });
    const run = await this.runGeneration(
      model,
      messages,
      buildCoachRepairMessage(),
      coachResponseFormat,
      false,
      signal,
      (output): Classification<ValidatedCoaching> => {
        const result = validateCoaching(output);

        return result.ok
          ? { kind: 'valid', value: result.value }
          : { kind: 'retry' };
      },
    );

    if (signal?.aborted)
      throw new AppError('CONFLICT', 'Coaching cancelled. Retry when ready.');

    if (run.kind !== 'valid') {
      this.record('coaching.run', startedAt, 'failure', {
        errorCode: 'CONFLICT',
        providerId: model.providerId,
        modelId: model.modelId,
      });
      throw new AppError(
        'CONFLICT',
        'The local model could not produce coaching. Please try again.',
      );
    }

    const provenance = this.provenanceFor(
      model,
      INTERVIEW_COACH_PROMPT_VERSION,
      run.requestId,
      'passed',
    );
    const stored: StoredCoaching = {
      schemaVersion: 1,
      diagnosis: run.value.diagnosis,
      advice: run.value.advice,
      workedExample: run.value.workedExample,
      reassessmentFocus: run.value.reassessmentFocus,
      provenance,
    };
    this.repository.insertCoaching({
      id: newId(),
      roundId: round.roundId,
      content: stored,
      now: now(),
      expectedEpoch,
    });
    this.record('coaching.run', startedAt, 'success', {
      providerId: model.providerId,
      modelId: model.modelId,
      promptVersion: INTERVIEW_COACH_PROMPT_VERSION,
      retried: run.retried,
    });

    const saved = this.repository.getCoachingByRound(round.roundId);
    if (!saved) {
      throw new AppError('INTERNAL');
    }

    return { coaching: this.toCoachingView(saved) };
  }

  /**
   * A reassessment needs a failed, coached round under the chain cap, without
   * a cycle and without an existing sibling reassessment.
   */
  private assertReassessable(
    sessionId: string,
    round: DeepLoopRoundRecord,
  ): void {
    const review = this.repository.getReviewByRound(round.roundId);
    if (!review || review.decision !== 'fail') {
      throw new AppError(
        'CONFLICT',
        'A similar question is only offered after a failed review.',
      );
    }

    const coaching = this.repository.getCoachingByRound(round.roundId);
    if (!coaching) {
      throw new AppError('CONFLICT', 'Review the coaching before continuing.');
    }

    const depth = this.repository.reassessmentDepth(round.roundId);
    if (depth >= DEFAULT_REASSESSMENT_CAP) {
      throw new AppError(
        'CONFLICT',
        'You have reached the practice limit for this competency. Take some ' +
          'time to study this topic, then start a fresh interview.',
      );
    }

    const hasCycle = reassessmentChainHasCycle(round.roundId, (id) =>
      this.repository.parentRoundId(id),
    );
    if (hasCycle) {
      throw new AppError(
        'CONFLICT',
        'This question cannot be reassessed. Start a fresh interview.',
      );
    }

    // One linked reassessment per failed round; siblings would bypass the cap.
    if (this.hasReassessment(sessionId, round.roundId)) {
      throw new AppError(
        'CONFLICT',
        'A similar question was already created for this answer. Answer it ' +
          'to continue.',
      );
    }
  }

  private async generateAndPersistReassessment(
    session: InterviewSession,
    round: DeepLoopRoundRecord,
    bar: ApprovedOrProvisionalBar,
    context: GenerationContext,
  ): Promise<InterviewReassessmentGenerateOutput> {
    const { signal, startedAt } = context;
    const sessionId = session.id;
    const priorQuestions = this.repository.listPrimaryQuestionTexts(sessionId);
    const model = await this.resolveModel();
    const run = await this.runReassessmentGeneration(
      session,
      round,
      bar,
      priorQuestions,
      model,
      signal,
    );

    if (signal?.aborted)
      throw new AppError('CONFLICT', 'Question cancelled. Retry when ready.');

    if (run.kind !== 'valid') {
      this.record('reassessment.generate', startedAt, 'failure', {
        errorCode: 'CONFLICT',
        providerId: model.providerId,
        modelId: model.modelId,
      });
      throw new AppError(
        'CONFLICT',
        'The local model could not produce a sufficiently different ' +
          'question. Please try again.',
      );
    }

    return this.persistReassessment(sessionId, round, model, run, context);
  }

  /** Insert the linked reassessment round and return its public view. */
  private persistReassessment(
    sessionId: string,
    round: DeepLoopRoundRecord,
    model: ResolvedModel,
    run: Extract<GenRun<ValidatedQuestion>, { kind: 'valid' }>,
    context: GenerationContext,
  ): InterviewReassessmentGenerateOutput {
    const { expectedEpoch, startedAt } = context;
    const validated = run.value;
    const roundIdNew = newId();
    const questionId = newId();
    const createdAt = now();
    const publicProvenance = {
      origin: 'generated',
      providerId: model.providerId,
      modelId: model.modelId,
      promptVersion: INTERVIEW_PARALLEL_PROMPT_VERSION,
      sourceBasis: validated.sourceBasis,
      validation: 'passed',
      generatedAt: createdAt,
    } satisfies InterviewQuestionView['provenance'];

    this.repository.insertReassessment({
      sessionId,
      failedRoundId: round.roundId,
      roundId: roundIdNew,
      questionId,
      questionText: validated.question,
      competency: validated.competency,
      rubric: validated.rubric,
      source: {
        schemaVersion: 1,
        origin: 'generated',
        providerId: model.providerId,
        modelId: model.modelId,
        promptVersion: INTERVIEW_PARALLEL_PROMPT_VERSION,
        inferenceRequestId: run.requestId,
        sourceBasis: validated.sourceBasis,
        validation: 'passed',
        generatedAt: createdAt,
        reassessmentOfRoundId: round.roundId,
      },
      now: createdAt,
      expectedEpoch,
    });
    this.record('reassessment.generate', startedAt, 'success', {
      providerId: model.providerId,
      modelId: model.modelId,
      promptVersion: INTERVIEW_PARALLEL_PROMPT_VERSION,
      retried: run.retried,
    });

    const question: InterviewQuestionView = {
      id: questionId,
      roundId: roundIdNew,
      question: validated.question,
      competency: validated.competency,
      createdAt,
      rubricSummary: validated.rubricSummary.slice(
        0,
        REASSESSMENT_RUBRIC_SUMMARY_LIMIT,
      ),
      provenance: publicProvenance,
    };

    return { newRoundId: roundIdNew, question };
  }

  private async runReassessmentGeneration(
    session: InterviewSession,
    round: DeepLoopRoundRecord,
    bar: ApprovedOrProvisionalBar,
    priorQuestions: string[],
    model: ResolvedModel,
    signal: AbortSignal | undefined,
  ): Promise<GenRun<ValidatedQuestion>> {
    const baseMessages = buildQuestionMessages({
      subject: session.subject,
      target: session.targetSnapshot,
      facts: collectConfirmedFacts(this.identity),
      bar,
      excludeQuestions: priorQuestions.map((q) =>
        shorten(q, EXCLUDED_QUESTION_MAX_CHARS),
      ),
      guidance: session.additionalGuidance,
    });
    const competency = round.competency ?? 'general';
    const steering = {
      role: 'user' as const,
      content:
        `Generate a NEW question assessing the same competency ` +
        `"${competency}" but a materially different scenario. It must not ` +
        `repeat or merely paraphrase any question listed above.`,
    };
    const messages = [...baseMessages, steering];

    return this.runGeneration(
      model,
      messages,
      steering,
      questionResponseFormat,
      false,
      signal,
      (output): Classification<ValidatedQuestion> => {
        const result = validateGeneratedQuestion(output);
        if (!result.ok) {
          return { kind: 'retry' };
        }

        if (isNearDuplicate(result.value.question, priorQuestions)) {
          return { kind: 'retry' };
        }

        return { kind: 'valid', value: result.value };
      },
    );
  }

  private hasReassessment(sessionId: string, failedRoundId: string): boolean {
    return this.repository
      .listSessionRounds(sessionId)
      .some((r) => r.reassessmentOfRoundId === failedRoundId);
  }

  private loadRound(sessionId: string, roundId: string): DeepLoopRoundRecord {
    const round = this.repository.getDeepLoopRound(sessionId, roundId);
    if (!round) {
      throw new AppError('NOT_FOUND', QUESTION_NOT_FOUND_MESSAGE);
    }
    return round;
  }

  private async resolveModel(): Promise<ResolvedModel> {
    if (!this.inference) {
      throw new AppError(
        'CONFLICT',
        'Local AI is not configured. Open Local AI settings to set it up.',
      );
    }
    const snapshot = await this.inference.getSettingsSnapshot();
    const { providerId, modelId } = snapshot.settings;
    if (!providerId || !modelId) {
      throw new AppError(
        'CONFLICT',
        'Select an installed local model in Local AI settings first.',
      );
    }

    const resolved = snapshot.resolvedModel;
    if (!resolved || !resolved.installed || resolved.locality !== 'local') {
      throw new AppError(
        'CONFLICT',
        'The selected local model is not available. Open Local AI settings ' +
          'to pick an installed local model.',
      );
    }

    return { providerId, modelId };
  }

  /**
   * Run a read-only generation with at most one bounded repair retry. Structural
   * failures are retried once; a persistent provider/structural failure returns
   * `error` (the caller raises a retryable CONFLICT). A classifier may report
   * `unscored` for a usable-but-unassessable review.
   */
  private async runGeneration<T>(
    model: ResolvedModel,
    baseMessages: GenerationRequestInput['messages'],
    repairMessage: GenerationRequestInput['messages'][number],
    responseFormat: GenerationRequestInput['responseFormat'],
    thinking: boolean,
    signal: AbortSignal | undefined,
    classify: (output: JsonValue) => Classification<T>,
  ): Promise<GenRun<T>> {
    let unscored: {
      reason: string;
      requestId: string;
      retried: boolean;
    } | null = null;
    let errorCode: string | null = null;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) return { kind: 'error', errorCode: 'CANCELLED' };
      const messages =
        attempt === 0 ? baseMessages : [...baseMessages, repairMessage];
      const result = await this.callGenerate(
        model,
        messages,
        responseFormat,
        thinking,
        signal,
      );
      if (result.status === 'completed') {
        const classification = classify((result.output ?? null) as JsonValue);
        if (classification.kind === 'valid') {
          return {
            kind: 'valid',
            value: classification.value,
            requestId: result.requestId,
            retried: attempt > 0,
          };
        }
        if (classification.kind === 'unscored' && unscored === null) {
          unscored = {
            reason: classification.reason,
            requestId: result.requestId,
            retried: attempt > 0,
          };
        }
        // 'retry' (or a first 'unscored') falls through to a second attempt.
        continue;
      }
      if (!isRetryableStatus(result)) {
        errorCode =
          result.error?.code === 'RETRIES_EXHAUSTED'
            ? (result.lastErrorCode ?? null)
            : (result.error?.code ?? null);
        break;
      }
    }

    if (unscored) {
      return {
        kind: 'unscored',
        reason: unscored.reason,
        requestId: unscored.requestId,
        retried: unscored.retried,
      };
    }
    return { kind: 'error', errorCode };
  }

  private async callGenerate(
    model: ResolvedModel,
    messages: GenerationRequestInput['messages'],
    responseFormat: GenerationRequestInput['responseFormat'],
    thinking: boolean,
    signal?: AbortSignal,
  ): Promise<GenerationResult> {
    if (!this.inference) {
      throw new AppError('CONFLICT', 'Local AI is not configured.');
    }
    return this.inference.generate({
      callerModule: 'interviews',
      execution: { priority: 'normal', signal },
      providerId: model.providerId,
      modelId: model.modelId,
      messages,
      thinking,
      responseFormat,
      toolNames: [],
    });
  }

  private persistReview(
    round: DeepLoopRoundRecord,
    data: ReviewPersist,
    expectedEpoch: number,
  ): InterviewReviewView {
    const feedback: StoredFeedback = {
      schemaVersion: 1,
      criteria: data.criteria,
      strengths: data.strengths,
      gaps: data.gaps,
      needsMoreEvidence: data.needsMoreEvidence,
      unscoredReason: data.unscoredReason,
      provenance: data.provenance,
    };
    const rubricSnapshot =
      data.barKind !== null
        ? {
            schemaVersion: 1,
            barKind: data.barKind,
            passThreshold: data.passThreshold,
            criteria: data.criteria.map((c) => ({
              id: c.id,
              label: c.label,
              weight: c.weight,
            })),
          }
        : null;
    const id = newId();
    const createdAt = now();
    this.repository.insertReview({
      id,
      roundId: round.roundId,
      decision: data.decision,
      score: data.score,
      feedback,
      rubricSnapshot,
      now: createdAt,
      expectedEpoch,
    });
    const saved = this.repository.getReviewByRound(round.roundId);
    if (!saved) {
      throw new AppError('INTERNAL');
    }
    return this.toReviewView(saved);
  }

  private provenanceFor(
    model: ResolvedModel,
    promptVersion: string,
    requestId: string,
    validation: 'passed' | 'unscored',
  ): StoredProvenance {
    return {
      providerId: model.providerId,
      modelId: model.modelId,
      promptVersion,
      validation,
      generatedAt: now(),
      inferenceRequestId: requestId,
    };
  }

  private toReviewView(row: {
    id: string;
    roundId: string;
    decision: 'pass' | 'fail' | 'unscored';
    score: number | null;
    feedbackJson: string;
    rubricSnapshotJson: string | null;
    createdAt: string;
  }): InterviewReviewView {
    const feedback = parseFeedback(row.feedbackJson);
    const snapshot = parseSnapshot(row.rubricSnapshotJson);
    return {
      id: row.id,
      roundId: row.roundId,
      decision: row.decision,
      score: row.score,
      provisional: true,
      barKind: snapshot?.barKind ?? null,
      passThreshold: snapshot?.passThreshold ?? null,
      criteria: feedback.criteria.map((c) => ({
        id: c.id,
        label: c.label,
        weight: c.weight,
        score: c.score,
        evidence: c.evidence,
        rationale: c.rationale,
      })),
      strengths: feedback.strengths,
      gaps: feedback.gaps,
      needsMoreEvidence: feedback.needsMoreEvidence,
      unscoredReason: feedback.unscoredReason,
      modelProvenance: {
        providerId: feedback.provenance.providerId,
        modelId: feedback.provenance.modelId,
        promptVersion: feedback.provenance.promptVersion,
        validation: feedback.provenance.validation,
        generatedAt: feedback.provenance.generatedAt,
      },
      createdAt: row.createdAt,
    };
  }

  private toCoachingView(row: {
    id: string;
    roundId: string;
    contentJson: string;
    createdAt: string;
  }): InterviewCoachingView {
    const content = parseCoaching(row.contentJson);
    return {
      id: row.id,
      roundId: row.roundId,
      diagnosis: content.diagnosis,
      advice: content.advice,
      workedExample: content.workedExample,
      reassessmentFocus: content.reassessmentFocus,
      modelProvenance: {
        providerId: content.provenance.providerId,
        modelId: content.provenance.modelId,
        promptVersion: content.provenance.promptVersion,
        validation: content.provenance.validation,
        generatedAt: content.provenance.generatedAt,
      },
      createdAt: row.createdAt,
    };
  }

  private record(
    operation: string,
    startedAt: string,
    outcome: TelemetryOutcome,
    detail: TelemetryDetail,
  ): void {
    recordTelemetry(this.telemetry, operation, startedAt, outcome, detail);
  }
}

interface ResolvedModel {
  providerId: string;
  modelId: string;
}

interface GenerationContext {
  signal: AbortSignal | undefined;
  expectedEpoch: number;
  startedAt: string;
}

interface ReviewPersist {
  decision: 'pass' | 'fail' | 'unscored';
  score: number | null;
  criteria: StoredCriterion[];
  strengths: string[];
  gaps: string[];
  needsMoreEvidence: boolean;
  unscoredReason: string | null;
  barKind: BarKind | null;
  passThreshold: number | null;
  provenance: StoredProvenance;
}

type Classification<T> =
  | { kind: 'valid'; value: T }
  | { kind: 'unscored'; reason: string }
  | { kind: 'retry' };

type GenRun<T> =
  | { kind: 'valid'; value: T; requestId: string; retried: boolean }
  | { kind: 'unscored'; reason: string; requestId: string; retried: boolean }
  | { kind: 'error'; errorCode: string | null };

/** Only structural-output failures are worth one bounded retry. */
function isRetryableStatus(result: GenerationResult): boolean {
  if (result.status === 'cancelled') {
    return false;
  }
  const code = result.error?.code;
  return code === 'INVALID_SCHEMA' || code === 'INVALID_RESPONSE';
}

function reviewFailureMessage(errorCode: string | null): string {
  if (errorCode === 'CAPABILITY_UNSUPPORTED') {
    return (
      'The selected local model does not support thinking-enabled reviews. ' +
      'Select a capable model in Local AI settings.'
    );
  }

  return (
    'The local model could not produce a usable review. Please check Local ' +
    'AI settings and try again.'
  );
}

function unscoredReviewData(
  bar: ApprovedOrProvisionalBar,
  reason: string,
  provenance: StoredProvenance,
): ReviewPersist {
  return {
    decision: 'unscored',
    score: null,
    criteria: bar.criteria.map((c) => ({
      id: c.id,
      label: c.label,
      weight: c.weight,
      score: null,
      evidence: null,
      rationale: null,
    })),
    strengths: [],
    gaps: [],
    needsMoreEvidence: reason === 'model_needs_more_evidence',
    unscoredReason: reason,
    barKind: bar.kind,
    passThreshold: bar.passThreshold,
    provenance,
  };
}

function scoredReviewData(
  bar: ApprovedOrProvisionalBar,
  computed: ReviewComputation,
  provenance: StoredProvenance,
): ReviewPersist {
  return {
    decision: computed.decision,
    score: computed.score,
    criteria: computed.criteria.map((c) => ({
      id: c.id,
      label: c.label,
      weight: c.weight,
      score: c.score,
      evidence: c.evidence,
      rationale: c.rationale,
    })),
    strengths: computed.strengths,
    gaps: computed.gaps,
    needsMoreEvidence: false,
    unscoredReason: null,
    barKind: bar.kind,
    passThreshold: bar.passThreshold,
    provenance,
  };
}

/**
 * Bounded near-duplicate check: identical after normalisation, or a token
 * Jaccard overlap above 0.8. This is a practical guard, not a semantic promise.
 */
function isNearDuplicate(candidate: string, existing: string[]): boolean {
  const normCandidate = normalise(candidate);
  const candTokens = tokenSet(candidate);
  for (const prior of existing) {
    if (normalise(prior) === normCandidate) {
      return true;
    }
    const priorTokens = tokenSet(prior);
    if (jaccard(candTokens, priorTokens) > NEAR_DUPLICATE_JACCARD_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalise(value)
      .split(' ')
      .filter((t) => t.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}
