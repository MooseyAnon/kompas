import React from 'react';
import { Repeat, Zap } from 'lucide-react';
import type {
  InsightsSession,
  InterviewWorkflowState,
} from '../../../../shared/contracts';
import { Button } from '../Button';
import { Card } from '../Card';

export function HistorySessionRow({
  item,
  snapshot,
  onOpen,
  onResume,
}: {
  item: InsightsSession;
  snapshot?: InterviewWorkflowState;
  onOpen: () => void;
  onResume: () => void;
}) {
  const quick = item.method === 'quick_fire';
  const Icon = quick ? Zap : Repeat;
  const paused =
    item.status === 'active' && snapshot?.session.phase === 'paused';
  const label =
    item.status === 'active'
      ? paused
        ? 'Paused'
        : 'In progress'
      : item.status;
  const score =
    item.status === 'completed' ? snapshot?.result?.averageScore : null;
  return (
    <li>
      <Card padding="compact" className="history-row">
        <span
          className="history-method"
          aria-label={quick ? 'Quick-fire' : 'Deep Loop'}
        >
          <Icon size={18} aria-hidden="true" />
        </span>
        <div className="history-row-main">
          <strong>{item.subject}</strong>
          <span>
            {quick ? 'Quick-fire' : 'Deep Loop'} ·{' '}
            {new Date(item.completedAt ?? item.createdAt).toLocaleString()}
            {item.targetRole ? ` · ${item.targetRole}` : ''}
          </span>
        </div>
        <span className="history-state">{label}</span>
        <span
          className="history-score"
          aria-label={`Score: ${score === null || score === undefined ? 'not available' : `${Math.round(score)} out of 100`}`}
        >
          {score === null || score === undefined
            ? '—'
            : `${Math.round(score)} / 100`}
        </span>
        <div className="history-row-actions">
          <Button
            variant="secondary"
            id={`history-open-${item.id}`}
            onClick={onOpen}
          >
            {item.status === 'completed' && snapshot?.result
              ? 'Open results'
              : 'View transcript'}
          </Button>
          {snapshot?.availableActions.includes('continue') && (
            <Button variant="ghost" onClick={onResume}>
              Resume
            </Button>
          )}
        </div>
      </Card>
    </li>
  );
}
