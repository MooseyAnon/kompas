import { useCallback, useEffect, useRef, useState } from 'react';
import type { InsightsDetail } from '../../../../shared/contracts';
import { ApiError, getInsightsDetail } from '../../../api';

export type BreakdownLoad =
  | { status: 'loading' }
  | { status: 'ready'; detail: InsightsDetail }
  | { status: 'error'; message: string };

/**
 * Reads the released per-question detail (question, answer and review) for a
 * published Quick-fire session through `insights.sessions.get`. Mount it only
 * for a completed session with a result: before publication the backend
 * withholds reviews from this read as well.
 */
export function useQuickFireBreakdown(sessionId: string) {
  const [load, setLoad] = useState<BreakdownLoad>({ status: 'loading' });
  const request = useRef(0);

  const read = useCallback(async () => {
    const current = ++request.current;
    setLoad({ status: 'loading' });
    try {
      const detail = await getInsightsDetail(sessionId);
      if (current === request.current) setLoad({ status: 'ready', detail });
    } catch (error) {
      if (current === request.current)
        setLoad({
          status: 'error',
          message:
            error instanceof ApiError
              ? error.message
              : 'Your answers couldn’t be loaded.',
        });
    }
  }, [sessionId]);

  useEffect(() => {
    void read();
    // A late reply after unmount or a session change is ignored.
    return () => {
      request.current += 1;
    };
  }, [read]);

  return { load, reload: read };
}
