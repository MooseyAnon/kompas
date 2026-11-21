import { useEffect, useRef, useState } from 'react';
import type {
  InsightsDetail,
  InterviewWorkflowState,
} from '../../../../shared/contracts';
import { ApiError, getInsightsDetail } from '../../../api';

type HistoryLoad =
  | { status: 'loading' }
  | { status: 'ready'; detail: InsightsDetail }
  | { status: 'error'; message: string };

/** Read the persisted conversation after each meaningful snapshot change. Polling
 * alone does not trigger extra detail reads. A slow earlier read cannot replace a
 * newer one, and the previous conversation stays visible during refreshes. */
export function useDeepLoopHistory(state: InterviewWorkflowState) {
  const [load, setLoad] = useState<HistoryLoad>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const { session, progress, currentQuestion, feedback } = state;

  useEffect(() => {
    const request = ++sequence.current;
    void getInsightsDetail(session.id)
      .then((detail) => {
        if (sequence.current === request) setLoad({ status: 'ready', detail });
      })
      .catch((error: unknown) => {
        if (sequence.current === request)
          setLoad({
            status: 'error',
            message:
              error instanceof ApiError
                ? error.message
                : 'Your saved conversation couldn’t be loaded.',
          });
      });
    return () => {
      sequence.current += 1;
    };
  }, [
    session.id,
    session.status,
    progress.questionCount,
    progress.answeredCount,
    progress.reviewedCount,
    progress.operationStatus,
    progress.operation,
    currentQuestion?.id,
    feedback?.review?.id,
    feedback?.coaching?.id,
    retry,
  ]);

  return { load, reload: () => setRetry((value) => value + 1) };
}
