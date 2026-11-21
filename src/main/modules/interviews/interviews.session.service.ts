import {
  DEEP_LOOP_FOLLOW_UP_BUDGET,
  INTERVIEW_FOLLOW_UP_PROMPT_VERSION,
  INTERVIEW_QUESTION_PROMPT_VERSION,
  PROGRESS_TEXT_MAX,
  QUICK_FIRE_MIN_COUNT,
  interviewQuestionProvenanceSchema,
  interviewSessionSummarySchemaResult,
  type ApprovedOrProvisionalBar,
  type GenerationEvent,
  type GenerationRequestInput,
  type GenerationResult,
  type InterviewMethod,
  type InterviewAnswersSubmitInput,
  type InterviewQuestionProvenance,
  type InterviewQuestionView,
  type InterviewSession,
  type InterviewSessionsAdvanceOutput,
  type InterviewSessionSummaryResult,
  type InterviewSessionsFinishInput,
  type InterviewSessionsFinishOutput,
  type InterviewSessionsProgressOutput,
  type InterviewSessionsStartOutput,
  type InterviewSessionsTranscriptOutput,
  type InterviewTranscriptTurn,
  type InterviewDeepLoopGuidance,
  type InterviewWorkflowAction,
  type InterviewWorkflowContinueInput,
  type InterviewWorkflowState,
  type JsonValue,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { TelemetryService } from '../telemetry/telemetry.service';
import {
  buildProvisionalBar,
  buildQuestionMessages,
  buildRepairMessage,
  questionResponseFormat,
  validateGeneratedQuestion,
  type QuestionRubric,
  type ValidatedQuestion,
} from './interviews.question-prompt';
import {
  buildFollowUpMessages,
  buildFollowUpRepairMessage,
} from './interviews.followup-prompt';
import type {
  InterviewsRepository,
  QuestionDetailRow,
  SessionRoundRow,
} from './interviews.repository';
import type { InterviewReviewService } from './interviews.review.service';
import {
  DEFAULT_REASSESSMENT_CAP,
  deepLoopReviewedChoices,
} from './interviews.workflow';
import {
  buildSynthesisMessages,
  synthesisResponseFormat,
  validateNarrative,
  SYNTHESIS_VERSION,
} from './interviews.synthesis-prompt';
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

/** The inference surface the session runner depends on. */
export interface SessionInferenceClient extends InterviewsInferenceClient {}

/** Read-only identity context used only to minimally ground a question. */
export interface IdentityContextReader extends InterviewsIdentityReader {}

export interface InterviewSessionServiceDeps {
  repository: InterviewsRepository;
  reviews: InterviewReviewService;
  identity: IdentityContextReader;
  inference?: SessionInferenceClient;
  telemetry?: TelemetryService;
}

/** Upper bound on transcript turns returned in one response. */
const TRANSCRIPT_ITEM_CAP = 512;

/** Prior question texts are shortened to this length in exclusion lists. */
const EXCLUDED_QUESTION_MAX = 160;

/** Rubric criteria are shortened to this length in question views. */
const RUBRIC_SUMMARY_MAX = 200;

/** Generation attempts: the first call plus one repair retry. */
const QUESTION_ATTEMPTS = 2;

/** Synthesis attempts: the first call plus one repair retry. */
const SYNTHESIS_ATTEMPTS = 2;

/** Average scores are rounded to one decimal place. */
const SCORE_PRECISION = 10;

const CANCELLED_MESSAGE = 'The operation was cancelled.';

type OperationKind =
  | 'preparing'
  | 'follow_up'
  | 'next_question'
  | 'assessing'
  | 'reviewing'
  | 'coaching'
  | 'reassessing';

interface SessionOperation {
  id: string;
  sessionId: string;
  kind: OperationKind;
  /**
   * Deep Loop: the round this operation acts on (for a next question, the
   * round being moved on from; null for the first question). Lets a settled
   * failure be matched to the current durable state before offering `retry`.
   */
  roundId: string | null;
  status: 'running' | 'failed' | 'cancelled' | 'completed';
  progressText: string;
  requestId: string | null;
  controller: AbortController;
  errorMessage: string | null;
  startedAt: string;
  settled: boolean;
  epoch: number;
}

type SynthesisNarrative = NonNullable<ReturnType<typeof validateNarrative>>;

interface SynthesisOutcome {
  narrative: SynthesisNarrative | null;
  provenance: {
    providerId: string;
    modelId: string;
    promptVersion: string;
    validation: 'passed';
    generatedAt: string;
  } | null;
}

const EMPTY_SYNTHESIS: SynthesisOutcome = {
  narrative: null,
  provenance: null,
};

interface ResolvedModel {
  providerId: string;
  modelId: string;
}

/**
 * Interactive interview session runner (stage 007.3). Owns the application
 * state machine for the text-only Quick-fire and Deep Loop workflows: it starts
 * a session (generating durable, validated questions), tracks one cancellable
 * in-flight model operation per session with bounded ephemeral streamed
 * progress, advances method-specific transitions, derives an honest summary
 * from persisted reviews, and produces a chronological transcript.
 *
 * The model only ever returns bounded, validated task outputs; the runner (not
 * the model) decides every transition. No partial/cancelled generation is
 * persisted as durable truth, and no review ever mutates the frozen bar or the
 * canonical professional identity.
 */
export class InterviewSessionService {
  private readonly repository: InterviewsRepository;
  private readonly reviews: InterviewReviewService;
  private readonly identity: IdentityContextReader;
  private readonly inference?: SessionInferenceClient;
  private readonly telemetry?: TelemetryService;
  /** At most one in-flight model operation per session. */
  private readonly operations = new Map<string, SessionOperation>();
  private readonly reviewOperations = new Map<string, SessionOperation>();
  private readonly resumedSessions = new Set<string>();

  constructor(deps: InterviewSessionServiceDeps) {
    this.repository = deps.repository;
    this.reviews = deps.reviews;
    this.identity = deps.identity;
    this.inference = deps.inference;
    this.telemetry = deps.telemetry;

    this.reviews.setQuickFireAnswerHandler((sessionId, roundId) => {
      this.scheduleQuickFireReview(sessionId, roundId);
    });
  }

  isActive(): boolean {
    return [
      ...this.operations.values(),
      ...this.reviewOperations.values(),
    ].some((operation) => !operation.settled);
  }

  // --- sessions.start -------------------------------------------------------

  start(sessionId: string): InterviewSessionsStartOutput {
    const startedAt = now();
    const session = this.requireSession(sessionId);
    const finished =
      session.status === 'completed' || session.status === 'abandoned';
    if (finished) {
      throw new AppError(
        'CONFLICT',
        'This interview has already finished. ' +
          'Start a new one to practise again.',
      );
    }

    this.resumeAfterRestart(session);

    const bar = this.freezeBar(session);
    const rounds = this.repository.listSessionRounds(sessionId);

    if (session.method === 'quick_fire') {
      return this.startQuickFire(session, rounds, bar, startedAt);
    }

    return this.startDeepLoop(session, rounds, startedAt);
  }

  // --- sessions.progress ----------------------------------------------------

  progress(sessionId: string): InterviewSessionsProgressOutput {
    const session = this.requireSession(sessionId);
    const rounds = this.repository.listSessionRounds(sessionId);
    const op = this.quickFireOperation(sessionId, session.method);
    const running = op?.status === 'running';

    const questionCount =
      session.method === 'quick_fire'
        ? (session.questionCount ?? rounds.length)
        : rounds.length;
    const answeredCount = rounds.filter((r) => r.primaryAnswered).length;
    const reviewedCount = rounds.filter(
      (r) => r.reviewDecision !== null,
    ).length;

    const operationStatus: InterviewSessionsProgressOutput['operationStatus'] =
      running
        ? 'running'
        : op?.status === 'failed'
          ? 'failed'
          : op?.status === 'cancelled'
            ? 'cancelled'
            : 'idle';

    const canSubmit =
      (session.method === 'quick_fire' || !running) &&
      (session.phase === 'answering' || session.phase === 'follow_up');
    const canRetry =
      !running && (op?.status === 'failed' || op?.status === 'cancelled');

    return {
      phase: session.phase,
      operationStatus,
      progressText:
        running && session.method !== 'quick_fire'
          ? clampProgress(op?.progressText ?? '')
          : null,
      operation: running
        ? session.method === 'quick_fire'
          ? 'working'
          : (op?.kind ?? null)
        : null,
      errorMessage: running ? null : (op?.errorMessage ?? null),
      questionCount,
      answeredCount,
      reviewedCount,
      canSubmit,
      canRetry,
    };
  }

  /**
   * A read-only projection: polling never starts inference or changes a
   * phase.
   */
  getState(sessionId: string): InterviewWorkflowState {
    const session = this.requireSession(sessionId);
    const rounds = this.repository.listSessionRounds(sessionId);
    const progress = this.progress(sessionId);
    const op = this.quickFireOperation(sessionId, session.method);
    const running = op !== undefined && !op.settled;
    const terminal =
      session.status === 'completed' || session.status === 'abandoned';
    const active = rounds.at(-1);

    const currentQuestion = this.currentQuestionFor(session, rounds, running);
    const actions = this.workflowActions(
      session,
      rounds,
      op,
      currentQuestion !== null,
    );

    progress.canSubmit = actions.includes('answer');
    progress.canRetry = actions.includes('retry');

    const feedback =
      session.method === 'deep_loop' &&
      active?.reviewDecision !== null &&
      active
        ? this.reviews.getRoundReview(sessionId, active.roundId)
        : null;

    return {
      session:
        session.method === 'quick_fire' &&
        !this.repository.getPublication(sessionId)
          ? { ...session, barSnapshot: null }
          : session,
      currentQuestion:
        currentQuestion &&
        session.method === 'quick_fire' &&
        !this.repository.getPublication(sessionId)
          ? { ...currentQuestion, rubricSummary: null }
          : currentQuestion,
      progress,
      operationId: running ? op.id : null,
      availableActions: actions,
      feedback,
      result:
        terminal &&
        (session.method !== 'quick_fire' ||
          this.repository.getPublication(sessionId))
          ? this.publishedSummary(session, rounds)
          : null,
      ...(session.method === 'deep_loop'
        ? { deepLoop: this.deepLoopGuidance(active) }
        : {}),
    };
  }

  /** The question awaiting an answer, if the workflow can accept one now. */
  private currentQuestionFor(
    session: InterviewSession,
    rounds: SessionRoundRow[],
    running: boolean,
  ): InterviewQuestionView | null {
    const acceptsAnswers =
      session.status === 'active' &&
      (!running || session.method === 'quick_fire');
    if (!acceptsAnswers) return null;

    const active = rounds.at(-1);
    const pending =
      session.method === 'quick_fire'
        ? rounds.find((round) => !round.primaryAnswered)
        : active && !active.primaryAnswered
          ? active
          : null;
    if (pending) {
      return this.questionView(session.id, pending.primaryQuestionId);
    }

    const followUpPending =
      session.method === 'deep_loop' &&
      active?.primaryAnswered &&
      active.followUpTotal > active.followUpAnswered;
    if (!followUpPending) return null;

    const followUp = this.repository.getUnansweredFollowUp(active.roundId);

    return followUp ? this.detailToView(followUp) : null;
  }

  private workflowActions(
    session: InterviewSession,
    rounds: SessionRoundRow[],
    op: SessionOperation | undefined,
    hasQuestion: boolean,
  ): InterviewWorkflowAction[] {
    const terminal =
      session.status === 'completed' || session.status === 'abandoned';

    if (session.status === 'draft') return ['start', 'abandon'];
    if (terminal) return [];
    if (isPausedPhase(session.phase)) return ['continue', 'abandon'];
    if (session.method === 'deep_loop') {
      return this.deepLoopActions(rounds, op, hasQuestion);
    }

    return this.quickFireActions(session, rounds, op, hasQuestion);
  }

  private quickFireActions(
    session: InterviewSession,
    rounds: SessionRoundRow[],
    op: SessionOperation | undefined,
    hasQuestion: boolean,
  ): InterviewWorkflowAction[] {
    const actions: InterviewWorkflowAction[] = [];
    const running = op !== undefined && !op.settled;
    const settledFailure =
      (op?.status === 'failed' || op?.status === 'cancelled') &&
      op.settled === true;

    if (hasQuestion) {
      actions.push('answer');
      if (settledFailure) actions.push('retry');
    } else if (settledFailure) {
      actions.push('retry');
    } else if (
      this.allQuickFireRoundsReviewed(session, rounds) &&
      !this.hasUnsettledQuickFireReviews(session.id)
    ) {
      actions.push('request_results');
    } else {
      actions.push('continue');
    }

    const allAnswered =
      rounds.length === session.questionCount &&
      rounds.every((r) => r.primaryAnswered);
    if (allAnswered && !actions.includes('request_results')) {
      actions.push('request_results');
    }

    if (running) actions.push('pause');
    actions.push('abandon');

    return actions;
  }

  private allQuickFireRoundsReviewed(
    session: InterviewSession,
    rounds: SessionRoundRow[],
  ): boolean {
    return (
      rounds.length === session.questionCount &&
      rounds.length > 0 &&
      rounds.every((r) => r.primaryAnswered && r.reviewDecision !== null)
    );
  }

  /**
   * Deep Loop `availableActions` derived from durable round state plus the
   * latest settled operation. A failure only offers `retry` when it belongs to
   * the current round, so a stale failure can never advertise an illegal move.
   */
  private deepLoopActions(
    rounds: SessionRoundRow[],
    op: SessionOperation | undefined,
    hasQuestion: boolean,
  ): InterviewWorkflowAction[] {
    if (op && !op.settled) return ['pause', 'abandon'];
    const active = rounds.at(-1);
    const failure = this.deepLoopFailure(op, active);
    const actions: InterviewWorkflowAction[] = [];

    if (hasQuestion) {
      actions.push('answer');
    } else if (!active) {
      actions.push(failure ? 'retry' : 'continue');
    } else if (active.reviewDecision === null) {
      // Answered and awaiting a follow-up or review.
      if (failure) actions.push('retry');
      // A failed optional follow-up may be skipped; a failed review may not.
      if (!failure || failure.kind === 'follow_up') actions.push('continue');
    } else {
      if (failure) actions.push('retry');
      actions.push(
        ...deepLoopReviewedChoices({
          decision: active.reviewDecision,
          coached: active.hasCoaching,
          reassessmentDepth: this.repository.reassessmentDepth(active.roundId),
        }),
      );
    }
    actions.push('abandon');
    return actions;
  }

  /** The latest failed/cancelled Deep Loop operation if it targets `active`. */
  private deepLoopFailure(
    op: SessionOperation | undefined,
    active: SessionRoundRow | undefined,
  ): SessionOperation | null {
    if (!op || !op.settled) return null;
    if (op.status !== 'failed' && op.status !== 'cancelled') return null;
    if (op.roundId !== (active?.roundId ?? null)) return null;
    const expected: OperationKind[] =
      active === undefined
        ? ['next_question']
        : active.reviewDecision === null
          ? ['follow_up', 'reviewing']
          : ['coaching', 'reassessing', 'next_question'];
    return expected.includes(op.kind) ? op : null;
  }

  private deepLoopGuidance(
    active: SessionRoundRow | undefined,
  ): InterviewDeepLoopGuidance | null {
    if (!active) return null;

    const depth = this.repository.reassessmentDepth(active.roundId);
    let recommendation: string | null = null;
    if (active.reviewDecision === 'fail' && depth >= DEFAULT_REASSESSMENT_CAP) {
      recommendation =
        'You reached the practice limit for this competency. ' +
        'Take time to study it, then request your results or start a fresh ' +
        'interview.';
    } else if (active.reviewDecision === 'unscored') {
      recommendation =
        'This answer could not be scored against the bar. ' +
        'Continue with a fresh question or request your results.';
    }

    return {
      roundId: active.roundId,
      isReassessment: active.reassessmentOfRoundId !== null,
      followUpLimit: plannedFollowUps(active),
      followUpsAsked: active.followUpTotal,
      reassessmentDepth: depth,
      reassessmentCap: DEFAULT_REASSESSMENT_CAP,
      recommendation,
    };
  }

  submitWorkflowAnswer(
    input: InterviewAnswersSubmitInput,
  ): InterviewWorkflowState {
    const state = this.getState(input.sessionId);
    if (
      !state.availableActions.includes('answer') ||
      state.currentQuestion?.id !== input.questionId
    ) {
      throw new AppError(
        'CONFLICT',
        'This question is not ready for an answer. Refresh the interview.',
      );
    }
    this.reviews.submitAnswer(input);
    // The immutable answer is committed before scheduling any dependent work.
    if (state.session.method === 'deep_loop')
      this.startDeepLoopStep(input.sessionId);
    return this.getState(input.sessionId);
  }

  continueWorkflow(
    input: InterviewWorkflowContinueInput,
  ): InterviewWorkflowState {
    const state = this.getState(input.sessionId);
    if (!state.availableActions.includes(input.action)) {
      throw new AppError(
        'CONFLICT',
        'That action is not available for this interview. Refresh its state.',
      );
    }
    const session = state.session;
    if (isPausedPhase(session.phase) && input.action === 'continue') {
      this.start(input.sessionId);
      return this.getState(input.sessionId);
    }
    if (session.method === 'deep_loop') {
      this.chooseDeepLoopAction(input.sessionId, input.action);
      return this.getState(input.sessionId);
    }

    const rounds = this.repository.listSessionRounds(input.sessionId);
    this.resumeQuickFireReviews(input.sessionId, input.action === 'retry');
    if (
      rounds.length < requireQuickFireCount(session) &&
      !this.hasRunningOp(input.sessionId)
    ) {
      const bar = parseBar(this.requireSession(input.sessionId).barSnapshot);
      if (bar)
        this.runOperation(input.sessionId, 'preparing', (op) =>
          this.fillQuickFireQuestions(
            op,
            input.sessionId,
            bar,
            requireQuickFireCount(session),
          ),
        );
    }
    return this.getState(input.sessionId);
  }

  // --- Deep Loop orchestration ----------------------------------------------

  /** Run one Deep Loop intent already validated against `availableActions`. */
  private chooseDeepLoopAction(
    sessionId: string,
    action: InterviewWorkflowContinueInput['action'],
  ): void {
    const active = this.repository.listSessionRounds(sessionId).at(-1);
    const failure = this.deepLoopFailure(
      this.operations.get(sessionId),
      active,
    );

    if (action === 'continue') {
      // After a failed optional follow-up, `continue` skips it and reviews now.
      if (failure?.kind === 'follow_up')
        this.repository.setPhase(sessionId, 'awaiting_review', now());
      this.startDeepLoopStep(sessionId, failure?.kind === 'follow_up');
      return;
    }
    if (action === 'retry') {
      this.retryDeepLoopStep(sessionId, failure, active);
      return;
    }
    if (!active) {
      throw new AppError('CONFLICT', 'Answer a question first.');
    }
    if (action === 'request_coaching') {
      this.startDeepLoopCoaching(sessionId, active);
    } else {
      this.startDeepLoopReassessment(sessionId, active);
    }
  }

  /** `retry` re-runs exactly the failed step for the current round. */
  private retryDeepLoopStep(
    sessionId: string,
    failure: SessionOperation | null,
    active: SessionRoundRow | undefined,
  ): void {
    if (!active || failure?.kind === 'next_question') {
      this.startDeepLoopQuestion(sessionId, active);
      return;
    }
    switch (failure?.kind) {
      case 'follow_up':
        this.startDeepLoopFollowUp(sessionId, active);
        return;
      case 'reviewing':
        this.startDeepLoopReview(sessionId, active);
        return;
      case 'coaching':
        this.startDeepLoopCoaching(sessionId, active);
        return;
      case 'reassessing':
        this.startDeepLoopReassessment(sessionId, active);
        return;
      default:
        throw new AppError('CONFLICT', 'There is nothing to retry.');
    }
  }

  /**
   * Start the next automatic Deep Loop step from durable state: the first or
   * next independent question, the policy-permitted follow-up, or the review
   * once every asked question is answered. Coaching and reassessment are never
   * automatic; they need an explicit user choice.
   */
  private startDeepLoopStep(sessionId: string, skipFollowUp = false): void {
    const active = this.repository.listSessionRounds(sessionId).at(-1);
    if (!active || active.reviewDecision !== null) {
      this.startDeepLoopQuestion(sessionId, active);
      return;
    }
    const awaitingAnswer =
      !active.primaryAnswered || active.followUpTotal > active.followUpAnswered;
    if (awaitingAnswer) return;
    if (!skipFollowUp && active.followUpTotal < plannedFollowUps(active)) {
      this.startDeepLoopFollowUp(sessionId, active);
      return;
    }
    this.startDeepLoopReview(sessionId, active);
  }

  /** Generate a new independent primary question (`thinking:false`). */
  private startDeepLoopQuestion(
    sessionId: string,
    previous: SessionRoundRow | undefined,
  ): string {
    const bar = this.requireBar(sessionId);
    const priorTexts = this.repository
      .listSessionRounds(sessionId)
      .map((r) => r.primaryQuestionText);
    const ordinal = this.repository.maxRoundOrdinal(sessionId) + 1;
    return this.startDeepLoopOperation(
      sessionId,
      'next_question',
      previous?.roundId ?? null,
      'preparing',
      (op) =>
        this.generatePrimaryRound(op, sessionId, bar, ordinal, priorTexts),
    );
  }

  /** Generate the round's bounded follow-up (`thinking:false`). */
  private startDeepLoopFollowUp(
    sessionId: string,
    active: SessionRoundRow,
  ): string {
    const bar = this.requireBar(sessionId);
    return this.startDeepLoopOperation(
      sessionId,
      'follow_up',
      active.roundId,
      'follow_up',
      (op) => this.generateFollowUp(op, sessionId, active, bar),
    );
  }

  /** Review the round's complete Q&A (`thinking:true`, app-computed score). */
  private startDeepLoopReview(
    sessionId: string,
    active: SessionRoundRow,
  ): string {
    return this.startDeepLoopOperation(
      sessionId,
      'reviewing',
      active.roundId,
      'awaiting_review',
      async (op) => {
        await this.reviews.reviewRoundForSession(
          sessionId,
          active.roundId,
          op.controller.signal,
          op.epoch,
        );
        if (!operationStopped(op))
          this.repository.setPhase(sessionId, 'reviewed', now(), op.epoch);
      },
    );
  }

  private startDeepLoopCoaching(
    sessionId: string,
    active: SessionRoundRow,
  ): string {
    return this.startDeepLoopOperation(
      sessionId,
      'coaching',
      active.roundId,
      'reviewed',
      async (op) => {
        await this.reviews.generateCoaching(
          sessionId,
          active.roundId,
          op.controller.signal,
          op.epoch,
        );
        if (!operationStopped(op))
          this.repository.setPhase(sessionId, 'coached', now(), op.epoch);
      },
    );
  }

  /** A linked, materially different question (`thinking:false`, capped). */
  private startDeepLoopReassessment(
    sessionId: string,
    active: SessionRoundRow,
  ): string {
    return this.startDeepLoopOperation(
      sessionId,
      'reassessing',
      active.roundId,
      'coached',
      async (op) => {
        await this.reviews.generateReassessment(
          sessionId,
          active.roundId,
          op.controller.signal,
          op.epoch,
        );
        if (!operationStopped(op))
          this.repository.setPhase(sessionId, 'answering', now(), op.epoch);
      },
    );
  }

  /**
   * One in-flight Deep Loop operation per session; the phase is saved
   * first.
   */
  private startDeepLoopOperation(
    sessionId: string,
    kind: OperationKind,
    roundId: string | null,
    phase: string,
    run: (op: SessionOperation) => Promise<void>,
  ): string {
    if (this.hasRunningOp(sessionId)) return this.operations.get(sessionId)!.id;
    this.repository.setPhase(sessionId, phase, now());
    return this.runOperation(sessionId, kind, run, roundId);
  }

  private requireBar(sessionId: string): ApprovedOrProvisionalBar {
    const bar = parseBar(this.requireSession(sessionId).barSnapshot);
    if (!bar) {
      throw new AppError(
        'CONFLICT',
        'Start the interview before continuing it.',
      );
    }
    return bar;
  }

  requestResults(sessionId: string): InterviewWorkflowState {
    const state = this.getState(sessionId);
    if (state.session.status === 'completed') return state;
    if (isPausedPhase(state.session.phase)) return state;
    if (state.session.method === 'quick_fire') {
      if (state.session.status !== 'active')
        throw new AppError('CONFLICT', 'Start the interview first.');
      this.resumeQuickFireReviews(sessionId);
      const rounds = this.repository.listSessionRounds(sessionId);
      if (
        rounds.length !== state.session.questionCount ||
        !rounds.every((r) => r.primaryAnswered && r.reviewDecision !== null) ||
        this.hasUnsettledQuickFireReviews(sessionId) ||
        this.hasRunningOp(sessionId)
      )
        return this.getState(sessionId);
      if (!this.hasRunningOp(sessionId))
        this.runOperation(sessionId, 'assessing', (op) =>
          this.publishQuickFire(op, sessionId),
        );
      return this.getState(sessionId);
    }
    if (!state.availableActions.includes('request_results')) {
      throw new AppError(
        'CONFLICT',
        'Results are not ready. Finish answering and reviewing first.',
      );
    }
    this.finish({ sessionId, outcome: 'completed' });
    return this.getState(sessionId);
  }

  pause(sessionId: string): InterviewWorkflowState {
    const session = this.requireSession(sessionId);
    if (session.status === 'active' && !isPausedPhase(session.phase)) {
      this.repository.invalidateGeneration(
        sessionId,
        session.phase === 'awaiting_review' ? 'paused_review' : 'paused',
      );
      this.abortOperation(sessionId);
      this.abortQuickFireReviews(sessionId);
      this.reviews.abortSession(sessionId);
    }
    return this.getState(sessionId);
  }

  // --- sessions.advance -----------------------------------------------------

  advance(sessionId: string): InterviewSessionsAdvanceOutput {
    const startedAt = now();
    const session = this.requireSession(sessionId);
    if (session.status !== 'active') {
      throw new AppError(
        'CONFLICT',
        'Start the interview before advancing it.',
      );
    }
    if (isPausedPhase(session.phase)) {
      throw new AppError(
        'CONFLICT',
        'Resume the interview before advancing it.',
      );
    }

    // A running operation owns the next transition; never start a second one.
    const running = this.quickFireOperation(sessionId, session.method);
    if (running && !running.settled && session.method !== 'quick_fire') {
      return this.advanceOutput(sessionId, null, session.phase, running.id);
    }

    const bar = parseBar(session.barSnapshot);
    const rounds = this.repository.listSessionRounds(sessionId);

    if (session.method === 'quick_fire') {
      return this.advanceQuickFire(session, rounds, bar, startedAt);
    }
    return this.advanceDeepLoop(session, rounds, bar, startedAt);
  }

  // --- sessions.finish ------------------------------------------------------

  finish(input: InterviewSessionsFinishInput): InterviewSessionsFinishOutput {
    const startedAt = now();
    const session = this.requireSession(input.sessionId);
    const rounds = this.repository.listSessionRounds(input.sessionId);
    const summary = this.buildSummary(session, rounds);

    if (session.status === 'completed' || session.status === 'abandoned') {
      // Idempotent: already finished.
      return {
        session: this.publicSession(session),
        summary: this.publicSummary(session, summary),
      };
    }

    if (input.outcome === 'completed' && session.method === 'quick_fire') {
      throw new AppError(
        'CONFLICT',
        'Request Quick-fire results to publish the final assessment.',
      );
    }
    if (input.outcome === 'completed') {
      if (summary.answeredCount === 0) {
        throw new AppError(
          'CONFLICT',
          'Answer at least one question before completing, ' +
            'or abandon the session instead.',
        );
      }
    }

    // Fence the DB first; an aborted provider that completes late cannot write.
    if (input.outcome === 'abandoned')
      this.repository.abandonSession(input.sessionId, now());
    else this.repository.invalidateGeneration(input.sessionId);
    this.abortOperation(input.sessionId);
    this.abortQuickFireReviews(input.sessionId);
    this.reviews.abortSession(input.sessionId);
    if (input.outcome !== 'abandoned')
      this.repository.markSessionStatus(
        input.sessionId,
        input.outcome,
        input.outcome,
        now(),
      );
    const finished = this.requireSession(input.sessionId);
    const finalSummary = this.buildSummary(finished, rounds);
    this.record('sessions.finish', startedAt, 'success', {
      method: session.method,
      outcome: input.outcome,
      reviewedCount: finalSummary.reviewedCount,
    });
    return {
      session: this.publicSession(finished),
      summary: this.publicSummary(finished, finalSummary),
    };
  }

  // --- sessions.cancelOperation ---------------------------------------------

  cancelOperation(sessionId: string): { cancelled: boolean } {
    const startedAt = now();
    this.requireSession(sessionId);
    const op = this.operations.get(sessionId);
    const reviews = [...this.reviewOperations.values()].filter(
      (item) => item.sessionId === sessionId && item.status === 'running',
    );
    if ((!op || op.status !== 'running') && reviews.length === 0) {
      return { cancelled: false };
    }
    this.repository.invalidateGeneration(sessionId);
    this.reviews.abortSession(sessionId);
    for (const item of [op, ...reviews]) {
      if (!item || item.status !== 'running') continue;
      item.status = 'cancelled';
      item.errorMessage = CANCELLED_MESSAGE;
      item.progressText = '';
      item.controller.abort();
      if (item.requestId) void this.cancelInference(item.requestId);
      item.settled = true;
    }
    this.record('sessions.cancelOperation', startedAt, 'success', {
      kind: 'workflow',
    });
    return { cancelled: true };
  }

  // --- sessions.transcript --------------------------------------------------

  transcript(sessionId: string): InterviewSessionsTranscriptOutput {
    const session = this.requireSession(sessionId);
    const rounds = this.repository.listSessionRounds(sessionId);
    const items: InterviewTranscriptTurn[] = [];

    for (const round of rounds) {
      const qna = this.repository.listRoundQnA(round.roundId);
      for (const entry of qna) {
        items.push({
          type: 'question',
          roundId: round.roundId,
          roundOrdinal: round.ordinal,
          questionKind: entry.kind,
          text: entry.question,
          competency: round.competency,
          decision: null,
          score: null,
          createdAt: session.createdAt,
        });
        if (entry.answer !== null) {
          items.push({
            type: 'answer',
            roundId: round.roundId,
            roundOrdinal: round.ordinal,
            questionKind: entry.kind,
            text: entry.answer,
            competency: null,
            decision: null,
            score: null,
            createdAt: session.createdAt,
          });
        }
      }
      const review = this.repository.getReviewByRound(round.roundId);
      if (
        review &&
        (session.method !== 'quick_fire' ||
          this.repository.getPublication(sessionId))
      ) {
        items.push({
          type: 'review',
          roundId: round.roundId,
          roundOrdinal: round.ordinal,
          questionKind: null,
          text: null,
          competency: round.competency,
          decision: review.decision,
          score: review.score,
          createdAt: review.createdAt,
        });
      }
      const coaching = this.repository.getCoachingByRound(round.roundId);
      if (coaching) {
        const parsed = safeJson(coaching.contentJson) as {
          diagnosis?: unknown;
        } | null;
        items.push({
          type: 'coaching',
          roundId: round.roundId,
          roundOrdinal: round.ordinal,
          questionKind: null,
          text:
            parsed && typeof parsed.diagnosis === 'string'
              ? parsed.diagnosis
              : null,
          competency: round.competency,
          decision: null,
          score: null,
          createdAt: coaching.createdAt,
        });
      }
    }

    const summary =
      rounds.length > 0 &&
      (session.method !== 'quick_fire' ||
        this.repository.getPublication(sessionId))
        ? this.publishedSummary(session, rounds)
        : null;
    return { items: items.slice(0, TRANSCRIPT_ITEM_CAP), summary };
  }

  // --- start helpers --------------------------------------------------------

  /**
   * An explicit start is the recovery boundary. The queue is never durable;
   * only committed rows determine which tasks need reconstruction.
   */
  private resumeAfterRestart(session: InterviewSession): void {
    const sessionId = session.id;
    const needsRecovery =
      session.status === 'active' &&
      !this.hasRunningOp(sessionId) &&
      !this.hasUnsettledQuickFireReviews(sessionId) &&
      !this.resumedSessions.has(sessionId);
    if (!needsRecovery) return;

    this.repository.invalidateGeneration(sessionId);
    this.resumedSessions.add(sessionId);
  }

  private startQuickFire(
    session: InterviewSession,
    rounds: SessionRoundRow[],
    bar: ApprovedOrProvisionalBar,
    startedAt: string,
  ): InterviewSessionsStartOutput {
    const sessionId = session.id;
    const target = requireQuickFireCount(session);

    // Promote to active so answers are accepted while filling continues.
    this.repository.markSessionStatus(
      sessionId,
      'active',
      rounds.length ? 'answering' : 'preparing',
      now(),
    );

    const missing = target - rounds.length;
    let progressId: string | null = null;
    if (missing > 0 && !this.hasRunningOp(sessionId)) {
      progressId = this.runOperation(sessionId, 'preparing', (op) =>
        this.fillQuickFireQuestions(op, sessionId, bar, target),
      );
    }

    this.resumeQuickFireReviews(sessionId, isPausedPhase(session.phase));
    this.record('sessions.start', startedAt, 'success', {
      method: session.method,
      questionCount: target,
    });

    return this.startOutput(sessionId, progressId);
  }

  private startDeepLoop(
    session: InterviewSession,
    rounds: SessionRoundRow[],
    startedAt: string,
  ): InterviewSessionsStartOutput {
    const sessionId = session.id;
    this.repository.markSessionStatus(
      sessionId,
      'active',
      rounds.length === 0 ? 'preparing' : this.deriveDeepLoopPhase(rounds),
      now(),
    );

    let progressId: string | null = null;
    if (rounds.length === 0 && !this.hasRunningOp(sessionId)) {
      progressId = this.startDeepLoopQuestion(sessionId, undefined);
    } else if (this.shouldResumeDeepLoopStep(session, rounds)) {
      const skipFollowUp =
        session.phase === 'paused_review' ||
        session.phase === 'awaiting_review';
      this.startDeepLoopStep(sessionId, skipFollowUp);
    }

    this.record('sessions.start', startedAt, 'success', {
      method: session.method,
    });

    return this.startOutput(sessionId, progressId);
  }

  /**
   * A fully answered, unreviewed round resumes its next automatic step unless
   * a live operation (not paused, not completed) already owns it.
   */
  private shouldResumeDeepLoopStep(
    session: InterviewSession,
    rounds: SessionRoundRow[],
  ): boolean {
    const active = rounds.at(-1);
    const awaitingStep =
      rounds.length > 0 &&
      active?.primaryAnswered === true &&
      active.reviewDecision === null &&
      active.followUpTotal === active.followUpAnswered;
    if (!awaitingStep || this.hasRunningOp(session.id)) return false;

    const previous = this.operations.get(session.id);

    return (
      isPausedPhase(session.phase) ||
      !previous ||
      previous.status === 'completed'
    );
  }

  // --- advance helpers ------------------------------------------------------

  private advanceQuickFire(
    session: InterviewSession,
    rounds: SessionRoundRow[],
    bar: ApprovedOrProvisionalBar | null,
    startedAt: string,
  ): InterviewSessionsAdvanceOutput {
    const target = session.questionCount ?? rounds.length;

    const nextUnanswered = rounds.find((r) => !r.primaryAnswered);
    if (nextUnanswered) {
      if (session.phase !== 'answering')
        this.setPhaseIfChanged(session, 'answering');
      const question = this.questionView(
        session.id,
        nextUnanswered.primaryQuestionId,
      );
      return this.advanceOutput(session.id, question, 'answering', null);
    }

    if (rounds.length < target) {
      if (bar && !this.hasRunningOp(session.id))
        this.runOperation(session.id, 'preparing', (op) =>
          this.fillQuickFireQuestions(op, session.id, bar, target),
        );
      return this.advanceOutput(
        session.id,
        null,
        session.phase,
        this.operations.get(session.id)?.id ?? null,
      );
    }

    // Reviews are independent and already queued for committed answers.
    const allReviewed = rounds.every((r) => r.reviewDecision !== null);
    if (!allReviewed) {
      this.resumeQuickFireReviews(session.id);
      return this.advanceOutput(session.id, null, session.phase, null);
    }

    this.setPhaseIfChanged(session, 'assessed');
    this.record('sessions.advance', startedAt, 'success', {
      method: session.method,
      phase: 'assessed',
    });
    return this.advanceOutput(session.id, null, 'assessed', null);
  }

  private advanceDeepLoop(
    session: InterviewSession,
    rounds: SessionRoundRow[],
    bar: ApprovedOrProvisionalBar | null,
    startedAt: string,
  ): InterviewSessionsAdvanceOutput {
    const active = rounds.at(-1);
    if (!active) {
      return this.advanceDeepLoopFirstQuestion(session, bar);
    }

    const pending = this.presentPendingDeepLoopQuestion(session, active);
    if (pending) return pending;

    if (active.reviewDecision === null) {
      return this.advanceUnreviewedRound(session, active, bar);
    }

    return this.advanceReviewedRound(session, active, bar, startedAt);
  }

  private advanceDeepLoopFirstQuestion(
    session: InterviewSession,
    bar: ApprovedOrProvisionalBar | null,
  ): InterviewSessionsAdvanceOutput {
    if (bar && !this.hasRunningOp(session.id)) {
      const progressId = this.startDeepLoopQuestion(session.id, undefined);

      return this.advanceOutput(session.id, null, 'preparing', progressId);
    }

    return this.advanceOutput(session.id, null, session.phase, null);
  }

  /** Present the round's unanswered primary or follow-up, if any. */
  private presentPendingDeepLoopQuestion(
    session: InterviewSession,
    active: SessionRoundRow,
  ): InterviewSessionsAdvanceOutput | null {
    // 1. Primary not answered yet → present it.
    if (!active.primaryAnswered) {
      this.setPhaseIfChanged(session, 'answering');
      const question = this.questionView(session.id, active.primaryQuestionId);

      return this.advanceOutput(session.id, question, 'answering', null);
    }

    // 2. An unanswered follow-up exists → present it.
    if (active.followUpTotal <= active.followUpAnswered) return null;

    const followUp = this.repository.getUnansweredFollowUp(active.roundId);
    if (!followUp) return null;

    this.setPhaseIfChanged(session, 'follow_up');

    return this.advanceOutput(
      session.id,
      this.detailToView(followUp),
      'follow_up',
      null,
    );
  }

  /** 3. Answered, not yet reviewed → generate a follow-up or wait. */
  private advanceUnreviewedRound(
    session: InterviewSession,
    active: SessionRoundRow,
    bar: ApprovedOrProvisionalBar | null,
  ): InterviewSessionsAdvanceOutput {
    const planned = plannedFollowUps(active);
    if (active.followUpTotal < planned && bar) {
      const progressId = this.startDeepLoopFollowUp(session.id, active);

      return this.advanceOutput(session.id, null, 'follow_up', progressId);
    }

    this.setPhaseIfChanged(session, 'awaiting_review');

    return this.advanceOutput(session.id, null, 'awaiting_review', null);
  }

  /** 4. Reviewed. Branch on the committed decision. */
  private advanceReviewedRound(
    session: InterviewSession,
    active: SessionRoundRow,
    bar: ApprovedOrProvisionalBar | null,
    startedAt: string,
  ): InterviewSessionsAdvanceOutput {
    if (active.reviewDecision === 'fail') {
      const phase = this.failedRoundPhase(active);
      this.setPhaseIfChanged(session, phase);

      return this.advanceOutput(session.id, null, phase, null);
    }

    // Pass or unscored → move on to a new independent primary question.
    if (!bar) {
      return this.advanceOutput(session.id, null, session.phase, null);
    }

    const progressId = this.startDeepLoopQuestion(session.id, active);
    this.setPhaseIfChanged(session, 'answering');
    this.record('sessions.advance', startedAt, 'success', {
      method: session.method,
      phase: 'answering',
    });

    return this.advanceOutput(session.id, null, 'answering', progressId);
  }

  private failedRoundPhase(active: SessionRoundRow): string {
    if (!active.hasCoaching) return 'reviewed';

    const depth = this.repository.reassessmentDepth(active.roundId);
    if (depth >= DEFAULT_REASSESSMENT_CAP) return 'assessed';

    // Coached and under the cap → the renderer runs reassessment.generate.
    return 'coached';
  }

  // --- operation runners ----------------------------------------------------

  /** Generate and durably persist the remaining quick-fire questions. */
  private async fillQuickFireQuestions(
    op: SessionOperation,
    sessionId: string,
    bar: ApprovedOrProvisionalBar,
    target: number,
  ): Promise<void> {
    const model = await this.resolveModel();
    let rounds = this.repository.listSessionRounds(sessionId);

    while (rounds.length < target) {
      if (operationStopped(op)) {
        return;
      }

      const existingTexts = rounds.map((r) => r.primaryQuestionText);
      const ordinal = this.repository.maxRoundOrdinal(sessionId) + 1;
      const validated = await this.generateQuestion(
        op,
        model,
        this.primaryQuestionMessages(sessionId, bar, existingTexts),
        buildRepairMessage(),
        existingTexts,
      );
      if (this.operationOutlived(op, sessionId)) return;

      this.persistPrimary(
        sessionId,
        ordinal,
        validated,
        model,
        INTERVIEW_QUESTION_PROMPT_VERSION,
        op.requestId,
        op.epoch,
      );
      rounds = this.repository.listSessionRounds(sessionId);
      if (rounds.length === 1) {
        this.repository.setPhase(sessionId, 'answering', now(), op.epoch);
      }
    }

    if (this.operationOutlived(op, sessionId)) return;

    this.repository.setPhase(
      sessionId,
      rounds.every((r) => r.primaryAnswered) ? 'awaiting_review' : 'answering',
      now(),
      op.epoch,
    );
    this.record('sessions.prepare', op.startedAt, 'success', {
      providerId: model.providerId,
      modelId: model.modelId,
      questionCount: target,
    });
  }

  /** True once the operation stopped or its session is no longer active. */
  private operationOutlived(op: SessionOperation, sessionId: string): boolean {
    return (
      operationStopped(op) || this.requireSession(sessionId).status !== 'active'
    );
  }

  /** Generate and persist one primary question in a new round. */
  private async generatePrimaryRound(
    op: SessionOperation,
    sessionId: string,
    bar: ApprovedOrProvisionalBar,
    ordinal: number,
    priorTexts: string[],
  ): Promise<void> {
    const model = await this.resolveModel();
    const validated = await this.generateQuestion(
      op,
      model,
      this.primaryQuestionMessages(sessionId, bar, priorTexts),
      buildRepairMessage(),
      priorTexts,
    );
    const resolvedOrdinal = Math.max(
      ordinal,
      this.repository.maxRoundOrdinal(sessionId) + 1,
    );
    this.persistPrimary(
      sessionId,
      resolvedOrdinal,
      validated,
      model,
      INTERVIEW_QUESTION_PROMPT_VERSION,
      op.requestId,
      op.epoch,
    );
    this.repository.setPhase(sessionId, 'answering', now(), op.epoch);
    this.record('sessions.nextQuestion', op.startedAt, 'success', {
      providerId: model.providerId,
      modelId: model.modelId,
    });
  }

  /** Prompt for a new primary question, grounded only in confirmed facts. */
  private primaryQuestionMessages(
    sessionId: string,
    bar: ApprovedOrProvisionalBar,
    priorTexts: string[],
  ): GenerationRequestInput['messages'] {
    return buildQuestionMessages({
      subject: this.subjectOf(sessionId),
      target: this.targetOf(sessionId),
      facts: collectConfirmedFacts(this.identity),
      bar,
      excludeQuestions: priorTexts.map((t) =>
        shorten(t, EXCLUDED_QUESTION_MAX),
      ),
      guidance: this.guidanceOf(sessionId),
    });
  }

  /** Generate and persist one bounded follow-up in the active round. */
  private async generateFollowUp(
    op: SessionOperation,
    sessionId: string,
    active: SessionRoundRow,
    bar: ApprovedOrProvisionalBar,
  ): Promise<void> {
    const primary = this.repository.getPrimaryQuestionDetail(
      sessionId,
      active.roundId,
    );
    const qna = this.repository.listRoundQnA(active.roundId);
    const primaryAnswer = qna.find((x) => x.kind === 'primary')?.answer ?? null;
    if (!primary || primaryAnswer === null) {
      throw new AppError('CONFLICT', 'The round is not ready for a follow-up.');
    }
    const model = await this.resolveModel();
    const competency = active.competency ?? 'general';
    const validated = await this.generateQuestion(
      op,
      model,
      buildFollowUpMessages({
        subject: this.subjectOf(sessionId),
        question: primary.questionText,
        answer: primaryAnswer,
        competency,
        bar,
        guidance: this.guidanceOf(sessionId),
      }),
      buildFollowUpRepairMessage(),
      [primary.questionText],
    );
    const ordinal = this.repository.nextQuestionOrdinal(active.roundId);
    this.repository.insertFollowUp({
      roundId: active.roundId,
      questionId: newId(),
      ordinal,
      questionText: validated.question,
      competency: validated.competency,
      rubric: validated.rubric,
      source: this.sourceProvenance(
        model,
        INTERVIEW_FOLLOW_UP_PROMPT_VERSION,
        op.requestId,
        validated.sourceBasis,
      ),
      now: now(),
      expectedEpoch: op.epoch,
    });
    this.repository.setPhase(sessionId, 'follow_up', now(), op.epoch);
    this.record('sessions.followUp', op.startedAt, 'success', {
      providerId: model.providerId,
      modelId: model.modelId,
    });
  }

  private scheduleQuickFireReview(sessionId: string, roundId: string): void {
    if (!this.canScheduleQuickFireReview(sessionId, roundId)) return;

    const op = this.createOperation(sessionId, 'reviewing');
    this.reviewOperations.set(roundId, op);
    void this.execute(op, (current) =>
      this.runQuickFireReview(current, sessionId, roundId),
    );
  }

  /**
   * A round is reviewed at most once at a time; a settled failure stays put
   * until an explicit retry clears it.
   */
  private canScheduleQuickFireReview(
    sessionId: string,
    roundId: string,
  ): boolean {
    if (
      this.requireSession(sessionId).status !== 'active' ||
      this.repository.getReviewByRound(roundId)
    )
      return false;

    const existing = this.reviewOperations.get(roundId);
    const blocked =
      existing !== undefined &&
      (!existing.settled ||
        existing.status === 'failed' ||
        existing.status === 'cancelled');

    return !blocked;
  }

  private async runQuickFireReview(
    op: SessionOperation,
    sessionId: string,
    roundId: string,
  ): Promise<void> {
    await this.reviews.reviewRoundForSession(
      sessionId,
      roundId,
      op.controller.signal,
      op.epoch,
    );
    if (this.operationOutlived(op, sessionId)) return;

    const rounds = this.repository.listSessionRounds(sessionId);
    const allReviewed =
      rounds.length === this.requireSession(sessionId).questionCount &&
      rounds.every((r) => r.reviewDecision !== null);
    if (allReviewed) {
      this.repository.setPhase(sessionId, 'assessed', now(), op.epoch);
    }
  }

  private resumeQuickFireReviews(sessionId: string, retry = false): void {
    for (const round of this.repository.listSessionRounds(sessionId)) {
      const awaitingReview =
        round.primaryAnswered && round.reviewDecision === null;
      if (!awaitingReview) continue;

      if (retry && this.reviewOperations.get(round.roundId)?.settled) {
        this.reviewOperations.delete(round.roundId);
      }
      this.scheduleQuickFireReview(sessionId, round.roundId);
    }
  }

  private async publishQuickFire(
    op: SessionOperation,
    sessionId: string,
  ): Promise<void> {
    const rounds = this.repository.listSessionRounds(sessionId);
    let synthesis: SynthesisOutcome = EMPTY_SYNTHESIS;
    try {
      const outcome = await this.synthesiseNarrative(op, sessionId, rounds);
      // A cancelled synthesis never publishes partial results.
      if (outcome === 'stopped') return;
      synthesis = outcome;
    } catch {
      // A missing model or failed synthesis does not erase genuine saved
      // reviews.
    }
    if (this.operationOutlived(op, sessionId)) return;

    const { narrative, provenance } = synthesis;
    const timestamp = now();
    const summary = {
      ...this.buildSummary(this.requireSession(sessionId), rounds),
      narrative,
      narrativeUnavailable: narrative === null,
      publishedAt: timestamp,
      ...(provenance ? { narrativeProvenance: provenance } : {}),
    };
    this.repository.publishQuickFire(
      sessionId,
      interviewSessionSummarySchemaResult.parse(summary),
      timestamp,
      op.epoch,
    );
  }

  /**
   * Ask the model for a bounded narrative over the saved reviews, with one
   * repair retry on a structural failure. Returns `'stopped'` once the
   * operation stops, and an empty outcome when no usable narrative results.
   */
  private async synthesiseNarrative(
    op: SessionOperation,
    sessionId: string,
    rounds: SessionRoundRow[],
  ): Promise<SynthesisOutcome | 'stopped'> {
    const model = await this.resolveModel();
    const reviews = rounds.map((round) =>
      this.reviews.getRoundReviewForSynthesis(sessionId, round.roundId),
    );
    const messages = buildSynthesisMessages(reviews);

    for (let attempt = 0; attempt < SYNTHESIS_ATTEMPTS; attempt += 1) {
      if (operationStopped(op)) return 'stopped';

      const result = await this.inference!.generate({
        callerModule: 'interviews',
        execution: { priority: 'normal', signal: op.controller.signal },
        providerId: model.providerId,
        modelId: model.modelId,
        messages: attempt
          ? [
              ...messages,
              {
                role: 'user',
                content: 'Return only the required bounded JSON object.',
              },
            ]
          : messages,
        thinking: true,
        responseFormat: synthesisResponseFormat,
        toolNames: [],
      });
      if (result.status === 'cancelled' || operationStopped(op)) {
        return 'stopped';
      }

      if (result.status === 'completed') {
        const narrative = validateNarrative(result.output, reviews);
        if (narrative) {
          return {
            narrative,
            provenance: {
              providerId: model.providerId,
              modelId: model.modelId,
              promptVersion: SYNTHESIS_VERSION,
              validation: 'passed' as const,
              generatedAt: now(),
            },
          };
        }
      } else if (
        result.error?.code !== 'INVALID_SCHEMA' &&
        result.error?.code !== 'INVALID_RESPONSE'
      )
        break;
    }

    return EMPTY_SYNTHESIS;
  }

  // --- generation primitives ------------------------------------------------

  /**
   * One bounded read-only question generation with at most one repair retry,
   * streaming deltas into the operation's ephemeral progress text. Throws a
   * cancellation sentinel if the operation was cancelled, and a recoverable
   * AppError on a persistent structural/provider failure or near-duplicate.
   */
  private async generateQuestion(
    op: SessionOperation,
    model: ResolvedModel,
    baseMessages: GenerationRequestInput['messages'],
    repair: GenerationRequestInput['messages'][number],
    existingTexts: string[],
  ): Promise<ValidatedQuestion> {
    const priority = existingTexts.length ? 'normal' : 'interactive';

    for (let attempt = 0; attempt < QUESTION_ATTEMPTS; attempt += 1) {
      if (operationStopped(op)) {
        throw cancelledError();
      }

      const messages = attempt === 0 ? baseMessages : [...baseMessages, repair];
      const result = await this.callGenerate(op, model, messages, priority);
      if (result.status === 'cancelled' || operationStopped(op)) {
        throw cancelledError();
      }

      if (result.status === 'completed') {
        const question = acceptGeneratedQuestion(result, existingTexts);
        if (question) return question;
        continue;
      }

      if (!isRetryableFailure(result)) {
        throw generationFailure(result);
      }
    }

    throw new AppError(
      'CONFLICT',
      'The local model could not produce a usable question. Please try again.',
    );
  }

  private async callGenerate(
    op: SessionOperation,
    model: ResolvedModel,
    messages: GenerationRequestInput['messages'],
    priority: 'interactive' | 'normal',
  ): Promise<GenerationResult> {
    if (!this.inference) {
      throw new AppError('CONFLICT', 'Local AI is not configured.');
    }
    const requestId = newId();
    op.requestId = requestId;
    return this.inference.generate({
      requestId,
      callerModule: 'interviews',
      execution: {
        priority,
        signal: op.controller.signal,
        onEvent: (event) => this.onProgressEvent(op, requestId, event),
      },
      providerId: model.providerId,
      modelId: model.modelId,
      messages,
      thinking: false,
      responseFormat: questionResponseFormat,
      toolNames: [],
    });
  }

  /** Append streamed deltas to the operation's bounded ephemeral text. */
  private onProgressEvent(
    op: SessionOperation,
    requestId: string,
    event: GenerationEvent,
  ): void {
    // Ignore late/foreign events (e.g. after cancel or from a prior request).
    if (op.status !== 'running' || op.requestId !== requestId) {
      return;
    }
    if (event.kind === 'delta' && event.requestId === requestId) {
      op.progressText = clampProgress(op.progressText + event.text);
    }
  }

  // --- operation lifecycle --------------------------------------------------

  private runOperation(
    sessionId: string,
    kind: OperationKind,
    run: (op: SessionOperation) => Promise<void>,
    roundId: string | null = null,
  ): string {
    if (this.hasRunningOp(sessionId)) return this.operations.get(sessionId)!.id;
    const op = this.createOperation(sessionId, kind, roundId);
    this.operations.set(sessionId, op);
    void this.execute(op, run);
    return op.id;
  }

  private createOperation(
    sessionId: string,
    kind: OperationKind,
    roundId: string | null = null,
  ): SessionOperation {
    return {
      id: newId(),
      sessionId,
      kind,
      roundId,
      status: 'running',
      progressText: '',
      requestId: null,
      controller: new AbortController(),
      errorMessage: null,
      startedAt: now(),
      settled: false,
      epoch: this.repository.generationEpoch(sessionId),
    };
  }

  private async execute(
    op: SessionOperation,
    run: (op: SessionOperation) => Promise<void>,
  ): Promise<void> {
    try {
      await run(op);
      if (op.status === 'running') {
        op.status = 'completed';
      }
    } catch (error) {
      if (op.status === 'cancelled' || isCancelled(error)) {
        op.status = 'cancelled';
        op.errorMessage = op.errorMessage ?? CANCELLED_MESSAGE;
      } else {
        op.status = 'failed';
        op.errorMessage =
          error instanceof AppError
            ? error.message
            : 'Something went wrong generating content. Please try again.';
        this.record('sessions.operation', op.startedAt, 'failure', {
          kind: op.kind,
          errorCode: error instanceof AppError ? error.code : 'INTERNAL',
        });
      }
    } finally {
      // Ephemeral progress text never outlives the request.
      op.progressText = '';
      op.settled = true;
    }
  }

  private abortOperation(sessionId: string): void {
    const op = this.operations.get(sessionId);
    if (op && op.status === 'running') {
      op.status = 'cancelled';
      op.progressText = '';
      op.controller.abort();
      op.settled = true;
      if (op.requestId) {
        void this.cancelInference(op.requestId);
      }
    }
  }

  private abortQuickFireReviews(sessionId: string): void {
    for (const op of this.reviewOperations.values()) {
      if (op.sessionId === sessionId && op.status === 'running') {
        op.status = 'cancelled';
        op.controller.abort();
        op.settled = true;
      }
    }
  }

  private quickFireOperation(
    sessionId: string,
    method: InterviewMethod,
  ): SessionOperation | undefined {
    const primary = this.operations.get(sessionId);
    if (method !== 'quick_fire') return primary;
    const reviews = [...this.reviewOperations.values()].filter(
      (op) => op.sessionId === sessionId,
    );
    return (
      reviews.find((op) => !op.settled) ??
      (primary && !primary.settled ? primary : undefined) ??
      reviews.find(
        (op) => op.status === 'failed' || op.status === 'cancelled',
      ) ??
      primary
    );
  }

  private hasUnsettledQuickFireReviews(sessionId: string): boolean {
    return [...this.reviewOperations.values()].some(
      (op) => op.sessionId === sessionId && !op.settled,
    );
  }

  private async cancelInference(requestId: string): Promise<void> {
    try {
      const client = this.inference;
      if (isCancellable(client)) {
        await client.cancel(requestId);
      }
    } catch {
      // Best-effort only; the AbortSignal already stopped local work.
    }
  }

  // --- persistence helpers --------------------------------------------------

  private persistPrimary(
    sessionId: string,
    ordinal: number,
    validated: ValidatedQuestion,
    model: ResolvedModel,
    promptVersion: string,
    requestId: string | null,
    expectedEpoch: number,
  ): void {
    try {
      this.repository.insertPrimaryRound({
        sessionId,
        roundId: newId(),
        questionId: newId(),
        ordinal,
        questionText: validated.question,
        competency: validated.competency,
        rubric: validated.rubric,
        source: this.sourceProvenance(
          model,
          promptVersion,
          requestId,
          validated.sourceBasis,
        ),
        now: now(),
        expectedEpoch,
      });
    } catch (error) {
      // A racing insert won the ordinal slot: treat as idempotent success.
      const rounds = this.repository.listSessionRounds(sessionId);
      if (rounds.some((r) => r.ordinal === ordinal)) {
        return;
      }
      throw error instanceof AppError ? error : new AppError('INTERNAL');
    }
  }

  private sourceProvenance(
    model: ResolvedModel,
    promptVersion: string,
    requestId: string | null,
    sourceBasis: string,
  ): JsonValue {
    return {
      schemaVersion: 1,
      origin: 'generated',
      providerId: model.providerId,
      modelId: model.modelId,
      promptVersion,
      inferenceRequestId: requestId ?? 'none',
      sourceBasis,
      validation: 'passed',
      generatedAt: now(),
    };
  }

  // --- summary --------------------------------------------------------------

  private buildSummary(
    session: InterviewSession,
    rounds: SessionRoundRow[],
  ): InterviewSessionSummaryResult {
    const method = session.method;
    const totalRounds =
      method === 'quick_fire'
        ? (session.questionCount ?? rounds.length)
        : rounds.length;
    const answeredCount = rounds.filter((r) => r.primaryAnswered).length;
    const reviewed = rounds.filter((r) => r.reviewDecision !== null);
    const passCount = reviewed.filter(
      (r) => r.reviewDecision === 'pass',
    ).length;
    const failCount = reviewed.filter(
      (r) => r.reviewDecision === 'fail',
    ).length;
    const unscoredCount = reviewed.filter(
      (r) => r.reviewDecision === 'unscored',
    ).length;
    const averageScore = averageReviewScore(reviewed);

    const complete =
      answeredCount === totalRounds &&
      reviewed.length === rounds.length &&
      rounds.length > 0;

    const recommendation = this.summaryRecommendation(rounds, unscoredCount);

    return {
      method,
      subject: session.subject,
      totalRounds,
      answeredCount,
      reviewedCount: reviewed.length,
      passCount,
      failCount,
      unscoredCount,
      averageScore,
      complete,
      recommendation,
      rounds: rounds.map(summaryRound),
    };
  }

  private summaryRecommendation(
    rounds: SessionRoundRow[],
    unscoredCount: number,
  ): string | null {
    const atCap = rounds.some(
      (r) =>
        r.reviewDecision === 'fail' &&
        r.hasCoaching &&
        this.repository.reassessmentDepth(r.roundId) >=
          DEFAULT_REASSESSMENT_CAP,
    );
    if (atCap) {
      return (
        'You reached the practice limit for a competency. ' +
        'Take time to study it, then start a fresh interview.'
      );
    }

    if (unscoredCount > 0) {
      return (
        'Some answers could not be scored. ' +
        'Revisit those topics and try fresh questions.'
      );
    }

    return null;
  }

  private publicSummary(
    session: InterviewSession,
    summary: InterviewSessionSummaryResult,
  ): InterviewSessionSummaryResult {
    if (
      session.method !== 'quick_fire' ||
      this.repository.getPublication(session.id)
    )
      return summary;
    return {
      ...summary,
      reviewedCount: 0,
      passCount: 0,
      failCount: 0,
      unscoredCount: 0,
      averageScore: null,
      complete: false,
      recommendation: null,
      rounds: summary.rounds.map((round) => ({
        ...round,
        decision: null,
        score: null,
      })),
    };
  }

  private publishedSummary(
    session: InterviewSession,
    rounds: SessionRoundRow[],
  ): InterviewSessionSummaryResult {
    const publication = this.repository.getPublication(session.id);
    if (session.method === 'quick_fire' && publication?.summary)
      return publication.summary as InterviewSessionSummaryResult;
    return this.buildSummary(session, rounds);
  }

  private publicSession(session: InterviewSession): InterviewSession {
    return session.method === 'quick_fire' &&
      !this.repository.getPublication(session.id)
      ? { ...session, barSnapshot: null }
      : session;
  }

  // --- small helpers --------------------------------------------------------

  private hasRunningOp(sessionId: string): boolean {
    const op = this.operations.get(sessionId);
    return op !== undefined && !op.settled;
  }

  private requireSession(sessionId: string): InterviewSession {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw sessionNotFound();
    }
    return session;
  }

  private freezeBar(session: InterviewSession): ApprovedOrProvisionalBar {
    const existing = parseBar(session.barSnapshot);
    if (existing) {
      return existing;
    }
    const bar = buildProvisionalBar({
      subject: session.subject,
      target: session.targetSnapshot,
      careerTargetId: session.careerTargetId,
    });
    this.repository.freezeBarAndPhase(session.id, bar, 'preparing', now());
    return bar;
  }

  private deriveDeepLoopPhase(rounds: SessionRoundRow[]): string {
    if (rounds.length === 0) {
      return 'preparing';
    }
    const active = rounds[rounds.length - 1];
    if (!active.primaryAnswered) {
      return 'answering';
    }
    if (active.followUpTotal > active.followUpAnswered) {
      return 'follow_up';
    }
    if (active.reviewDecision === null) {
      return 'awaiting_review';
    }
    if (active.reviewDecision === 'fail') {
      return active.hasCoaching ? 'coached' : 'reviewed';
    }
    return 'answering';
  }

  private setPhaseIfChanged(session: InterviewSession, phase: string): void {
    if (session.phase !== phase) {
      this.repository.setPhase(session.id, phase, now());
      session.phase = phase;
    }
  }

  private questionView(
    sessionId: string,
    questionId: string,
  ): InterviewQuestionView | null {
    const detail = this.repository.getQuestionDetail(sessionId, questionId);
    return detail ? this.detailToView(detail) : null;
  }

  private detailToView(detail: QuestionDetailRow): InterviewQuestionView {
    const rubric = parseRubric(detail.rubricJson);
    return {
      id: detail.questionId,
      roundId: detail.roundId,
      question: detail.questionText,
      competency: detail.competency ?? 'general',
      createdAt: detail.createdAt,
      rubricSummary: rubric
        ? rubric.criteria.map((c) => shorten(c.description, RUBRIC_SUMMARY_MAX))
        : null,
      provenance: parseProvenance(detail.sourceJson),
    };
  }

  private subjectOf(sessionId: string): string {
    return this.requireSession(sessionId).subject;
  }

  private targetOf(sessionId: string): InterviewSession['targetSnapshot'] {
    return this.requireSession(sessionId).targetSnapshot;
  }

  private guidanceOf(sessionId: string): string | null {
    return this.requireSession(sessionId).additionalGuidance;
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
        'The selected local model is not available. ' +
          'Open Local AI settings to pick an installed local model.',
      );
    }
    return {
      providerId,
      modelId,
    };
  }

  private startOutput(
    sessionId: string,
    progressId: string | null,
  ): InterviewSessionsStartOutput {
    const session = this.requireSession(sessionId);
    return {
      session: this.publicSession(session),
      phase: session.phase,
      progressId,
    };
  }

  private advanceOutput(
    sessionId: string,
    currentQuestion: InterviewQuestionView | null,
    phase: string | null,
    progressId: string | null,
  ): InterviewSessionsAdvanceOutput {
    const session = this.requireSession(sessionId);
    return {
      session: this.publicSession(session),
      currentQuestion:
        currentQuestion &&
        session.method === 'quick_fire' &&
        !this.repository.getPublication(sessionId)
          ? { ...currentQuestion, rubricSummary: null }
          : currentQuestion,
      phase,
      progressId,
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

// --- module-level helpers ---------------------------------------------------

const CANCELLED = Symbol('interview-op-cancelled');

type CancelledError = Error & { [CANCELLED]?: boolean };

function cancelledError(): Error {
  const error: CancelledError = new Error('cancelled');
  error[CANCELLED] = true;

  return error;
}

function isCancelled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    CANCELLED in error &&
    error[CANCELLED] === true
  );
}

