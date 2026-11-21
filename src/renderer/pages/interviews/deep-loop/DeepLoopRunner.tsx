import React from 'react';
import {
  AlertTriangle,
  BarChart3,
  CirclePause,
  Play,
  Repeat,
  RotateCw,
  Settings,
  Sprout,
  Trash2,
} from 'lucide-react';
import type { InterviewWorkflowState } from '../../../../shared/contracts';
import { Button } from '../../../presentation/components/Button';
import { DeepLoopConversation } from '../../../presentation/components/interviews/DeepLoopConversation';
import {
  InterviewActionBar,
  type InterviewAction,
} from '../../../presentation/components/interviews/InterviewActionBar';
import { InterviewResultSummary } from '../../../presentation/components/interviews/InterviewResultSummary';
import { InterviewSessionBar } from '../../../presentation/components/interviews/InterviewSessionBar';
import { SessionPanel } from '../../../presentation/components/interviews/SessionPanel';
import { SessionAnswer } from '../answer/SessionAnswer';
import type { CreateVoiceRecorder } from '../answer/useVoiceAnswer';
import { SessionWorkStatus } from '../session/SessionWorkStatus';
import { isPausedPhase } from '../session/sessionView';
import type { SessionWorkflow } from '../session/useSessionWorkflow';
import { selectWorkStatus } from '../session/workStatus';
import { useDeepLoopHistory } from './useDeepLoopHistory';
import './DeepLoopRunner.css';

/** The view chooses only advertised intents. The saved Insights projection is
 * the source of conversation history; the snapshot owns the current task. */
