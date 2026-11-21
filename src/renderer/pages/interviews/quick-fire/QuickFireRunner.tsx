import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CircleCheck,
  ClipboardCheck,
  Play,
  RotateCw,
  Settings,
  Sprout,
} from 'lucide-react';
import type { InterviewWorkflowState } from '../../../../shared/contracts';
import { Button } from '../../../presentation/components/Button';
import { InterviewQuestionCard } from '../../../presentation/components/interviews/InterviewQuestionCard';
import { InterviewStatusBubble } from '../../../presentation/components/interviews/InterviewStatusBubble';
import { SessionPanel } from '../../../presentation/components/interviews/SessionPanel';
import { SessionAnswer } from '../answer/SessionAnswer';
import type { CreateVoiceRecorder } from '../answer/useVoiceAnswer';
import { SessionWorkStatus } from '../session/SessionWorkStatus';
import { statusCopy } from '../session/statusCopy';
import type { SessionWorkflow } from '../session/useSessionWorkflow';
import { selectWorkStatus } from '../session/workStatus';
import {
  quickFirePosition,
  selectQuickFireStage,
  type QuickFireFailure,
} from './quickFireView';
import { useQuickFireResults } from './useQuickFireResults';
import './QuickFire.css';

const QUESTION_TEXT_ID = 'quick-fire-question-text';

const failureTitles: Record<
  QuickFireFailure['scope'],
  { failed: string; cancelled: string }
> = {
  questions: {
    failed: 'The next question couldn’t be prepared',
    cancelled: 'Preparing the next question was stopped',
  },
  checks: {
    failed: 'Your answers couldn’t be checked',
    cancelled: 'Checking your answers was stopped',
  },
  results: {
    failed: 'Your results couldn’t be prepared',
    cancelled: 'Preparing your results was stopped',
  },
};

/**
 * Quick-fire once the first question exists: one question card, a separate
 * answer card, and neutral status for the work the backend reports. It only
 * sends advertised intents through the session controller and never shows
 * review outcomes; those appear in `QuickFireResults` after publication.
 */
