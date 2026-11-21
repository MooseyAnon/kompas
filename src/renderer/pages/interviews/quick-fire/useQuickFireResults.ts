import { useCallback, useEffect, useState } from 'react';
import type { InterviewWorkflowState } from '../../../../shared/contracts';
import type { SessionWorkflow } from '../session/useSessionWorkflow';
import { canStartResults, isSynthesisRunning } from './quickFireView';

/**
 * The user's Quick-fire results request, carried through the backend's
 * two-step publication contract:
 *
 * 1. `workflow.results.request` while reviews still run returns a pending
 *    snapshot; the session controller then polls passively.
 * 2. Polling never starts the synthesis, so once the snapshot is actionable
 *    (`request_results` advertised, nothing running or failed) the request is
 *    sent **once more** on the user's behalf.
 *
 * A user request arms one follow-up only when it cannot start the synthesis
 * itself (some answers still await their review). The follow-up is disarmed
 * once the synthesis is seen running, once it is sent, or when the user's
 * request fails, so an idle snapshot never loops and an error is never
 * re-sent behind the user's back; their own button remains available
 * instead. Duplicate sends are also refused by the controller's single
 * in-flight command.
 *
 * The request lives in this view only: leaving the session forgets it, and
 * the user asks again on return (the backend publishes exactly once).
 */
export function useQuickFireResults(
  state: InterviewWorkflowState,
  workflow: Pick<SessionWorkflow, 'pending' | 'requestResults'>,
) {
  const { pending, requestResults } = workflow;
  const [requested, setRequested] = useState(false);
  const [followUpArmed, setFollowUpArmed] = useState(false);

  const request = useCallback(() => {
    if (pending !== null || !state.availableActions.includes('request_results'))
      return;
    setRequested(true);
    // A follow-up is only needed when this request cannot start the synthesis
    // itself, i.e. while some answers still await their review.
    setFollowUpArmed(
      state.progress.reviewedCount < state.progress.questionCount,
    );
    void requestResults().then((outcome) => {
      // After a failure the user sees the error and decides; never re-send.
      if (outcome === 'failed') setFollowUpArmed(false);
    });
  }, [pending, requestResults, state]);

  useEffect(() => {
    if (!followUpArmed || pending !== null) return;
    if (isSynthesisRunning(state) || state.session.status !== 'active') {
      setFollowUpArmed(false);
      return;
    }
    if (!canStartResults(state)) return;
    setFollowUpArmed(false);
    void requestResults();
  }, [followUpArmed, pending, requestResults, state]);

  return {
    requested,
    /** Armed and ready to send: show the wait, not the request button. */
    awaitingAutoRequest: followUpArmed && canStartResults(state),
    request,
  };
}
