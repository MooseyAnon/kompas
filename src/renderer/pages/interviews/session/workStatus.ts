import type { InterviewWorkflowState } from '../../../../shared/contracts';
import { isPausedPhase } from './sessionView';
import type { WorkCategory } from './statusCopy';

/** How prominent a running status should be. */
export type WorkPresentation = 'large' | 'inline' | 'chip';

/**
 * Display classification of backend work for either runner. Derived only from
 * the snapshot: `operationId`, `progress.operation`/`operationStatus`, counts
 * and `availableActions`. It never includes review outcomes, so it is safe
 * under the Quick-fire embargo.
 */
export type WorkStatus =
  | { kind: 'idle' }
  | { kind: 'terminal' }
  | { kind: 'paused'; canResume: boolean }
  | {
      kind: 'running';
      category: WorkCategory;
      presentation: WorkPresentation;
      canPause: boolean;
    }
  | {
      kind: 'failed';
      cancelled: boolean;
      message: string | null;
      canRetry: boolean;
      /** Deep Loop: a failed optional follow-up may be skipped. */
      canSkip: boolean;
    };

/** Deep Loop `progress.operation` values reported by the session service. */
const deepLoopCategories: Record<string, WorkCategory> = {
  next_question: 'next_question',
  follow_up: 'follow_up',
  reviewing: 'review',
  coaching: 'coaching',
  reassessing: 'reassessment',
  assessing: 'synthesis',
};

const largeCategories = new Set<WorkCategory>(['first_question', 'synthesis']);

function presentationFor(
  state: InterviewWorkflowState,
  category: WorkCategory,
  resultsRequested: boolean,
): WorkPresentation {
  // Quick-fire work beside an answerable question must never block it.
  if (state.session.method === 'quick_fire' && state.currentQuestion !== null)
    return 'chip';
  // Once results are requested the user is only waiting on the final checks.
  if (category === 'final_checks' && resultsRequested) return 'large';
  if (largeCategories.has(category)) return 'large';
  return category === 'background' ? 'chip' : 'inline';
}

/**
 * `resultsRequested` only changes how prominent Quick-fire final checks are;
 * it never changes the category, which comes from the snapshot alone.
 */
export function selectWorkStatus(
  state: InterviewWorkflowState,
  options: { resultsRequested?: boolean } = {},
): WorkStatus {
  const { session, progress, availableActions } = state;

  if (session.status === 'completed' || session.status === 'abandoned')
    return { kind: 'terminal' };
  if (session.status === 'draft') return { kind: 'idle' };
  if (isPausedPhase(session.phase))
    return { kind: 'paused', canResume: availableActions.includes('continue') };

  if (state.operationId !== null) {
    const resultsRequested = options.resultsRequested ?? false;
    const category =
      session.method === 'quick_fire'
        ? quickFireCategory(state)
        : deepLoopCategory(state);
    return {
      kind: 'running',
      category,
      presentation: presentationFor(state, category, resultsRequested),
      canPause: availableActions.includes('pause'),
    };
  }

  if (
    progress.operationStatus === 'failed' ||
    progress.operationStatus === 'cancelled'
  )
    return {
      kind: 'failed',
      cancelled: progress.operationStatus === 'cancelled',
      message: progress.errorMessage,
      canRetry: availableActions.includes('retry'),
      canSkip:
        session.method === 'deep_loop' && availableActions.includes('continue'),
    };

  return { kind: 'idle' };
}

/**
 * Quick-fire reports an opaque `working` operation (question generation and
 * reviews run concurrently), so the category comes from what the user is
 * waiting for and the neutral counts, never from review outcomes:
 *
 * - before any answer, only question generation can be running;
 * - once answers exist, background work may be reviews or questions;
 * - with every answer reviewed, the only possible work is the synthesis that
 *   an explicit results request starts.
 */
function quickFireCategory(state: InterviewWorkflowState): WorkCategory {
  const { answeredCount, questionCount, reviewedCount } = state.progress;
  if (state.currentQuestion !== null)
    return answeredCount === 0 ? 'next_question' : 'background';
  if (answeredCount === 0) return 'first_question';
  if (answeredCount < questionCount) return 'next_question';
  return reviewedCount >= questionCount ? 'synthesis' : 'final_checks';
}

function deepLoopCategory(state: InterviewWorkflowState): WorkCategory {
  const operation = state.progress.operation;
  if (operation === 'preparing')
    return state.progress.questionCount === 0
      ? 'first_question'
      : 'next_question';
  return (
    (operation ? deepLoopCategories[operation] : undefined) ?? 'background'
  );
}
