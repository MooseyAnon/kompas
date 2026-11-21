import React from 'react';
import {
  AlertTriangle,
  CircleCheck,
  CirclePause,
  Play,
  Repeat,
  RotateCw,
  Settings,
  Sprout,
  Zap,
} from 'lucide-react';
import type { InterviewWorkflowState } from '../../../../shared/contracts';
import { Button } from '../../../presentation/components/Button';
import { InterviewStatusBubble } from '../../../presentation/components/interviews/InterviewStatusBubble';
import { SessionPanel } from '../../../presentation/components/interviews/SessionPanel';
import { DeepLoopRunner } from '../deep-loop/DeepLoopRunner';
import { QuickFireResults } from '../quick-fire/QuickFireResults';
import { QuickFireRunner } from '../quick-fire/QuickFireRunner';
import { QuickFireSessionBar } from '../quick-fire/QuickFireSessionBar';
import { selectSessionView, type SessionView } from './sessionView';
import { statusCopy } from './statusCopy';
import { useSessionWorkflow, type SessionWorkflow } from './useSessionWorkflow';
import './SessionOutlet.css';

/**
 * Focused session outlet, entered by session id. It reads the workflow
 * snapshot and polls only while work runs; it never starts, pauses or
 * cancels work on its own. 07.2 covers the journey up to the first question;
 * the method runners take over from there.
 */
export function SessionOutlet({
  sessionId,
  initialState,
  onOpenLocalAi,
}: {
  sessionId: string;
  initialState?: InterviewWorkflowState;
  onOpenLocalAi: () => void;
}) {
  const workflow = useSessionWorkflow(sessionId, initialState);
  const { load, actionError, refresh } = workflow;

  return (
    <div
      className="session-outlet"
      data-testid="interviews-session-outlet"
      data-session-id={sessionId}
    >
      {load.status === 'loading' && (
        <p className="session-quiet" role="status">
          Loading interview…
        </p>
      )}

      {load.status === 'error' && (
        <SessionPanel
          icon={AlertTriangle}
          tone="error"
          title="This interview couldn’t be loaded"
          data-testid="session-load-error"
        >
          <p>{load.message}</p>
          <div className="session-actions">
            <Button
              variant="secondary"
              leadingIcon={<RotateCw aria-hidden="true" />}
              onClick={refresh}
            >
              Try again
            </Button>
          </div>
        </SessionPanel>
      )}

      {load.status === 'ready' && (
        <ReadySession
          state={load.state}
          workflow={workflow}
          actionError={actionError}
          onOpenLocalAi={onOpenLocalAi}
        />
      )}
    </div>
  );
}

function ReadySession({
  state,
  workflow,
  actionError,
  onOpenLocalAi,
}: {
  state: InterviewWorkflowState;
  workflow: SessionWorkflow;
  actionError: string | null;
  onOpenLocalAi: () => void;
}) {
  const view = selectSessionView(state);
  const quickFire = state.session.method === 'quick_fire';
  const deepLoopRunner = showDeepLoopRunner(view, state);
  // The answer composer shows command errors beside the answer itself.
  const composerShowsError =
    view.kind === 'runner' &&
    state.currentQuestion !== null &&
    state.availableActions.includes('answer');

  return (
    <>
      {quickFire && <QuickFireSessionBar state={state} workflow={workflow} />}
      {!quickFire && !deepLoopRunner && <SessionSummary state={state} />}
      <SessionBody
        view={view}
        state={state}
        workflow={workflow}
        onOpenLocalAi={onOpenLocalAi}
      />
      {actionError && !composerShowsError && (
        <p className="session-action-error" role="alert">
          {actionError}
        </p>
      )}
    </>
  );
}

function SessionSummary({ state }: { state: InterviewWorkflowState }) {
  const { session } = state;
  const quickFire = session.method === 'quick_fire';
  const MethodIcon = quickFire ? Zap : Repeat;
  const meta = [
    session.targetSnapshot?.role,
    quickFire && session.questionCount
      ? `${session.questionCount} questions`
      : null,
  ].filter(Boolean);

  return (
    <header className="session-summary" data-testid="session-summary">
      <span className="session-method">
        <MethodIcon size={15} aria-hidden="true" />
        {quickFire ? 'Quick-fire' : 'Deep Loop'}
      </span>
      <h2>{session.subject}</h2>
      {meta.length > 0 && (
        <span className="session-meta">{meta.join(' · ')}</span>
      )}
    </header>
  );
}