export function DeepLoopRunner({
  state,
  workflow,
  onOpenLocalAi,
  createRecorder,
}: {
  state: InterviewWorkflowState;
  workflow: SessionWorkflow;
  onOpenLocalAi: () => void;
  createRecorder?: CreateVoiceRecorder;
}) {
  const { load, reload } = useDeepLoopHistory(state);
  const { session, availableActions, progress, currentQuestion, deepLoop } =
    state;
  const status = selectWorkStatus(state);
  const paused = isPausedPhase(session.phase);
  const terminal =
    session.status === 'completed' || session.status === 'abandoned';
  const actionable = workflow.pending === null;
  const actions: InterviewAction[] = [];
  const trailing: InterviewAction[] = [];
  const intent = (
    action: 'continue' | 'retry' | 'request_coaching' | 'request_reassessment',
  ) => void workflow.act(action);

  if (availableActions.includes('retry'))
    actions.push({
      id: 'retry',
      label: 'Try again',
      icon: RotateCw,
      disabled: !actionable,
      busy: workflow.pending === 'retry',
      onSelect: () => intent('retry'),
    });
  if (availableActions.includes('continue'))
    actions.push({
      id: 'continue',
      label: paused
        ? 'Resume interview'
        : status.kind === 'failed'
          ? 'Skip follow-up and review'
          : 'Continue to a new question',
      icon: Play,
      disabled: !actionable,
      busy: workflow.pending === 'continue',
      onSelect: () => intent('continue'),
    });
  if (availableActions.includes('request_coaching'))
    actions.push({
      id: 'request_coaching',
      label: 'Request coaching',
      icon: Sprout,
      disabled: !actionable,
      busy: workflow.pending === 'request_coaching',
      onSelect: () => intent('request_coaching'),
    });
  if (availableActions.includes('request_reassessment'))
    actions.push({
      id: 'request_reassessment',
      label: 'Try reassessment',
      icon: Repeat,
      disabled: !actionable,
      busy: workflow.pending === 'request_reassessment',
      onSelect: () => intent('request_reassessment'),
    });
  if (availableActions.includes('request_results'))
    actions.push({
      id: 'request_results',
      label: 'Get my results',
      icon: BarChart3,
      variant: 'primary',
      disabled: !actionable,
      busy: workflow.pending === 'request_results',
      onSelect: () => void workflow.requestResults(),
    });
  if (availableActions.includes('pause'))
    trailing.push({
      id: 'pause',
      label: 'Pause',
      icon: CirclePause,
      disabled: !actionable,
      busy: workflow.pending === 'pause',
      onSelect: () => void workflow.pause(),
    });
  if (availableActions.includes('abandon'))
    trailing.push({
      id: 'abandon',
      label: 'Abandon',
      icon: Trash2,
      variant: 'ghost',
      disabled: !actionable,
      busy: workflow.pending === 'abandon',
      confirm: {
        message: 'Abandon this interview? It can’t be resumed.',
        confirmLabel: 'Abandon',
      },
      onSelect: () => void workflow.abandon(),
    });

  const hasAnswer =
    availableActions.includes('answer') && currentQuestion !== null && !paused;
  const detail = load.status === 'ready' ? load.detail : null;

  return (
    <div className="deep-loop-runner" data-testid="session-runner">
      <InterviewSessionBar
        icon={Repeat}
        method="Deep Loop"
        title={session.subject}
        meta={session.targetSnapshot?.role}
        progress={
          terminal
            ? null
            : `${progress.questionCount} question${progress.questionCount === 1 ? '' : 's'} · ${progress.answeredCount} answer${progress.answeredCount === 1 ? '' : 's'} saved${paused ? ' · Paused' : ''}`
        }
        actions={
          hasAnswer && trailing.length > 0 ? (
            <InterviewActionBar
              label="Session actions"
              actions={[]}
              trailing={trailing}
              data-testid="deep-loop-actions"
            />
          ) : null
        }
        data-testid="session-summary"
      />
      {load.status === 'loading' && (
        <p className="session-quiet" role="status">
          Loading saved conversation…
        </p>
      )}
      {load.status === 'error' && (
        <div className="deep-loop-history-error" role="alert">
          {load.message}{' '}
          <Button variant="secondary" onClick={reload}>
            Try loading again
          </Button>
        </div>
      )}
      {(detail || currentQuestion) && (
        <DeepLoopConversation
          detail={detail}
          currentQuestion={currentQuestion}
          currentIsReassessment={deepLoop?.isReassessment ?? false}
          role={session.targetSnapshot?.role ?? null}
        />
      )}
      {status.kind === 'running' && (
        <div className="deep-loop-inline-status">
          <SessionWorkStatus status={status} />
        </div>
      )}
      {status.kind === 'failed' && (
        <SessionPanel
          icon={AlertTriangle}
          tone="error"
          title={
            status.cancelled
              ? 'This step was stopped'
              : 'This step couldn’t finish'
          }
          data-testid="deep-loop-failed"
        >
          <p>
            {status.message ??
              'Your saved answers are kept. Check Local AI settings, then choose an available action.'}
          </p>
          {!status.cancelled && (
            <Button
              variant="secondary"
              leadingIcon={<Settings aria-hidden="true" />}
              onClick={onOpenLocalAi}
            >
              Open Local AI settings
            </Button>
          )}
        </SessionPanel>
      )}
      {paused && (
        <SessionPanel
          icon={CirclePause}
          title="This interview is paused"
          data-testid="session-paused"
        >
          <p>Your saved conversation is kept. Resume when you’re ready.</p>
        </SessionPanel>
      )}
      {!terminal &&
        status.kind === 'idle' &&
        !paused &&
        !hasAnswer &&
        actions.length === 0 && (
          <SessionPanel
            icon={Sprout}
            title="Waiting to continue"
            data-testid="deep-loop-stalled"
          >
            <p>
              Your saved conversation is kept. Reopen the interview from Prepare
              if work was interrupted.
            </p>
          </SessionPanel>
        )}
      {deepLoop?.recommendation && !terminal && (
        <p className="deep-loop-recommendation">{deepLoop.recommendation}</p>
      )}
      {session.status === 'completed' && state.result && (
        <InterviewResultSummary
          title="Your Deep Loop results"
          averageScore={state.result.averageScore}
          passCount={state.result.passCount}
          failCount={state.result.failCount}
          unscoredCount={state.result.unscoredCount}
          recommendation={state.result.recommendation}
          narrative={state.result.narrative ?? null}
          narrativeUnavailable={state.result.narrativeUnavailable ?? false}
        />
      )}
      {session.status === 'abandoned' && (
        <SessionPanel
          icon={CirclePause}
          title="This interview was abandoned"
          data-testid="session-finished"
        >
          <p>It can’t be resumed. Your saved conversation remains above.</p>
        </SessionPanel>
      )}
      {hasAnswer && currentQuestion && (
        <div className="deep-loop-composer">
          <SessionAnswer
            key={currentQuestion.id}
            sessionId={session.id}
            question={currentQuestion}
            questionTextId="deep-loop-question-text"
            canAnswer={actionable}
            submit={workflow.submitAnswer}
            error={workflow.actionError}
            hint="Your response is saved only when you select Submit."
            createRecorder={createRecorder}
          />
        </div>
      )}
      {(actions.length > 0 || (!hasAnswer && trailing.length > 0)) && (
        <div className="deep-loop-actions">
          <InterviewActionBar
            label="Deep Loop choices"
            actions={actions}
            trailing={hasAnswer ? [] : trailing}
            data-testid="deep-loop-actions"
          />
        </div>
      )}
    </div>
  );
}