export function QuickFireRunner({
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
  const results = useQuickFireResults(state, workflow);
  const stage = selectQuickFireStage(state, results);
  const status = selectWorkStatus(state, {
    resultsRequested: results.requested,
  });
  const position = quickFirePosition(state);
  const { pending } = workflow;
  const announcement = useSavedAnnouncement(position.answered);

  function recover(failure: QuickFireFailure) {
    if (failure.recovery === 'retry') void workflow.act('retry');
    else if (failure.recovery === 'request_results') results.request();
  }

  let body: React.ReactNode;
  switch (stage.kind) {
    case 'answering': {
      const failure = stage.backgroundFailure;
      body = (
        <div className="quick-fire-answering">
          <InterviewQuestionCard
            question={stage.question.question}
            competency={stage.question.competency}
            role={state.session.targetSnapshot?.role}
            position={`Question ${position.current ?? position.total} of ${position.total}`}
            textId={QUESTION_TEXT_ID}
            data-testid="session-question"
          />
          <SessionAnswer
            key={stage.question.id}
            sessionId={state.session.id}
            question={stage.question}
            questionTextId={QUESTION_TEXT_ID}
            canAnswer={
              state.availableActions.includes('answer') && pending === null
            }
            submit={workflow.submitAnswer}
            error={workflow.actionError}
            hint="Feedback comes at the end, when you ask for results."
            createRecorder={createRecorder}
          />
          {failure ? (
            <div
              className="quick-fire-inline-alert"
              role="alert"
              data-testid="quick-fire-background-error"
            >
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                {failure.scope === 'questions'
                  ? 'Your later questions couldn’t be prepared.'
                  : 'Some background work didn’t finish.'}{' '}
                {failure.cancelled
                  ? 'It was stopped.'
                  : (failure.message ?? 'Your local model didn’t finish.')}{' '}
                You can keep answering.
              </span>
              {failure.recovery && (
                <Button
                  variant="secondary"
                  leadingIcon={<RotateCw aria-hidden="true" />}
                  disabled={pending !== null}
                  onClick={() => recover(failure)}
                  data-testid="quick-fire-background-retry"
                >
                  {pending === 'retry' ? 'Retrying…' : 'Try again'}
                </Button>
              )}
            </div>
          ) : (
            <SessionWorkStatus
              status={status}
              data-testid="quick-fire-background"
            />
          )}
        </div>
      );
      break;
    }

    case 'awaiting_question':
      body = (
        <SessionWorkStatus
          status={status}
          data-testid="quick-fire-next-pending"
        >
          <p className="quick-fire-saved">
            <CircleCheck size={14} aria-hidden="true" />
            Answer saved. Your next question appears here as soon as it’s ready.
          </p>
        </SessionWorkStatus>
      );
      break;

    case 'stalled':
      body = (
        <SessionPanel
          icon={Sprout}
          title="The next question isn’t being prepared"
          data-testid="quick-fire-stalled"
        >
          <p>
            Your answers are saved. Nothing is running for this interview right
            now, for example after the app was closed.
          </p>
          {stage.canContinue && (
            <div className="session-actions">
              <Button
                leadingIcon={<Play aria-hidden="true" />}
                disabled={pending !== null}
                onClick={() => void workflow.act('continue')}
                data-testid="quick-fire-continue"
              >
                {pending === 'continue' ? 'Starting…' : 'Prepare next question'}
              </Button>
            </div>
          )}
        </SessionPanel>
      );
      break;

    case 'ready_for_results':
      body = (
        <SessionPanel
          icon={ClipboardCheck}
          title={`All ${position.total} answers saved`}
          data-testid="quick-fire-all-answered"
        >
          <p>
            Feedback stays private until you ask for it. Your answers are
            checked first, then your results are put together.
          </p>
          {stage.canRequest && (
            <div className="session-actions">
              <Button
                leadingIcon={<BarChart3 aria-hidden="true" />}
                disabled={pending !== null}
                onClick={results.request}
                data-testid="quick-fire-request-results"
              >
                {pending === 'request_results'
                  ? 'Requesting…'
                  : 'Get my results'}
              </Button>
            </div>
          )}
          <SessionWorkStatus status={status} data-testid="quick-fire-checks" />
        </SessionPanel>
      );
      break;

    case 'results_pending': {
      const copy =
        statusCopy[status.kind === 'running' ? status.category : 'synthesis'];
      body = (
        <InterviewStatusBubble
          variant="large"
          icon={copy.icon}
          label={copy.label}
          phrases={copy.phrases}
          data-testid="quick-fire-results-pending"
        >
          <p className="session-note">
            This can take a little while with a local model.
          </p>
        </InterviewStatusBubble>
      );
      break;
    }

    case 'failed': {
      const { failure } = stage;
      const titles = failureTitles[failure.scope];
      body = (
        <SessionPanel
          icon={AlertTriangle}
          tone="error"
          title={failure.cancelled ? titles.cancelled : titles.failed}
          data-testid="quick-fire-failed"
        >
          <p>
            {failure.cancelled
              ? 'Your saved answers are kept. Try again when you’re ready.'
              : (failure.message ??
                'Your local model didn’t finish. Check Local AI settings, then try again.')}
          </p>
          <div className="session-actions">
            {failure.recovery && (
              <Button
                leadingIcon={<RotateCw aria-hidden="true" />}
                disabled={pending !== null}
                onClick={() => recover(failure)}
                data-testid="quick-fire-retry"
              >
                {pending === 'retry' || pending === 'request_results'
                  ? 'Retrying…'
                  : 'Try again'}
              </Button>
            )}
            {!failure.cancelled && (
              <Button
                variant="secondary"
                leadingIcon={<Settings aria-hidden="true" />}
                onClick={onOpenLocalAi}
                data-testid="quick-fire-open-settings"
              >
                Open Local AI settings
              </Button>
            )}
          </div>
        </SessionPanel>
      );
      break;
    }
  }

  return (
    <div className="quick-fire-runner" data-testid="session-runner">
      {body}
      <p className="quick-fire-sr-only" role="status">
        {announcement}
      </p>
    </div>
  );
}

/** Announces each newly saved answer once, without repeating on re-render. */
function useSavedAnnouncement(answered: number) {
  const previous = useRef(answered);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (answered > previous.current) setMessage(`Answer ${answered} saved.`);
    previous.current = answered;
  }, [answered]);

  return message;
}