function SessionBody({
  view,
  state,
  workflow,
  onOpenLocalAi,
}: {
  view: SessionView;
  state: InterviewWorkflowState;
  workflow: SessionWorkflow;
  onOpenLocalAi: () => void;
}) {
  const { pending } = workflow;
  const onIntent = (intent: 'continue' | 'retry') => void workflow.act(intent);

  if (showDeepLoopRunner(view, state))
    return (
      <DeepLoopRunner
        state={state}
        workflow={workflow}
        onOpenLocalAi={onOpenLocalAi}
      />
    );

  switch (view.kind) {
    case 'preparing':
      return (
        <InterviewStatusBubble
          variant="large"
          icon={statusCopy.first_question.icon}
          label={statusCopy.first_question.label}
          phrases={statusCopy.first_question.phrases}
          data-testid="session-preparing"
        >
          <p className="session-note">
            You can go back at any time; preparation carries on.
          </p>
        </InterviewStatusBubble>
      );

    case 'failed':
      return (
        <SessionPanel
          icon={AlertTriangle}
          tone="error"
          title={
            view.cancelled
              ? 'Preparing the first question was cancelled'
              : 'The first question couldn’t be prepared'
          }
          data-testid="session-failed"
        >
          <p>
            {view.message ??
              'Your local model didn’t finish. Check Local AI settings, then try again.'}
          </p>
          <div className="session-actions">
            {view.canRetry && (
              <Button
                leadingIcon={<RotateCw aria-hidden="true" />}
                disabled={pending !== null}
                onClick={() => onIntent('retry')}
                data-testid="session-retry"
              >
                {pending === 'retry' ? 'Retrying…' : 'Try again'}
              </Button>
            )}
            {!view.cancelled && (
              <Button
                variant="secondary"
                leadingIcon={<Settings aria-hidden="true" />}
                onClick={onOpenLocalAi}
                data-testid="session-open-settings"
              >
                Open Local AI settings
              </Button>
            )}
          </div>
        </SessionPanel>
      );

    case 'paused':
      return (
        <SessionPanel
          icon={CirclePause}
          title="This interview is paused"
          data-testid="session-paused"
        >
          <p>
            Your saved questions and answers are kept. Resuming continues where
            it stopped.
          </p>
          {view.canResume && (
            <div className="session-actions">
              <Button
                leadingIcon={<Play aria-hidden="true" />}
                disabled={pending !== null}
                onClick={() => onIntent('continue')}
                data-testid="session-resume"
              >
                {pending === 'continue' ? 'Resuming…' : 'Resume interview'}
              </Button>
            </div>
          )}
        </SessionPanel>
      );

    case 'stalled':
      return (
        <SessionPanel
          icon={Sprout}
          title="The first question isn’t being prepared"
          data-testid="session-stalled"
        >
          <p>
            Nothing is running for this interview right now, for example after
            the app was closed.
          </p>
          {view.canContinue && (
            <div className="session-actions">
              <Button
                leadingIcon={<Play aria-hidden="true" />}
                disabled={pending !== null}
                onClick={() => onIntent('continue')}
                data-testid="session-continue"
              >
                {pending === 'continue'
                  ? 'Starting…'
                  : 'Prepare first question'}
              </Button>
            </div>
          )}
        </SessionPanel>
      );

    case 'runner':
      if (state.session.method === 'quick_fire')
        return (
          <QuickFireRunner
            state={state}
            workflow={workflow}
            onOpenLocalAi={onOpenLocalAi}
          />
        );
      return null;

    case 'draft':
      return (
        <SessionPanel
          icon={Sprout}
          title="This interview hasn’t started"
          data-testid="session-draft"
        >
          <p>Go back to Prepare to edit or start it.</p>
        </SessionPanel>
      );

    case 'finished':
      if (
        view.outcome === 'completed' &&
        state.session.method === 'quick_fire' &&
        state.result
      )
        return (
          <QuickFireResults
            sessionId={state.session.id}
            result={state.result}
          />
        );
      return (
        <SessionPanel
          icon={CircleCheck}
          title={
            view.outcome === 'completed'
              ? 'This interview is complete'
              : 'This interview was abandoned'
          }
          data-testid="session-finished"
        >
          <p>It can’t be resumed. Start a new practice from Prepare.</p>
        </SessionPanel>
      );
  }
}

/** Preserve the saved conversation during pause and recovery after Q1 exists. */
function showDeepLoopRunner(view: SessionView, state: InterviewWorkflowState) {
  return (
    state.session.method === 'deep_loop' &&
    (view.kind === 'runner' ||
      view.kind === 'finished' ||
      ((view.kind === 'paused' || view.kind === 'failed') &&
        (state.currentQuestion !== null || state.progress.questionCount > 0)))
  );
}
