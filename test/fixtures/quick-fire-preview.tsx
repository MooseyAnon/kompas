import React from 'react';
import { createRoot } from 'react-dom/client';
import type {
  InsightsDetail,
  InterviewWorkflowAction,
  InterviewWorkflowState,
} from '../../src/shared/contracts';
import '../../src/renderer/shell.css';
import { InterviewsPage } from '../../src/renderer/pages/interviews/InterviewsPage';
import './quick-fire-preview.css';

/*
 * Visual fixture for the 07.4 Quick-fire runner, driven by `?state=`. The
 * real Interviews page and session controller run against a scripted
 * in-page backend; every value is illustrative and nothing reaches the app.
 */

const SESSION_ID = '0b7e3c1e-5d1f-4b8a-9a43-0f2d6c2a9e11';
const NOW = '2026-11-12T10:00:00.000Z';
const COUNT = 5;
const id = (prefix: string, index: number) =>
  `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;

const prompts = [
  'Tell me about a time you changed a plan because new information arrived late.',
  'How would you explain a risky migration to a non-technical stakeholder?',
  'Describe how you would prioritise three urgent requests with one engineer.',
  'Walk me through how you would recover trust after a missed deadline.',
  'How do you decide when a prototype is ready to become a product?',
];

function question(index: number) {
  return {
    id: id('11111111', index + 1),
    roundId: id('22222222', index + 1),
    question: prompts[index],
    competency: index % 2 ? 'Communication' : 'Adaptability',
    createdAt: NOW,
    rubricSummary: null,
    provenance: {
      origin: 'generated' as const,
      providerId: 'mock',
      modelId: 'mock-interview',
      promptVersion: 'iq-v2',
      sourceBasis: 'model_general_knowledge' as const,
      validation: 'passed' as const,
      generatedAt: NOW,
    },
  };
}

interface Scenario {
  answered: number;
  reviewed: number;
  current: number | null;
  running: boolean;
  completed?: boolean;
}

const scenarios: Record<string, Scenario> = {
  'q1-generating': { answered: 0, reviewed: 0, current: 0, running: true },
  'next-pending': { answered: 1, reviewed: 0, current: null, running: true },
  recording: { answered: 1, reviewed: 0, current: 1, running: true },
  'final-pending': { answered: 5, reviewed: 3, current: null, running: true },
  synthesis: { answered: 5, reviewed: 5, current: null, running: true },
  results: {
    answered: 5,
    reviewed: 5,
    current: null,
    running: false,
    completed: true,
  },
};
const name = new URLSearchParams(location.search).get('state') ?? '';
const scenario = scenarios[name] ?? scenarios['q1-generating'];

const decisions = [
  { decision: 'pass' as const, score: 82 },
  { decision: 'fail' as const, score: 54 },
  { decision: 'unscored' as const, score: null },
  { decision: 'pass' as const, score: 76 },
  { decision: 'fail' as const, score: 61 },
];

function snapshot(): InterviewWorkflowState {
  const { answered, reviewed, current, running, completed } = scenario;
  const actions: InterviewWorkflowAction[] = completed
    ? []
    : [
        ...(current !== null ? (['answer'] as const) : (['continue'] as const)),
        ...(answered === COUNT ? (['request_results'] as const) : []),
        ...(running ? (['pause'] as const) : []),
        'abandon',
      ];
  return {
    session: {
      id: SESSION_ID,
      method: 'quick_fire',
      subject: 'Product leadership',
      careerTargetId: null,
      targetSnapshot: { role: 'Product Manager', level: null, sector: null },
      questionCount: COUNT,
      additionalGuidance: null,
      status: completed ? 'completed' : 'active',
      phase: completed ? 'completed' : 'answering',
      barSnapshot: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      completedAt: completed ? NOW : null,
    },
    currentQuestion: current === null ? null : question(current),
    progress: {
      phase: 'answering',
      operationStatus: running ? 'running' : 'idle',
      progressText: null,
      operation: running ? 'working' : null,
      errorMessage: null,
      questionCount: COUNT,
      answeredCount: answered,
      reviewedCount: reviewed,
      canSubmit: current !== null,
      canRetry: false,
    },
    operationId: running ? id('99999999', 1) : null,
    availableActions: actions,
    feedback: null,
    result: completed
      ? {
          method: 'quick_fire',
          subject: 'Product leadership',
          totalRounds: COUNT,
          answeredCount: COUNT,
          reviewedCount: COUNT,
          passCount: 2,
          failCount: 2,
          unscoredCount: 1,
          averageScore: 68.3,
          complete: true,
          recommendation:
            'Some answers could not be scored. Revisit those topics and try fresh questions.',
          narrative: {
            strengths: ['Clear structure and ownership in most answers'],
            gaps: ['Quantify the outcome more often'],
            recommendations: ['Close each answer with one measurable result'],
          },
          narrativeUnavailable: false,
          publishedAt: NOW,
          rounds: decisions.map((item, index) => ({
            roundId: question(index).roundId,
            ordinal: index + 1,
            competency: question(index).competency,
            ...item,
            isReassessment: false,
          })),
        }
      : null,
  };
}

function detail(): InsightsDetail {
  return {
    session: snapshot().session,
    bar: {
      schemaVersion: 1,
      kind: 'practice_benchmark',
      status: 'practice',
      target: null,
      subject: 'Product leadership',
      basis: [],
      assumptions: [],
      criteria: [
        { id: 'c1', label: 'Structure', description: 'd', weight: 0.5 },
        { id: 'c2', label: 'Impact', description: 'd', weight: 0.5 },
      ],
      passThreshold: 70,
    },
    rounds: decisions.map((item, index) => ({
      id: question(index).roundId,
      ordinal: index + 1,
      reassessmentOfRoundId: null,
      questions: [
        {
          id: question(index).id,
          kind: 'primary' as const,
          question: question(index).question,
          competency: question(index).competency,
          createdAt: NOW,
          answer:
            'I set out the options, agreed a decision owner and measured the outcome a week later.',
        },
      ],
      review: {
        id: id('33333333', index + 1),
        roundId: question(index).roundId,
        ...item,
        provisional: true as const,
        barKind: 'practice_benchmark' as const,
        passThreshold: 70,
        criteria: [],
        strengths: ['Names a clear owner'],
        gaps: item.decision === 'pass' ? [] : ['State the measurable result'],
        needsMoreEvidence: false,
        unscoredReason:
          item.decision === 'unscored'
            ? 'The answer did not address the question.'
            : null,
        modelProvenance: {
          providerId: 'mock',
          modelId: 'mock-interview',
          promptVersion: 'ir-v1',
          validation: 'passed' as const,
          generatedAt: NOW,
        },
        createdAt: NOW,
      },
      coaching: null,
    })),
  };
}

const sttJob = {
  id: id('44444444', 1),
  recordingId: id('55555555', 1),
  providerId: 'whisper',
  engineVersion: '1.7.0',
  modelId: 'base.en',
  locale: 'en',
  status: 'running',
  errorCode: null,
  transcriptId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const handlers: Record<string, (payload: Record<string, unknown>) => unknown> =
  {
    'workflow.state.get': () => ({ state: snapshot() }),
    // Reviews are still "running", so a request returns the pending snapshot.
    'workflow.results.request': () => ({ state: snapshot() }),
    'insights.sessions.get': () => detail(),
    'answers.draft.get': () => ({ draft: null }),
    'answers.draft.save': (payload) => ({
      draft: { ...payload, updatedAt: NOW },
    }),
    'answers.draft.clear': () => ({ cleared: true }),
    'capture.begin': () => ({
      captureId: id('66666666', 1),
      token: 'fixture-capture-token-0123',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      maxChunkBytes: 65536,
      maxDurationMs: 300000,
      maxBytes: 9_600_000,
    }),
    'capture.append': () => ({ receivedBytes: 1 }),
    'capture.cancel': () => ({ cancelled: true }),
    'stt.jobs.start': () => ({ job: sttJob }),
    'stt.jobs.get': () => ({ job: sttJob }),
    'stt.jobs.list': () => ({ items: [] }),
  };

Object.defineProperty(window, 'career', {
  configurable: true,
  value: {
    request: async (input: {
      action: string;
      payload: Record<string, unknown>;
    }) => {
      const handler = handlers[input.action];
      return handler
        ? { ok: true, data: handler(input.payload) }
        : {
            ok: false,
            error: {
              code: 'NOT_FOUND',
              message: 'Not part of this fixture.',
              correlationId: 'fixture',
            },
          };
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <div className="quick-fire-fixture" data-testid="fixture-ready">
    <InterviewsPage
      initialLocation={{
        view: 'session',
        sessionId: SESSION_ID,
        returnTo: 'prepare',
      }}
    />
  </div>,
);