function isPausedPhase(phase: string | null | undefined): boolean {
  return phase?.startsWith('paused') ?? false;
}

/** Inference clients may optionally expose best-effort request cancellation. */
interface CancellableInference {
  cancel: (id: string) => Promise<unknown>;
}

function isCancellable(client: unknown): client is CancellableInference {
  return (
    typeof client === 'object' &&
    client !== null &&
    'cancel' in client &&
    typeof client.cancel === 'function'
  );
}

/** True once an operation is no longer running (cancelled, failed or done). */
function operationStopped(op: { status: string }): boolean {
  return op.status !== 'running';
}

/** Default planned follow-ups for a round: one for a normal round, none for a
 * reassessment round (which goes straight to an independent review). */
function plannedFollowUps(round: SessionRoundRow): number {
  const planned = round.reassessmentOfRoundId !== null ? 0 : 1;
  return Math.min(planned, DEEP_LOOP_FOLLOW_UP_BUDGET);
}

function requireQuickFireCount(session: InterviewSession): number {
  const count = session.questionCount;
  if (count === null || count < QUICK_FIRE_MIN_COUNT) {
    throw new AppError(
      'CONFLICT',
      'This quick-fire session is missing a valid question count.',
    );
  }
  return count;
}

function isRetryableFailure(result: GenerationResult): boolean {
  if (result.status === 'cancelled') {
    return false;
  }
  const code = result.error?.code;
  return code === 'INVALID_SCHEMA' || code === 'INVALID_RESPONSE';
}

