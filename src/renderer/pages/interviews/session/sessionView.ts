import type {
  InterviewQuestionView,
  InterviewWorkflowState,
} from '../../../../shared/contracts/interviews';

/**
 * What the session outlet should show for a workflow snapshot. This only
 * classifies backend state for display; `availableActions` stays the sole
 * source of which intents may be sent.
 *
 * 07.2 owns the pre-question journey (preparing, failure before the first
 * question, paused, stalled after a restart). Once a question exists or
 * answers are saved, the method runner owns the view (07.4 / 07.5).
 */
export type SessionView =
  | { kind: 'finished'; outcome: 'completed' | 'abandoned' }
  | { kind: 'draft' }
  | { kind: 'paused'; canResume: boolean }
  | { kind: 'preparing' }
  | {
      kind: 'failed';
      message: string | null;
      cancelled: boolean;
      canRetry: boolean;
    }
  | { kind: 'stalled'; canContinue: boolean }
  | { kind: 'runner'; question: InterviewQuestionView | null };

/**
 * A pause is stored as a `paused…` phase on an active session (`paused`,
 * `paused_review`); those values are not in the published phase enum.
 */
export function isPausedPhase(phase: string | null) {
  return phase?.startsWith('paused') ?? false;
}

export function selectSessionView(state: InterviewWorkflowState): SessionView {
  const { session, progress, availableActions } = state;

  if (session.status === 'completed' || session.status === 'abandoned')
    return { kind: 'finished', outcome: session.status };
  if (session.status === 'draft') return { kind: 'draft' };
  if (isPausedPhase(session.phase))
    return { kind: 'paused', canResume: availableActions.includes('continue') };

  const beforeFirstQuestion =
    state.currentQuestion === null && progress.answeredCount === 0;
  if (!beforeFirstQuestion)
    return { kind: 'runner', question: state.currentQuestion };

  if (state.operationId !== null) return { kind: 'preparing' };
  if (
    progress.operationStatus === 'failed' ||
    progress.operationStatus === 'cancelled'
  )
    return {
      kind: 'failed',
      message: progress.errorMessage,
      cancelled: progress.operationStatus === 'cancelled',
      canRetry: availableActions.includes('retry'),
    };
  return {
    kind: 'stalled',
    canContinue: availableActions.includes('continue'),
  };
}

/** Polling is passive and only runs while backend work is in flight. */
export function shouldPoll(state: InterviewWorkflowState) {
  return state.operationId !== null;
}
