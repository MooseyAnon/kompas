// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InterviewsPage } from '../src/renderer/pages/interviews/InterviewsPage';

const ids = [1, 2, 3, 4, 5, 6].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
);
const date = (n: number) => `2026-01-0${n}T10:00:00.000Z`;
const items = [
  {
    id: ids[0],
    subject: 'Published',
    method: 'quick_fire',
    status: 'completed',
    completedAt: date(6),
    score: 0,
  },
  {
    id: ids[1],
    subject: 'Private',
    method: 'quick_fire',
    status: 'active',
    completedAt: null,
    score: null,
  },
  {
    id: ids[2],
    subject: 'Pause',
    method: 'deep_loop',
    status: 'active',
    completedAt: null,
    score: null,
  },
  {
    id: ids[3],
    subject: 'Draft',
    method: 'deep_loop',
    status: 'draft',
    completedAt: null,
    score: null,
  },
  {
    id: ids[4],
    subject: 'Unscored',
    method: 'deep_loop',
    status: 'completed',
    completedAt: date(2),
    score: null,
  },
  {
    id: ids[5],
    subject: 'Abandoned',
    method: 'deep_loop',
    status: 'abandoned',
    completedAt: date(1),
    score: null,
  },
] as const;
const session = (item: (typeof items)[number]) => ({
  ...item,
  careerTargetId: null,
  targetSnapshot:
    item.id === ids[0] ? { role: 'Artist', level: null, sector: null } : null,
  questionCount: item.method === 'quick_fire' ? 5 : null,
  additionalGuidance: null,
  phase: item.id === ids[2] ? 'paused' : 'answering',
  barSnapshot: null,
  createdAt: date(1),
  updatedAt: date(2),
  startedAt: date(1),
});
const result = (item: (typeof items)[number]) =>
  item.status !== 'completed'
    ? null
    : {
        method: item.method,
        subject: item.subject,
        totalRounds: 1,
        answeredCount: 1,
        reviewedCount: 1,
        passCount: 0,
        failCount: item.score === null ? 0 : 1,
        unscoredCount: item.score === null ? 1 : 0,
        averageScore: item.score,
        complete: true,
        recommendation: null,
        narrative: null,
        narrativeUnavailable: true,
        rounds: [],
      };
const snapshot = (item: (typeof items)[number]) => ({
  session: session(item),
  result: result(item),
  currentQuestion: null,
  operationId: null,
  feedback: null,
  deepLoop: null,
  availableActions: item.id === ids[2] ? ['continue'] : [],
  progress: {
    phase: 'idle',
    operationStatus: item.id === ids[1] ? 'cancelled' : 'idle',
    questionCount: 1,
    answeredCount: 1,
    reviewedCount: 0,
  },
});
const review = {
  id: ids[0],
  roundId: ids[0],
  decision: 'fail',
  score: 0,
  provisional: true,
  barKind: 'practice_benchmark',
  passThreshold: 70,
  criteria: [
    {
      id: 'c',
      label: 'Reasoning',
      weight: 1,
      score: 0,
      evidence: 'Saved answer',
      rationale: 'Missing detail',
    },
  ],
  strengths: [],
  gaps: ['Explain more'],
  needsMoreEvidence: false,
  unscoredReason: null,
  modelProvenance: {
    providerId: 'mock',
    modelId: 'mock',
    promptVersion: 'v1',
    validation: 'passed',
    generatedAt: date(1),
  },
  createdAt: date(1),
};
const detail = (item: (typeof items)[number]) => ({
  session: session(item),
  bar: null,
  rounds: [
    {
      id: ids[0],
      ordinal: 1,
      reassessmentOfRoundId: null,
      questions: [
        {
          id: ids[0],
          kind: 'primary',
          question: 'Saved question',
          competency: 'Design',
          createdAt: date(1),
          answer: 'Saved answer',
        },
      ],
      review: item.id === ids[0] || item.id === ids[1] ? review : null,
      coaching: null,
    },
  ],
});
const progress = {
  subject: 'Published',
  method: 'quick_fire',
  sessions: 2,
  scoredRounds: 1,
  unscoredRounds: 1,
  pendingRounds: 1,
  reassessments: 1,
  pass: 0,
  fail: 1,
  averageScore: 0,
  points: [
    { sessionId: ids[0], completedAt: date(6), score: 0, scoredRoundCount: 1 },
  ],
  variedBars: false,
  limited: false,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let backend: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
  backend = vi.fn(
    async (input: { action: string; payload: { sessionId?: string } }) => {
      const item =
        items.find((row) => row.id === input.payload.sessionId) ?? items[0];
      const data =
        input.action === 'insights.sessions.list'
          ? {
              items: items.map((row) => ({
                ...row,
                targetRole: row.id === ids[0] ? 'Artist' : null,
                createdAt: date(1),
                updatedAt: date(2),
                questionCount: row.method === 'quick_fire' ? 5 : null,
                counts: {
                  questions: 1,
                  answered: 1,
                  reviewed: row.id === ids[1] ? 0 : 1,
                  scored: row.score === null ? 0 : 1,
                  unscored: 0,
                },
              })),
              nextCursor: null,
            }
          : input.action === 'insights.progress.get'
            ? progress
            : input.action === 'insights.questions.list'
              ? {
                  items: [
                    {
                      id: ids[0],
                      sessionId: ids[0],
                      roundId: ids[0],
                      roundOrdinal: 1,
                      kind: 'primary',
                      reassessmentOfRoundId: null,
                      question: 'Saved question',
                      competency: 'Design',
                      subject: 'Published',
                      method: 'quick_fire',
                      createdAt: date(1),
                      answered: true,
                      decision: 'fail',
                    },
                  ],
                  nextCursor: null,
                }
              : input.action === 'insights.sessions.get'
                ? detail(item)
                : input.action === 'workflow.state.get'
                  ? { state: snapshot(item) }
                  : { items: [] };
      return { ok: true, data };
    },
  );
  vi.stubGlobal('career', { request: backend });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const click = async (selector: string) => {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(selector)!.click(),
  );
};
const text = () => container.textContent ?? '';

