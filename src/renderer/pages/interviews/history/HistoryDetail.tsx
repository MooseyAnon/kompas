import React, { useEffect, useRef, useState } from 'react';
import type {
  InsightsDetail,
  InterviewWorkflowState,
} from '../../../../shared/contracts';
import { getInsightsDetail, getInterviewWorkflowState } from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { InterviewResultSummary } from '../../../presentation/components/interviews/InterviewResultSummary';
import { HistoryRounds } from '../../../presentation/components/interviews/HistoryRounds';

export function HistoryDetail({
  sessionId,
  onOpenSession,
}: {
  sessionId: string;
  onOpenSession: (id: string) => void;
}) {
  const [load, setLoad] = useState<
    | { status: 'loading' }
    | { status: 'error' }
    | {
        status: 'ready';
        detail: InsightsDetail;
        snapshot: InterviewWorkflowState;
      }
  >({ status: 'loading' });
  const request = useRef(0);
  function refresh() {
    const current = ++request.current;
    setLoad({ status: 'loading' });
    void Promise.all([
      getInsightsDetail(sessionId),
      getInterviewWorkflowState(sessionId),
    ])
      .then(([detail, snapshot]) => {
        if (request.current === current)
          setLoad({ status: 'ready', detail, snapshot });
      })
      .catch(() => {
        if (request.current === current) setLoad({ status: 'error' });
      });
  }
  useEffect(() => {
    refresh();
    return () => {
      request.current++;
    };
  }, [sessionId]);
  if (load.status === 'loading')
    return <p role="status">Loading session details…</p>;
  if (load.status === 'error')
    return (
      <div role="alert">
        <p>Session details couldn’t be loaded.</p>
        <Button onClick={refresh}>Try again</Button>
      </div>
    );

  const { detail, snapshot } = load;
  const { session } = detail;
  const published =
    session.method !== 'quick_fire' ||
    (session.status === 'completed' && snapshot.result !== null);
  const result =
    session.status === 'completed' && published ? snapshot.result : null;
  return (
    <section
      className="history-detail"
      aria-label={`Session details: ${session.subject}`}
    >
      <h2 tabIndex={-1}>{session.subject}</h2>
      <p>
        {session.method === 'quick_fire' ? 'Quick-fire' : 'Deep Loop'} ·{' '}
        {session.status === 'active' && session.phase === 'paused'
          ? 'Paused'
          : session.status}
        {session.targetSnapshot ? ` · ${session.targetSnapshot.role}` : ''}
      </p>
      {result && (
        <InterviewResultSummary
          title="Saved results"
          averageScore={result.averageScore}
          passCount={result.passCount}
          failCount={result.failCount}
          unscoredCount={result.unscoredCount}
          recommendation={result.recommendation}
          narrative={result.narrative ?? null}
          narrativeUnavailable={result.narrativeUnavailable ?? false}
        />
      )}
      {!result && (
        <p className="history-notice">
          {session.method === 'quick_fire'
            ? 'Results and reviews are available only after you request and publish results.'
            : 'No completed result is available for this session.'}
        </p>
      )}
      <HistoryRounds rounds={detail.rounds} showReviews={published} />
      {snapshot.availableActions.includes('continue') && (
        <Button onClick={() => onOpenSession(sessionId)}>Open to resume</Button>
      )}
      {session.status === 'active' &&
        !snapshot.availableActions.includes('continue') && (
          <Button variant="secondary" onClick={() => onOpenSession(sessionId)}>
            Open interview
          </Button>
        )}
    </section>
  );
}