/** A validated question that is not a near-duplicate of an existing one. */
function acceptGeneratedQuestion(
  result: GenerationResult,
  existingTexts: string[],
): ValidatedQuestion | null {
  const validation = validateGeneratedQuestion(
    (result.output ?? null) as JsonValue,
  );
  const usable =
    validation.ok && !isNearDuplicate(validation.value.question, existingTexts);

  return usable ? validation.value : null;
}

function generationFailure(result: GenerationResult): AppError {
  const code =
    result.error?.code === 'RETRIES_EXHAUSTED'
      ? result.lastErrorCode
      : result.error?.code;

  return new AppError('CONFLICT', messageForFailure(code));
}

function messageForFailure(code: string | undefined): string {
  switch (code) {
    case 'PROVIDER_UNAVAILABLE':
    case 'WORKER_UNAVAILABLE':
    case 'WORKER_EXITED':
      return (
        'The local model is not reachable. ' +
        'Open Local AI settings to check it is running.'
      );
    case 'MODEL_NOT_FOUND':
      return (
        'The selected model is not installed. ' +
        'Open Local AI settings to pick an installed local model.'
      );
    case 'CAPABILITY_UNSUPPORTED':
      return (
        'The selected model cannot produce structured output. ' +
        'Pick a different local model in Local AI settings.'
      );
    case 'TIMEOUT':
      return 'The local model timed out. Please try again.';
    case 'OVER_CAPACITY':
    case 'LIMIT_EXCEEDED':
      return 'The local model is busy. Please try again in a moment.';
    default:
      return 'Content generation failed. Please try again.';
  }
}