it('shows bounded mixed history, keeps unpublished Quick-fire private, and returns focus after detail', async () => {
  await act(async () =>
    root.render(
      <InterviewsPage initialLocation={{ view: 'tab', tab: 'history' }} />,
    ),
  );
  expect(container.querySelectorAll('.history-row')).toHaveLength(6);
  expect(text()).toContain('Paused');
  expect(text()).toContain('0 / 100'); // A real zero is not the missing-value dash.
  expect(container.querySelectorAll('.history-score')[1].textContent).toBe('—');
  const statusFilter = container.querySelectorAll<HTMLSelectElement>(
    '.history-filters select',
  )[1];
  await act(async () => {
    statusFilter.value = 'paused';
    statusFilter.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelectorAll('.history-row')).toHaveLength(1);
  expect(text()).toContain('Pause');
  await act(async () => {
    statusFilter.value = 'all';
    statusFilter.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click(`#history-open-${ids[1]}`);
  expect(text()).toContain('Results and reviews are available only after');
  expect(text()).not.toContain('Explain more');
  await click('[data-testid="history-detail-view"] button');
  expect(document.activeElement?.id).toBe(`history-open-${ids[1]}`);
  await click(`#history-open-${ids[0]}`);
  expect(text()).toContain('written summary couldn’t be prepared');
  expect(text()).toContain('Saved question');
  await click('.history-rounds summary');
  expect(text()).toContain('Explain more');
  expect(
    backend.mock.calls.every(([input]) =>
      [
        'insights.sessions.list',
        'workflow.state.get',
        'insights.sessions.get',
      ].includes(input.action),
    ),
  ).toBe(true);
});

it('renders backend cohort values with numeric chart equivalent and read-only drill-down', async () => {
  await act(async () =>
    root.render(
      <InterviewsPage initialLocation={{ view: 'tab', tab: 'competencies' }} />,
    ),
  );
  expect(text()).toContain('Observed round average');
  expect(text()).toContain('0 / 100');
  expect(text()).toContain('1 linked reassessments');
  expect(
    container.querySelector(
      '[role="img"][aria-label*="numeric values listed"]',
    ),
  ).not.toBeNull();
  expect(container.querySelectorAll('.competency-points li')).toHaveLength(1);
  await click('.competency-points button');
  expect(text()).toContain('Saved results');
  await click('[data-testid="competencies-detail-view"] button');
  expect(text()).toContain('Questions in this cohort');
  expect(
    backend.mock.calls.every(([input]) =>
      [
        'insights.progress.get',
        'insights.questions.list',
        'insights.sessions.get',
        'workflow.state.get',
      ].includes(input.action),
    ),
  ).toBe(true);
});

it('does not render a score or chart when the selected cohort has no scored sessions', async () => {
  backend.mockImplementation(async (input: { action: string }) => ({
    ok: true,
    data:
      input.action === 'insights.progress.get'
        ? {
            ...progress,
            subject: null,
            method: null,
            sessions: 0,
            scoredRounds: 0,
            averageScore: null,
            points: [],
          }
        : { items: [], nextCursor: null },
  }));
  await act(async () =>
    root.render(
      <InterviewsPage initialLocation={{ view: 'tab', tab: 'competencies' }} />,
    ),
  );
  expect(
    container.querySelector('[data-testid="interviews-competencies-empty"]'),
  ).not.toBeNull();
  expect(container.querySelector('.competency-chart')).toBeNull();
  expect(backend.mock.calls.map(([input]) => input.action)).toEqual([
    'insights.progress.get',
  ]);
});
