import React from 'react';
import type { InterviewQuestionView } from '../../../../shared/contracts';
import { InterviewAnswerComposer } from '../../../presentation/components/interviews/InterviewAnswerComposer';
import { InterviewVoicePanel } from '../../../presentation/components/interviews/InterviewVoicePanel';
import type { AnswerSubmission } from '../session/useSessionWorkflow';
import { useAnswerComposer } from './useAnswerComposer';
import type { CreateVoiceRecorder } from './useVoiceAnswer';

/**
 * Type-or-record answer area shared by Quick-fire and Deep Loop. Render it
 * with `key={question.id}` so each question gets its own draft and voice
 * state. `canAnswer` must come from `availableActions`; this never decides
 * on its own that an answer may be sent.
 */
export function SessionAnswer({
  sessionId,
  question,
  questionTextId,
  canAnswer,
  submit,
  error,
  hint,
  createRecorder,
}: {
  sessionId: string;
  question: InterviewQuestionView;
  questionTextId?: string;
  canAnswer: boolean;
  submit: (answer: AnswerSubmission) => Promise<boolean>;
  error?: string | null;
  hint?: string;
  createRecorder?: CreateVoiceRecorder;
}) {
  const composer = useAnswerComposer({
    sessionId,
    questionId: question.id,
    canAnswer,
    submit,
    createRecorder,
  });
  const { voice } = composer;

  return (
    <InterviewAnswerComposer
      id={composer.inputId}
      value={composer.text}
      onChange={composer.setText}
      onSubmit={() => void composer.submit()}
      canSubmit={composer.canSubmit}
      submitting={composer.submitting}
      maxLength={composer.maxLength}
      questionTextId={questionTextId}
      draftStatus={composer.draftStatus}
      hint={hint}
      error={error}
      voice={
        <InterviewVoicePanel
          view={voice.view}
          replay={voice.replay}
          disabled={composer.submitting}
          actions={{
            onRecord: () => void voice.actions.start(),
            onStop: () => void voice.actions.stop(),
            onCancelRecording: () => void voice.actions.cancelRecording(),
            onTranscribe: voice.actions.transcribe,
            onCancelTranscription: voice.actions.cancelTranscription,
            onRetry: voice.actions.retry,
            onDiscard: voice.actions.discard,
            onLoadReplay: () => void voice.actions.loadReplay(),
            onTypeInstead: () => {
              voice.actions.dismissError();
              document.getElementById(composer.inputId)?.focus();
            },
          }}
        />
      }
    />
  );
}
