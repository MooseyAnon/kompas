import React from 'react';
import { CirclePause, Trash2, Zap } from 'lucide-react';
import type { InterviewWorkflowState } from '../../../../shared/contracts';
import {
  InterviewActionBar,
  type InterviewAction,
} from '../../../presentation/components/interviews/InterviewActionBar';
import { InterviewProgress } from '../../../presentation/components/interviews/InterviewProgress';
import { InterviewSessionBar } from '../../../presentation/components/interviews/InterviewSessionBar';
import type { SessionWorkflow } from '../session/useSessionWorkflow';
import { quickFirePosition, quickFireProgressLabel } from './quickFireView';

/**
 * Quick-fire header: subject, `Question N of T`, the real answered count and
 * the advertised Pause / Abandon actions. Leaving is the page's Back button,
 * which has no backend effect.
 */
export function QuickFireSessionBar({
  state,
  workflow,
}: {
  state: InterviewWorkflowState;
  workflow: Pick<SessionWorkflow, 'pending' | 'pause' | 'abandon'>;
}) {
  const { session, availableActions } = state;
  const position = quickFirePosition(state);
  const terminal =
    session.status === 'completed' || session.status === 'abandoned';

  const actions: InterviewAction[] = [];
  if (availableActions.includes('pause'))
    actions.push({
      id: 'pause',
      label: 'Pause',
      icon: CirclePause,
      busy: workflow.pending === 'pause',
      busyLabel: 'Pausing…',
      disabled: workflow.pending !== null,
      onSelect: () => void workflow.pause(),
    });
  if (availableActions.includes('abandon'))
    actions.push({
      id: 'abandon',
      label: 'Abandon',
      icon: Trash2,
      variant: 'ghost',
      busy: workflow.pending === 'abandon',
      busyLabel: 'Abandoning…',
      disabled: workflow.pending !== null,
      confirm: {
        message: 'Abandon this interview? It can’t be resumed.',
        confirmLabel: 'Abandon',
      },
      onSelect: () => void workflow.abandon(),
    });

  return (
    <InterviewSessionBar
      icon={Zap}
      method="Quick-fire"
      title={session.subject}
      meta={session.targetSnapshot?.role}
      progress={
        terminal ? null : (
          <InterviewProgress
            label={quickFireProgressLabel(position)}
            total={position.total}
            completed={position.answered}
            current={position.current}
            detail={`${position.answered} answered`}
            data-testid="quick-fire-progress"
          />
        )
      }
      actions={
        actions.length > 0 ? (
          <InterviewActionBar
            label="Session actions"
            actions={[]}
            trailing={actions}
            data-testid="quick-fire-actions"
          />
        ) : null
      }
      data-testid="session-summary"
    />
  );
}