function isNearDuplicate(candidate: string, existing: string[]): boolean {
  const norm = normalise(candidate);
  const tokens = new Set(norm.split(' '));
  return existing.some((text) => {
    const previous = normalise(text);
    if (previous === norm) return true;
    const prior = new Set(previous.split(' '));
    const shared = [...tokens].filter((token) => prior.has(token)).length;
    return shared / (tokens.size + prior.size - shared) > 0.8;
  });
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function clampProgress(text: string): string {
  if (text.length <= PROGRESS_TEXT_MAX) {
    return text;
  }
  return text.slice(text.length - PROGRESS_TEXT_MAX);
}

type SummaryRound = InterviewSessionSummaryResult['rounds'][number];

function summaryRound(round: SessionRoundRow): SummaryRound {
  return {
    roundId: round.roundId,
    ordinal: round.ordinal,
    competency: round.competency,
    decision: round.reviewDecision,
    score: round.reviewScore,
    isReassessment: round.reassessmentOfRoundId !== null,
  };
}

/** Mean of scored (not unscored) reviews, to one decimal place. */
function averageReviewScore(reviewed: SessionRoundRow[]): number | null {
  const scored = reviewed.filter(
    (r) => r.reviewDecision !== 'unscored' && r.reviewScore !== null,
  );
  if (scored.length === 0) return null;

  const total = scored.reduce((sum, r) => sum + (r.reviewScore ?? 0), 0);

  return (
    Math.round((total / scored.length) * SCORE_PRECISION) / SCORE_PRECISION
  );
}

function parseRubric(json: string | null): QuestionRubric | null {
  if (!json) {
    return null;
  }
  const parsed = safeJson(json) as QuestionRubric | null;
  return parsed && Array.isArray(parsed.criteria) ? parsed : null;
}

function parseProvenance(json: string | null): InterviewQuestionProvenance {
  const fallback: InterviewQuestionProvenance = {
    origin: 'generated',
    providerId: 'unknown',
    modelId: 'unknown',
    promptVersion: INTERVIEW_QUESTION_PROMPT_VERSION,
    sourceBasis: 'model_general_knowledge',
    validation: 'passed',
    generatedAt: new Date(0).toISOString(),
  };
  if (!json) {
    return fallback;
  }
  const parsed = safeJson(json) as Record<string, unknown> | null;
  if (!parsed) {
    return fallback;
  }
  const result = interviewQuestionProvenanceSchema.safeParse({
    origin: parsed.origin,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    promptVersion: parsed.promptVersion,
    sourceBasis: parsed.sourceBasis,
    validation: parsed.validation,
    generatedAt: parsed.generatedAt,
  });
  return result.success ? result.data : fallback;
}

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
