import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, History, RotateCw } from 'lucide-react';
import { Button } from '../../../presentation/components/Button';
import { EmptyState } from '../../../presentation/components/EmptyState';
import { HistorySessionRow } from '../../../presentation/components/interviews/HistorySessionRow';
import { HistoryDetail } from './HistoryDetail';
import { useHistory } from './useHistory';
import './HistoryTab.css';

export function HistoryTab({
  onOpenSession,
}: {
  onOpenSession: (id: string) => void;
}) {
  const { page, status, moreError, refresh, loadMore } = useHistory();
  const [selected, setSelected] = useState<string | null>(null);
  const [method, setMethod] = useState('all');
  const [sessionStatus, setSessionStatus] = useState('all');
  const returnFocus = useRef<string | null>(null);
  const visible = page.items.filter((item) => {
    const paused = page.snapshots[item.id]?.session.phase === 'paused';
    return (
      (method === 'all' || item.method === method) &&
      (sessionStatus === 'all' ||
        (sessionStatus === 'paused'
          ? item.status === 'active' && paused
          : item.status === sessionStatus && !paused))
    );
  });

  useLayoutEffect(() => {
    if (selected !== null) {
      document.getElementById('history-detail-back')?.focus();
    } else if (returnFocus.current) {
      document.getElementById(`history-open-${returnFocus.current}`)?.focus();
      returnFocus.current = null;
    }
  }, [selected]);

  function back() {
    setSelected(null);
  }

  if (selected)
    return (
      <div className="history-tab" data-testid="history-detail-view">
        <Button
          id="history-detail-back"
          variant="ghost"
          leadingIcon={<ArrowLeft aria-hidden="true" />}
          onClick={back}
        >
          Back to history
        </Button>
        <HistoryDetail sessionId={selected} onOpenSession={onOpenSession} />
      </div>
    );

  return (
    <div className="history-tab" data-testid="interviews-history">
      <div className="history-heading">
        <div>
          <h2>Practice history</h2>
          <p>Your saved sessions and released feedback.</p>
        </div>
        <Button
          variant="ghost"
          leadingIcon={<RotateCw aria-hidden="true" />}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>
      {status === 'ready' && page.items.length > 0 && (
        <div className="history-filters">
          <label>
            Method{' '}
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              <option value="all">All methods</option>
              <option value="quick_fire">Quick-fire</option>
              <option value="deep_loop">Deep Loop</option>
            </select>
          </label>
          <label>
            Status{' '}
            <select
              value={sessionStatus}
              onChange={(event) => setSessionStatus(event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="active">In progress</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option value="abandoned">Abandoned</option>
            </select>
          </label>
          <span>Filters apply to the {page.items.length} loaded sessions.</span>
        </div>
      )}
      {status === 'loading' && <p role="status">Loading history…</p>}
      {status === 'error' && (
        <div role="alert">
          <p>History couldn’t be loaded.</p>
          <Button onClick={() => void refresh()}>Try again</Button>
        </div>
      )}
      {status === 'ready' && page.items.length === 0 && (
        <EmptyState
          icon={History}
          title="No practice sessions yet"
          data-testid="interviews-history-empty"
        >
          <p>Start a practice in Prepare to see it here.</p>
        </EmptyState>
      )}
      {status === 'ready' && page.items.length > 0 && (
        <>
          <ul className="history-list" aria-label="Practice sessions">
            {visible.map((item) => (
              <HistorySessionRow
                key={item.id}
                item={item}
                snapshot={page.snapshots[item.id]}
                onOpen={() => {
                  returnFocus.current = item.id;
                  setSelected(item.id);
                }}
                onResume={() => onOpenSession(item.id)}
              />
            ))}
          </ul>
          {visible.length === 0 && (
            <p>No loaded sessions match these filters.</p>
          )}
          {moreError && (
            <p role="alert">More sessions couldn’t be loaded. Try again.</p>
          )}
          {page.nextCursor && (
            <Button variant="secondary" onClick={() => void loadMore()}>
              Load more sessions
            </Button>
          )}
        </>
      )}
    </div>
  );
}
