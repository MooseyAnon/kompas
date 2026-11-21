/**
 * Deterministic interview workflow rules for the `interviews` domain.
 *
 * These are pure, testable transition functions describing *how* a session
 * progresses. They encode the application-owned state machine only: no AI,
 * model output, scoring or content generation happens here or anywhere in
 * stage 005. A future inference-backed engine supplies question/review/coaching
 * *content*, but it cannot move the state machine outside these rules.
 */

import {
  QUICK_FIRE_MAX_COUNT,
  QUICK_FIRE_MIN_COUNT,
} from '../../../shared/contracts';

/**
 * Default cap on consecutive reassessments before recommending a learning
 * step.
 */
export const DEFAULT_REASSESSMENT_CAP = 2;

export type ReviewDecision = 'pass' | 'fail' | 'unscored';

// --- Quick-fire --------------------------------------------------------------

/** A quick-fire configured count must sit within the inclusive 5..10 band. */
export function isQuickFireCountValid(count: number): boolean {
  return (
    Number.isInteger(count) &&
    count >= QUICK_FIRE_MIN_COUNT &&
    count <= QUICK_FIRE_MAX_COUNT
  );
}

export interface QuickFireProgress {
  /** Configured number of primary-question rounds (N in [5,10]). */
  questionCount: number;
  /** Number of primary rounds created so far. */
  roundsCreated: number;
  /** Number of rounds that already have a recorded answer. */
  answersCollected: number;
}

/** Quick-fire is ready to start once exactly N primary rounds exist. */
export function quickFireReadyToStart(progress: QuickFireProgress): boolean {
  return (
    isQuickFireCountValid(progress.questionCount) &&
    progress.roundsCreated === progress.questionCount
  );
}

/**
 * Review for a quick-fire session is deferred until **all** configured answers
 * exist; there is never per-question coaching or interviewer follow-up.
 */
export function quickFireReadyForReview(progress: QuickFireProgress): boolean {
  return (
    progress.roundsCreated === progress.questionCount &&
    progress.answersCollected === progress.questionCount
  );
}

/** Quick-fire mode never permits interviewer follow-up questions. */
export const QUICK_FIRE_ALLOWS_FOLLOW_UP = false;

/** Quick-fire mode never permits coaching. */
export const QUICK_FIRE_ALLOWS_COACHING = false;

// --- Deep loop ---------------------------------------------------------------

export interface DeepLoopRoundState {
  /** Review decision for the round, or null while still awaiting review. */
  decision: ReviewDecision | null;
  /** Whether coaching has already been delivered for a failed round. */
  coached: boolean;
  /** Consecutive reassessment rounds already taken on this competency. */
  consecutiveReassessments: number;
}

export type DeepLoopTransition =
  | 'await_review'
  | 'advance'
  | 'coach'
  | 'reassess'
  | 'halt_recommend_learning';

/**
 * Compute the next deep-loop transition for a reviewed round:
 * - no decision yet → `await_review`
 * - pass → `advance` (next independent question or finish)
 * - fail and not yet coached → `coach`
 * - fail, coached, under the cap → `reassess` (a distinct linked round)
 * - fail, coached, at/over the cap → `halt_recommend_learning`
 * - `unscored` is not an assessment → stay in `await_review`
 */
export function deepLoopNextTransition(
  round: DeepLoopRoundState,
  cap: number = DEFAULT_REASSESSMENT_CAP,
): DeepLoopTransition {
  if (round.decision === null || round.decision === 'unscored') {
    return 'await_review';
  }

  if (round.decision === 'pass') {
    return 'advance';
  }

  if (!round.coached) {
    return 'coach';
  }

  if (round.consecutiveReassessments >= cap) {
    return 'halt_recommend_learning';
  }

  return 'reassess';
}

export type DeepLoopChoice =
  | 'request_coaching'
  | 'request_reassessment'
  | 'continue'
  | 'request_results';

export interface DeepLoopReviewedRound {
  decision: ReviewDecision;
  coached: boolean;
  /** Reassessment links between this round and its original question. */
  reassessmentDepth: number;
}

/**
 * The user's choices once a Deep Loop round has a committed review. Coaching
 * and reassessment are offered, never forced: `continue` moves on to a new
 * independent question. At the reassessment cap a failed competency halts the
 * loop (no `continue`/`request_reassessment`) and recommends learning instead.
 */
export function deepLoopReviewedChoices(
  round: DeepLoopReviewedRound,
  cap: number = DEFAULT_REASSESSMENT_CAP,
): DeepLoopChoice[] {
  if (round.decision !== 'fail') {
    return ['continue', 'request_results'];
  }

  const atCap = round.reassessmentDepth >= cap;

  if (!round.coached) {
    return atCap
      ? ['request_coaching', 'request_results']
      : ['request_coaching', 'continue', 'request_results'];
  }

  return atCap
    ? ['request_results']
    : ['request_reassessment', 'continue', 'request_results'];
}

// --- Reassessment linking ----------------------------------------------------

/**
 * Walk the `reassessment_of` chain to detect a cycle reachable from a start
 * id.
 */
export function reassessmentChainHasCycle(
  startId: string,
  parentOf: (roundId: string) => string | null,
): boolean {
  const seen = new Set<string>();
  let current: string | null = startId;

  while (current !== null) {
    if (seen.has(current)) {
      return true;
    }

    seen.add(current);
    current = parentOf(current);
  }

  return false;
}
