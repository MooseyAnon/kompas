import React, { type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  CirclePause,
  Repeat,
  SkipForward,
  Trash2,
  Zap,
} from 'lucide-react';
import '../../src/renderer/shell.css';
import { statusCopy } from '../../src/renderer/pages/interviews/session/statusCopy';
import { Card } from '../../src/renderer/presentation/components/Card';
import { InterviewActionBar } from '../../src/renderer/presentation/components/interviews/InterviewActionBar';
import { InterviewAnswerComposer } from '../../src/renderer/presentation/components/interviews/InterviewAnswerComposer';
import { InterviewCoachingCard } from '../../src/renderer/presentation/components/interviews/InterviewCoachingCard';
import { InterviewPhaseBadge } from '../../src/renderer/presentation/components/interviews/InterviewPhaseBadge';
import { InterviewProgress } from '../../src/renderer/presentation/components/interviews/InterviewProgress';
import { InterviewQuestionCard } from '../../src/renderer/presentation/components/interviews/InterviewQuestionCard';
import { InterviewReviewCard } from '../../src/renderer/presentation/components/interviews/InterviewReviewCard';
import { InterviewStatusBubble } from '../../src/renderer/presentation/components/interviews/InterviewStatusBubble';
import {
  InterviewVoicePanel,
  type InterviewVoiceView,
} from '../../src/renderer/presentation/components/interviews/InterviewVoicePanel';
import { SessionPanel } from '../../src/renderer/presentation/components/interviews/SessionPanel';
import './interview-primitives-preview.css';

/*
 * Visual fixture for the 07.3 primitives, driven by `?state=`. Every value is
 * illustrative fixture copy rendered through the real components; nothing
 * here is shipped or reaches production data.
 */

const noop = () => {};
const voiceActions = {
  onRecord: noop,
  onStop: noop,
  onCancelRecording: noop,
  onTranscribe: noop,
  onCancelTranscription: noop,
  onRetry: noop,
  onDiscard: noop,
  onLoadReplay: noop,
  onTypeInstead: noop,
};
const levels = [
  0.02, 0.08, 0.2, 0.35, 0.12, 0.4, 0.55, 0.3, 0.18, 0.42, 0.6, 0.25, 0.1, 0.33,
  0.47, 0.2,
];

function Header() {
  return (
    <div className="primitives-fixture-bar">
      <InterviewPhaseBadge icon={Zap} label="Quick-fire" tone="active" />
      <InterviewProgress
        label="Question 2 of 5"
        total={5}
        completed={1}
        current={2}
        detail="1 answered"
      />
    </div>
  );
}

function Question() {
  return (
    <InterviewQuestionCard
      question="Tell me about a time you had to change a plan because new information arrived late."
      competency="Adaptability"
      role="Product Manager"
      position="Question 2 of 5"
      textId="fixture-question"
    />
  );
}

function Composer({
  value,
  voice,
  canSubmit = true,
  error,
}: {
  value: string;
  voice: InterviewVoiceView;
  canSubmit?: boolean;
  error?: string;
}) {
  return (
    <InterviewAnswerComposer
      id="fixture-answer"
      value={value}
      onChange={noop}
      onSubmit={noop}
      canSubmit={canSubmit}
      maxLength={8000}
      questionTextId="fixture-question"
      draftStatus="saved"
      hint="Aim for a clear, structured answer."
      error={error}
      voice={
        <InterviewVoicePanel
          view={voice}
          replay={{ url: null, loading: false }}
          actions={voiceActions}
        />
      }
    />
  );
}

function Actions() {
  return (
    <InterviewActionBar
      label="Session actions"
      actions={[]}
      trailing={[
        { id: 'pause', label: 'Pause', icon: CirclePause, onSelect: noop },
        {
          id: 'abandon',
          label: 'Abandon',
          icon: Trash2,
          variant: 'ghost',
          onSelect: noop,
        },
      ]}
    />
  );
}

