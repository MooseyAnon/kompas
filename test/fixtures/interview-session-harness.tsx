import React from 'react';
import {
  BarChart3,
  CirclePause,
  Lightbulb,
  Play,
  RefreshCcw,
  RotateCw,
  SkipForward,
  Square,
  Trash2,
  Zap,
} from 'lucide-react';
import { SessionAnswer } from '../../src/renderer/pages/interviews/answer/SessionAnswer';
import type { CreateVoiceRecorder } from '../../src/renderer/pages/interviews/answer/useVoiceAnswer';
import { SessionWorkStatus } from '../../src/renderer/pages/interviews/session/SessionWorkStatus';
import { useSessionWorkflow } from '../../src/renderer/pages/interviews/session/useSessionWorkflow';
import { selectWorkStatus } from '../../src/renderer/pages/interviews/session/workStatus';
import {
  InterviewActionBar,
  type InterviewAction,
} from '../../src/renderer/presentation/components/interviews/InterviewActionBar';
import { InterviewCoachingCard } from '../../src/renderer/presentation/components/interviews/InterviewCoachingCard';
import { InterviewPhaseBadge } from '../../src/renderer/presentation/components/interviews/InterviewPhaseBadge';
import { InterviewProgress } from '../../src/renderer/presentation/components/interviews/InterviewProgress';
import { InterviewQuestionCard } from '../../src/renderer/presentation/components/interviews/InterviewQuestionCard';
import { InterviewReviewCard } from '../../src/renderer/presentation/components/interviews/InterviewReviewCard';

/**
 * Test-only composition of the 07.3 primitives over the real session and
 * answer controllers, as either runner would use them. Not shipped.
 */
export function SessionHarness({
  sessionId,
  resultsRequested = false,
  createRecorder,
}: {
  sessionId: string;
  resultsRequested?: boolean;
  createRecorder?: CreateVoiceRecorder;
}) {
  const workflow = useSessionWorkflow(sessionId);
  const { load, pending } = workflow;

  if (load.status === 'loading')
    return <p data-testid="harness-loading">Loading…</p>;
  if (load.status === 'error')
    return <p data-testid="harness-error">{load.message}</p>;

  const { state } = load;
  const status = selectWorkStatus(state, { resultsRequested });
  const offered = (action: (typeof state.availableActions)[number]) =>
    state.availableActions.includes(action);
  const question = state.currentQuestion;
  const busy = (id: string) => pending === id;

  const actions: InterviewAction[] = [];
  if (status.kind === 'failed' && status.canRetry)
    actions.push({
      id: 'retry',
      label: 'Try again',
      icon: RotateCw,
      variant: 'primary',
      busy: busy('retry'),
      busyLabel: 'Retrying…',
      onSelect: () => void workflow.act('retry'),
    });
  if (offered('continue') && !question)
    actions.push({
      id: 'continue',
      label: status.kind === 'paused' ? 'Resume' : 'Continue',
      icon: status.kind === 'paused' ? Play : SkipForward,
      busy: busy('continue'),
      onSelect: () => void workflow.act('continue'),
    });
  if (offered('request_coaching'))
    actions.push({
      id: 'request_coaching',
      label: 'Request coaching',
      icon: Lightbulb,
      onSelect: () => void workflow.act('request_coaching'),
    });
  if (offered('request_reassessment'))
    actions.push({
      id: 'request_reassessment',
      label: 'Try again with feedback',
      icon: RefreshCcw,
      onSelect: () => void workflow.act('request_reassessment'),
    });
  if (offered('request_results'))
    actions.push({
      id: 'request_results',
      label: 'See results',
      icon: BarChart3,
      busy: busy('request_results'),
      onSelect: () => void workflow.requestResults(),
    });
  if (state.operationId !== null)
    actions.push({
      id: 'cancel_operation',
      label: 'Stop this step',
      icon: Square,
      variant: 'ghost',
      busy: busy('cancel_operation'),
      onSelect: () => void workflow.cancelOperation(),
    });

  const trailing: InterviewAction[] = [];
  if (offered('pause'))
    trailing.push({
      id: 'pause',
      label: 'Pause',
      icon: CirclePause,
      busy: busy('pause'),
      onSelect: () => void workflow.pause(),
    });
  if (offered('abandon'))
    trailing.push({
      id: 'abandon',
      label: 'Abandon',
      icon: Trash2,
      variant: 'ghost',
      busy: busy('abandon'),
      confirm: {
        message: 'Abandon this interview? It can’t be resumed.',
        confirmLabel: 'Abandon',
      },
      onSelect: () => void workflow.abandon(),
    });

  return (
    <div data-testid="harness">
      <header>
        <InterviewPhaseBadge
          icon={Zap}
          label={status.kind === 'paused' ? 'Paused' : state.session.status}
          tone={status.kind === 'paused' ? 'paused' : 'active'}
          data-testid="harness-phase"
        />
        <InterviewProgress
          label={`${state.progress.answeredCount} of ${state.progress.questionCount} answered`}
          total={state.progress.questionCount}
          completed={state.progress.answeredCount}
          data-testid="harness-progress"
        />
      </header>

      <SessionWorkStatus status={status} />
      {status.kind === 'failed' && (
        <p role="alert" data-testid="harness-failed">
          {status.message}
        </p>
      )}

      {question && (
        <>
          <InterviewQuestionCard
            question={question.question}
            competency={question.competency}
            textId="harness-question-text"
            data-testid="harness-question"
          />
          <SessionAnswer
            key={question.id}
            sessionId={sessionId}
            question={question}
            questionTextId="harness-question-text"
            canAnswer={offered('answer') && pending === null}
            submit={workflow.submitAnswer}
            error={workflow.actionError}
            createRecorder={createRecorder}
          />
        </>
      )}

      {state.feedback?.review && (
        <InterviewReviewCard review={state.feedback.review} />
      )}
      {state.feedback?.coaching && (
        <InterviewCoachingCard coaching={state.feedback.coaching} />
      )}

      <InterviewActionBar
        label="Session actions"
        actions={actions}
        trailing={trailing}
      />
    </div>
  );
}
