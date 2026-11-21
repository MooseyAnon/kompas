import type {
  InterviewQuestionView,
  InterviewWorkflowAction,
  InterviewWorkflowState,
} from '../../../../shared/contracts';
import { isPausedPhase } from '../session/sessionView';

/** Real counts for the session bar; `current` is null once all are answered. */
export interface QuickFirePosition {
  current: number | null;
  total: number;
  answered: number;
}

export function quickFirePosition(
  state: InterviewWorkflowState,
): QuickFirePosition {
  const total = state.progress.questionCount;
  const answered = Math.min(state.progress.answeredCount, total);
  return { current: answered < total ? answered + 1 : null, total, answered };
}

export function quickFireProgressLabel({ current, total }: QuickFirePosition) {
  return current === null
    ? `All ${total} answered`
    : `Question ${current} of ${total}`;
}

/**
 * A settled failure or cancellation. `scope` says what the user was waiting
 * for; `recovery` is the advertised intent that redoes it, if any.
 */
export interface QuickFireFailure {
  scope: 'questions' | 'checks' | 'results';
  cancelled: boolean;
  message: string | null;
  recovery: Extract<
    InterviewWorkflowAction,
    'retry' | 'request_results'
  > | null;
}

/**
 * What the Quick-fire runner shows once the first question exists (07.2's
 * outlet owns everything before it, plus paused and finished sessions).
 *
 * - `answering`: a question is answerable; background work may continue and
 *   a background failure is reported beside it without blocking the answer.
 * - `awaiting_question`: an answer was saved and the next one is generating.
 * - `stalled`: nothing runs and no question is ready (for example after the
 *   app was closed); only an explicit advertised `continue` resumes.
 * - `ready_for_results`: all answered and results not yet requested.
 * - `results_pending`: results were requested (or the synthesis it started is
 *   running) and the user is waiting.
 * - `failed`: work the user is waiting for failed or was cancelled.
 *
 * Built only from the snapshot and the user's own results request, never
 * from review outcomes, so it is safe under the Quick-fire embargo.
 */
export type QuickFireStage =
  | {
      kind: 'answering';
      question: InterviewQuestionView;
      backgroundFailure: QuickFireFailure | null;
    }
  | { kind: 'awaiting_question' }
  | { kind: 'stalled'; canContinue: boolean }
  | { kind: 'ready_for_results'; canRequest: boolean }
  | { kind: 'results_pending' }
  | { kind: 'failed'; failure: QuickFireFailure };

export function selectQuickFireStage(
  state: InterviewWorkflowState,
  results: { requested: boolean; awaitingAutoRequest: boolean },
): QuickFireStage {
  const { progress, availableActions, currentQuestion, operationId } = state;
  const offered = (action: InterviewWorkflowAction) =>
    availableActions.includes(action);
  const allAnswered = progress.answeredCount >= progress.questionCount;
  const allReviewed = progress.reviewedCount >= progress.questionCount;
  const settledFailure =
    operationId === null &&
    (progress.operationStatus === 'failed' ||
      progress.operationStatus === 'cancelled');

  const failure = (scope: QuickFireFailure['scope']): QuickFireFailure => ({
    scope,
    cancelled: progress.operationStatus === 'cancelled',
    message: progress.errorMessage,
    // Reviews and questions are redone by `retry`; a stopped synthesis only
    // by asking for results again.
    recovery:
      scope === 'results'
        ? offered('request_results')
          ? 'request_results'
          : null
        : offered('retry')
          ? 'retry'
          : null,
  });

  if (currentQuestion)
    return {
      kind: 'answering',
      question: currentQuestion,
      backgroundFailure: settledFailure
        ? failure(progress.answeredCount === 0 ? 'questions' : 'checks')
        : null,
    };

  if (settledFailure)
    return {
      kind: 'failed',
      failure: failure(
        !allAnswered ? 'questions' : allReviewed ? 'results' : 'checks',
      ),
    };

  if (!allAnswered)
    return operationId !== null
      ? { kind: 'awaiting_question' }
      : { kind: 'stalled', canContinue: offered('continue') };

  // With every answer reviewed, running work can only be the synthesis.
  if (operationId !== null)
    return results.requested || allReviewed
      ? { kind: 'results_pending' }
      : { kind: 'ready_for_results', canRequest: offered('request_results') };

  if (results.awaitingAutoRequest) return { kind: 'results_pending' };
  return { kind: 'ready_for_results', canRequest: offered('request_results') };
}

/**
 * True when a pending results request can now start the synthesis: every
 * answer is saved, nothing runs or failed, and `request_results` is offered.
 */
export function canStartResults(state: InterviewWorkflowState) {
  const { session, progress, operationId, availableActions } = state;
  return (
    session.status === 'active' &&
    !isPausedPhase(session.phase) &&
    operationId === null &&
    progress.operationStatus !== 'failed' &&
    progress.operationStatus !== 'cancelled' &&
    progress.answeredCount >= progress.questionCount &&
    availableActions.includes('request_results')
  );
}

/** The synthesis is running: all answers reviewed and work in flight. */
export function isSynthesisRunning(state: InterviewWorkflowState) {
  const { progress, operationId } = state;
  return (
    operationId !== null &&
    progress.answeredCount >= progress.questionCount &&
    progress.reviewedCount >= progress.questionCount
  );
}