const states: Record<string, () => ReactNode> = {
  'status-large': () => (
    <InterviewStatusBubble
      variant="large"
      icon={statusCopy.first_question.icon}
      label={statusCopy.first_question.label}
      phrases={statusCopy.first_question.phrases}
      data-testid="fixture-status"
    />
  ),
  'status-compact': () => (
    <>
      <Header />
      <Question />
      <Composer
        value="I'd start by checking which assumptions changed…"
        voice={{ kind: 'idle' }}
      />
      <InterviewStatusBubble
        variant="chip"
        icon={statusCopy.background.icon}
        label={statusCopy.background.label}
        phrases={statusCopy.background.phrases}
        data-testid="fixture-status"
      />
      <InterviewStatusBubble
        variant="inline"
        icon={statusCopy.review.icon}
        label={statusCopy.review.label}
        phrases={statusCopy.review.phrases}
      />
      <Actions />
    </>
  ),
  recording: () => (
    <>
      <Header />
      <Question />
      <Composer
        value=""
        canSubmit={false}
        voice={{
          kind: 'recording',
          elapsedMs: 42_000,
          maxDurationMs: 300_000,
          levels,
          stopping: false,
        }}
      />
      <Actions />
    </>
  ),
  transcription: () => (
    <>
      <Header />
      <Question />
      <Composer
        value=""
        canSubmit={false}
        voice={{
          kind: 'transcribing',
          label: statusCopy.transcription.label,
          phrases: statusCopy.transcription.phrases,
          icon: statusCopy.transcription.icon,
        }}
      />
    </>
  ),
  error: () => (
    <>
      <SessionPanel
        icon={AlertTriangle}
        tone="error"
        title="The next question couldn’t be prepared"
        data-testid="fixture-failed"
      >
        <p>
          Your local model didn’t finish. Check Local AI settings, then try
          again.
        </p>
        <InterviewActionBar
          label="Recovery"
          actions={[
            {
              id: 'retry',
              label: 'Try again',
              icon: Repeat,
              variant: 'primary',
              onSelect: noop,
            },
          ]}
        />
      </SessionPanel>
      <Question />
      <Composer
        value="Typing still works here."
        voice={{
          kind: 'error',
          message:
            'Microphone access was blocked. Allow it in System Settings › Privacy & Security › Microphone, then try again. You can type your answer instead.',
          retry: 'record',
          hasRecording: false,
        }}
      />
    </>
  ),
  feedback: () => (
    <>
      <InterviewReviewCard
        review={{
          id: 'fixture-review',
          roundId: 'fixture-round',
          decision: 'fail',
          score: 58,
          provisional: true,
          barKind: 'practice_benchmark',
          passThreshold: 70,
          criteria: [
            {
              id: 'c1',
              label: 'Problem framing',
              weight: 0.4,
              score: 70,
              evidence: 'Named the late change clearly.',
              rationale: null,
            },
            {
              id: 'c2',
              label: 'Outcome',
              weight: 0.6,
              score: null,
              evidence: null,
              rationale: 'No result was described.',
            },
          ],
          strengths: ['Clear description of the situation.'],
          gaps: ['Say what happened as a result.'],
          needsMoreEvidence: false,
          unscoredReason: null,
          modelProvenance: {
            providerId: 'fixture',
            modelId: 'fixture',
            promptVersion: 'ir-v1',
            validation: 'passed',
            generatedAt: '2026-11-11T10:00:00.000Z',
          },
          createdAt: '2026-11-11T10:00:00.000Z',
        }}
      />
      <InterviewCoachingCard
        coaching={{
          id: 'fixture-coaching',
          roundId: 'fixture-round',
          diagnosis: 'The answer stops before the outcome.',
          advice: ['End with what changed because of your decision.'],
          workedExample:
            'I re-planned the launch in two phases; phase one shipped on time.',
          reassessmentFocus: 'Describe the outcome.',
          modelProvenance: {
            providerId: 'fixture',
            modelId: 'fixture',
            promptVersion: 'ic-v1',
            validation: 'passed',
            generatedAt: '2026-11-11T10:00:00.000Z',
          },
          createdAt: '2026-11-11T10:00:00.000Z',
        }}
      />
      <InterviewActionBar
        label="Next step"
        actions={[
          {
            id: 'continue',
            label: 'Continue',
            description: 'Answer the next question',
            icon: SkipForward,
            variant: 'primary',
            onSelect: noop,
          },
        ]}
      />
    </>
  ),
};

const state =
  new URLSearchParams(location.search).get('state') ?? 'status-large';
const render = states[state] ?? states['status-large'];

createRoot(document.getElementById('root')!).render(
  <main className="primitives-fixture" data-state={state}>
    <Card padding="regular" data-testid="fixture-card">
      <p className="primitives-fixture-caption">Fixture: {state}</p>
      {render()}
    </Card>
  </main>,
);
