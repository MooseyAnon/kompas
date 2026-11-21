// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Sprout } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InterviewQuestionView,
  InterviewReviewView,
  InterviewSession,
  InterviewWorkflowState,
  SttJob,
} from '../src/shared/contracts';
import { DRAFT_SAVE_DELAY_MS } from '../src/renderer/pages/interviews/answer/useAnswerComposer';
import {
  STT_POLL_MS,
  captureErrorMessage,
  mergeTranscript,
  sttFailure,
} from '../src/renderer/pages/interviews/answer/voiceAnswer';
import { statusCopy } from '../src/renderer/pages/interviews/session/statusCopy';
import { SESSION_POLL_MS } from '../src/renderer/pages/interviews/session/useSessionWorkflow';
import { selectWorkStatus } from '../src/renderer/pages/interviews/session/workStatus';
import {
  InterviewStatusBubble,
  STATUS_PHRASE_INTERVAL_MS,
} from '../src/renderer/presentation/components/interviews/InterviewStatusBubble';
import { InterviewReviewCard } from '../src/renderer/presentation/components/interviews/InterviewReviewCard';
import { SessionHarness } from './fixtures/interview-session-harness';
import { FakeMedia } from './fixtures/fake-microphone';

const SESSION_ID = '0b7e3c1e-5d1f-4b8a-9a43-0f2d6c2a9e11';
const OTHER_SESSION = '7f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const QUESTION_ID = '3c9d2b1a-8e7f-4a6b-9c5d-1e2f3a4b5c6d';
const OPERATION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const RECORDING_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const TRANSCRIPT_ID = '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e';
const JOB_ID = '4d5e6f7a-8b9c-4d4e-8f5a-6b7c8d9e0f1a';
const CAPTURE_ID = '5e6f7a8b-9c0d-4e5f-9a6b-7c8d9e0f1a2b';
const NOW = '2026-11-11T10:00:00.000Z';

const FAKED_TIMERS: (
  | 'setTimeout'
  | 'clearTimeout'
  | 'setInterval'
  | 'clearInterval'
  | 'Date'
)[] = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'];

const WORK_STARTING = new Set([
  'sessions.start',
  'workflow.continue',
  'workflow.answer.submit',
  'workflow.pause',
  'workflow.results.request',
  'sessions.cancelOperation',
  'sessions.finish',
]);

// --- fixtures -------------------------------------------------------------

function session(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    id: SESSION_ID,
    method: 'quick_fire',
    subject: 'System design',
    careerTargetId: null,
    targetSnapshot: null,
    questionCount: 5,
    additionalGuidance: null,
    status: 'active',
    phase: 'answering',
    barSnapshot: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

const question = {
  id: QUESTION_ID,
  roundId: 'r-1',
  question: 'How would you design a rate limiter?',
  competency: 'Distributed systems',
  createdAt: NOW,
  rubricSummary: null,
  provenance: {
    origin: 'generated',
    providerId: 'mock',
    modelId: 'mock-interview',
    promptVersion: 'iq-v2',
    sourceBasis: 'model_general_knowledge',
    validation: 'passed',
    generatedAt: NOW,
  },
} satisfies InterviewQuestionView;

function workflow(
  overrides: Omit<Partial<InterviewWorkflowState>, 'progress'> & {
    progress?: Partial<InterviewWorkflowState['progress']>;
  } = {},
): InterviewWorkflowState {
  const { progress, ...rest } = overrides;
  return {
    session: session(),
    currentQuestion: null,
    operationId: null,
    availableActions: [],
    feedback: null,
    result: null,
    ...rest,
    progress: {
      phase: 'answering',
      operationStatus: 'idle',
      progressText: null,
      operation: null,
      errorMessage: null,
      questionCount: 5,
      answeredCount: 0,
      reviewedCount: 0,
      canSubmit: false,
      canRetry: false,
      ...progress,
    },
  };
}

/** Q1 is answerable while later questions/reviews run in the background. */
const answerable = (overrides: Parameters<typeof workflow>[0] = {}) =>
  workflow({
    currentQuestion: question,
    operationId: OPERATION_ID,
    availableActions: ['answer', 'pause', 'abandon'],
    progress: { operationStatus: 'running', operation: 'working' },
    ...overrides,
  });

const idleAnswerable = () =>
  workflow({
    currentQuestion: question,
    availableActions: ['answer', 'abandon'],
  });

function job(overrides: Partial<SttJob> = {}): SttJob {
  return {
    id: JOB_ID,
    recordingId: RECORDING_ID,
    providerId: 'whisper',
    engineVersion: '1.7.0',
    modelId: 'base.en',
    locale: 'en',
    status: 'queued',
    errorCode: null,
    transcriptId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const recording = {
  id: RECORDING_ID,
  mediaType: 'audio/wav',
  codec: 'pcm_s16le',
  sampleRate: 16000,
  channels: 1,
  sizeBytes: 64000,
  durationMs: 2000,
  label: 'Interview answer',
  createdAt: NOW,
};

// --- fake backend and media ---------------------------------------------

type Handler = (payload: Record<string, unknown>) => unknown;
class Rejection {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}
type Call = {
  module: string;
  action: string;
  payload: Record<string, unknown>;
};

let handlers: Record<string, Handler>;
let backend: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function calls(action?: string) {
  return backend.mock.calls
    .map(([input]) => input as Call)
    .filter((input) => !action || input.action === action);
}
function workCalls() {
  return calls().filter((input) => WORK_STARTING.has(input.action));
}

let media: FakeMedia;

function audioHandlers(): Record<string, Handler> {
  return {
    'capture.begin': () => ({
      captureId: CAPTURE_ID,
      token: 'capture-token-0123456789',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      maxChunkBytes: 32768,
      maxDurationMs: 300000,
      maxBytes: 9_600_000,
    }),
    'capture.append': () => ({ receivedBytes: 1 }),
    'capture.complete': () => ({ recording }),
    'capture.cancel': () => ({ cancelled: true }),
    'stt.jobs.start': () => ({ job: job() }),
    'stt.jobs.get': () => ({ job: job({ status: 'running' }) }),
    'stt.jobs.cancel': () => ({ cancelled: true }),
    'stt.jobs.list': () => ({ items: [] }),
    'stt.transcripts.get': () => ({
      transcript: {
        id: TRANSCRIPT_ID,
        jobId: JOB_ID,
        recordingId: RECORDING_ID,
        providerId: 'whisper',
        engineVersion: '1.7.0',
        modelId: 'base.en',
        locale: 'en',
        text: ' I would use a token bucket. ',
        empty: false,
        segments: null,
        createdAt: NOW,
      },
    }),
  };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  media = new FakeMedia();
  media.install();
  handlers = {
    'workflow.state.get': () => ({ state: idleAnswerable() }),
    'answers.draft.get': () => ({ draft: null }),
    'answers.draft.save': (payload) => ({
      draft: { ...payload, updatedAt: NOW },
    }),
    'answers.draft.clear': () => ({ cleared: true }),
    ...audioHandlers(),
  };
  backend = vi.fn(async (input: Call) => {
    const handler = handlers[input.action];
    if (!handler)
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Unhandled.', correlationId: 'x' },
      };
    try {
      return { ok: true, data: await handler(input.payload) };
    } catch (error) {
      if (error instanceof Rejection)
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            correlationId: 'x',
          },
        };
      throw error;
    }
  });
  vi.stubGlobal('career', { request: backend });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- DOM helpers ------------------------------------------------------------

function query<T extends HTMLElement = HTMLElement>(testId: string) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}
async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index++) await Promise.resolve();
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}
async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => element!.click());
  await settle();
}
async function type(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function keyDown(
  element: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...init }),
    );
  });
  await settle();
}
function input() {
  return query<HTMLTextAreaElement>('interview-composer-input')!;
}
async function renderHarness(
  props: Partial<React.ComponentProps<typeof SessionHarness>> = {},
) {
  await act(async () =>
    root.render(<SessionHarness sessionId={SESSION_ID} {...props} />),
  );
  await settle();
}

// --- status bubble ----------------------------------------------------------

describe('InterviewStatusBubble', () => {
  const phrases = ['One…', 'Two…', 'Three…'];

  it.each(['large', 'inline', 'chip'] as const)(
    'the %s variant announces only the label and rotates decorative phrases',
    async (variant) => {
      vi.useFakeTimers({ toFake: FAKED_TIMERS });
      await act(async () =>
        root.render(
          <InterviewStatusBubble
            variant={variant}
            icon={Sprout}
            label="Reviewing your answer"
            phrases={phrases}
            data-testid="bubble"
          />,
        ),
      );

      const status = container.querySelector('[role="status"]')!;
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toBe('Reviewing your answer');
      expect(query('bubble')!.dataset.variant).toBe(variant);
      const phrase = () => query('bubble-phrase')!;
      expect(phrase().getAttribute('aria-hidden')).toBe('true');
      expect(phrase().textContent).toBe('One…');

      await advance(STATUS_PHRASE_INTERVAL_MS - 1);
      expect(phrase().textContent).toBe('One…');
      await advance(1);
      expect(phrase().textContent).toBe('Two…');
      // The phrase never enters the live region.
      expect(status.textContent).toBe('Reviewing your answer');
    },
  );

  it('restarts phrases on a label change, idles when inactive and leaves no timers', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    const render = (label: string, active = true) =>
      act(async () =>
        root.render(
          <InterviewStatusBubble
            variant="inline"
            tone="transcription"
            icon={Sprout}
            label={label}
            phrases={phrases}
            active={active}
            data-testid="bubble"
          />,
        ),
      );
    await render('Waiting to transcribe');
    expect(query('bubble')!.dataset.tone).toBe('transcription');
    await advance(STATUS_PHRASE_INTERVAL_MS * 2);
    expect(query('bubble-phrase')!.textContent).toBe('Three…');

    await render('Transcribing your answer');
    expect(query('bubble-phrase')!.textContent).toBe('One…');

    await render('Transcribing your answer', false);
    expect(vi.getTimerCount()).toBe(0);
    await advance(STATUS_PHRASE_INTERVAL_MS * 3);
    expect(query('bubble-phrase')!.textContent).toBe('One…');

    await render('Transcribing your answer');
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.render(<p />));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps every category’s phrases distinct so nearby bubbles differ', () => {
    const all = Object.values(statusCopy).flatMap((copy) => copy.phrases);
    expect(new Set(all).size).toBe(all.length);
  });
});

// --- work status selector ---------------------------------------------------

describe('selectWorkStatus', () => {
  const running = (
    progress: Partial<InterviewWorkflowState['progress']>,
    rest: Parameters<typeof workflow>[0] = {},
  ) =>
    workflow({
      operationId: OPERATION_ID,
      availableActions: ['pause', 'abandon'],
      ...rest,
      progress: {
        operationStatus: 'running',
        operation: 'working',
        ...progress,
      },
    });

  it('classifies Quick-fire by what the user waits for, never by review outcome', () => {
    expect(selectWorkStatus(running({}))).toMatchObject({
      kind: 'running',
      category: 'first_question',
      presentation: 'large',
      canPause: true,
    });
    // Before any answer only question generation can run beside Q1.
    expect(
      selectWorkStatus(running({}, { currentQuestion: question })),
    ).toMatchObject({ category: 'next_question', presentation: 'chip' });
    expect(
      selectWorkStatus(
        running({ answeredCount: 1 }, { currentQuestion: question }),
      ),
    ).toMatchObject({ category: 'background', presentation: 'chip' });
    expect(selectWorkStatus(running({ answeredCount: 2 }))).toMatchObject({
      category: 'next_question',
      presentation: 'inline',
    });
    expect(
      selectWorkStatus(running({ answeredCount: 5, reviewedCount: 3 })),
    ).toMatchObject({ category: 'final_checks', presentation: 'inline' });
    expect(
      selectWorkStatus(running({ answeredCount: 5, reviewedCount: 3 }), {
        resultsRequested: true,
      }),
    ).toMatchObject({ category: 'final_checks', presentation: 'large' });
    // With every answer reviewed, only the requested synthesis can run.
    expect(
      selectWorkStatus(running({ answeredCount: 5, reviewedCount: 5 })),
    ).toMatchObject({ category: 'synthesis', presentation: 'large' });

    // Running status carries no review data at all.
    const status = selectWorkStatus(
      running({ answeredCount: 3, reviewedCount: 2 }),
    );
    expect(Object.keys(status).sort()).toEqual([
      'canPause',
      'category',
      'kind',
      'presentation',
    ]);
  });

  it('maps every reported Deep Loop operation to its category', () => {
    const deep = (operation: string, questionCount = 1) =>
      selectWorkStatus(
        running(
          { operation, questionCount },
          { session: session({ method: 'deep_loop', questionCount: null }) },
        ),
      );
    expect(deep('preparing', 0)).toMatchObject({ category: 'first_question' });
    expect(deep('preparing')).toMatchObject({ category: 'next_question' });
    expect(deep('next_question')).toMatchObject({ category: 'next_question' });
    expect(deep('follow_up')).toMatchObject({ category: 'follow_up' });
    expect(deep('reviewing')).toMatchObject({ category: 'review' });
    expect(deep('coaching')).toMatchObject({ category: 'coaching' });
    expect(deep('reassessing')).toMatchObject({ category: 'reassessment' });
    expect(deep('assessing')).toMatchObject({
      category: 'synthesis',
      presentation: 'large',
    });
  });

  it('reports paused, recoverable failure, cancellation and terminal states', () => {
    expect(
      selectWorkStatus(
        workflow({
          session: session({ phase: 'paused_review' }),
          availableActions: ['continue', 'abandon'],
        }),
      ),
    ).toEqual({ kind: 'paused', canResume: true });
    expect(
      selectWorkStatus(
        workflow({
          availableActions: ['retry', 'abandon'],
          progress: { operationStatus: 'failed', errorMessage: 'No model.' },
        }),
      ),
    ).toEqual({
      kind: 'failed',
      cancelled: false,
      message: 'No model.',
      canRetry: true,
      canSkip: false,
    });
    expect(
      selectWorkStatus(
        workflow({
          session: session({ method: 'deep_loop' }),
          availableActions: ['retry', 'continue', 'abandon'],
          progress: { operationStatus: 'cancelled' },
        }),
      ),
    ).toMatchObject({ kind: 'failed', cancelled: true, canSkip: true });
    expect(
      selectWorkStatus(workflow({ session: session({ status: 'completed' }) })),
    ).toEqual({ kind: 'terminal' });
    expect(selectWorkStatus(idleAnswerable())).toEqual({ kind: 'idle' });
  });
});

// --- session controller -----------------------------------------------------

describe('session controller', () => {
  it('polls passively only while work runs and stops on settle and unmount', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    let state = answerable();
    handlers['workflow.state.get'] = () => ({ state });
    await renderHarness();

    expect(query('session-work-status')!.dataset.variant).toBe('chip');
    // Nothing is answered yet, so only later questions can be generating.
    expect(query('session-work-status')!.textContent).toContain(
      'Preparing the next question',
    );
    // The question stays answerable while background work runs.
    expect(input().readOnly).toBe(false);
    expect(calls('workflow.state.get')).toHaveLength(1);

    await advance(SESSION_POLL_MS);
    expect(calls('workflow.state.get')).toHaveLength(2);

    state = idleAnswerable();
    await advance(SESSION_POLL_MS);
    expect(calls('workflow.state.get')).toHaveLength(3);
    expect(query('session-work-status')).toBeNull();
    await advance(SESSION_POLL_MS * 4);
    expect(calls('workflow.state.get')).toHaveLength(3);

    state = answerable();
    await act(async () => root.render(<p />));
    await advance(SESSION_POLL_MS * 4);
    expect(calls('workflow.state.get')).toHaveLength(3);
    expect(workCalls()).toEqual([]);
  });

  it('drops a slow response for a previous session', async () => {
    let releaseFirst!: () => void;
    handlers['workflow.state.get'] = (payload) =>
      payload.sessionId === SESSION_ID
        ? new Promise((resolve) => {
            releaseFirst = () =>
              resolve({
                state: idleAnswerable(),
              });
          })
        : {
            state: workflow({
              session: session({ id: OTHER_SESSION, phase: 'paused' }),
              availableActions: ['continue', 'abandon'],
            }),
          };
    await renderHarness();
    expect(query('harness-loading')).not.toBeNull();

    await renderHarness({ sessionId: OTHER_SESSION });
    expect(query('harness-phase')!.textContent).toBe('Paused');

    releaseFirst();
    await settle();
    expect(query('harness-phase')!.textContent).toBe('Paused');
    expect(query('harness-question')).toBeNull();
  });

  it('offers only advertised recovery and keeps pause, cancel and abandon distinct', async () => {
    handlers['workflow.state.get'] = () => ({
      state: workflow({
        availableActions: ['retry', 'abandon'],
        progress: {
          operationStatus: 'failed',
          errorMessage: 'Choose a model in Local AI settings.',
        },
      }),
    });
    handlers['workflow.continue'] = () => ({
      state: workflow({
        operationId: OPERATION_ID,
        availableActions: ['pause', 'abandon'],
        progress: { operationStatus: 'running', operation: 'working' },
      }),
    });
    handlers['sessions.cancelOperation'] = () => ({ cancelled: true });
    handlers['workflow.pause'] = () => ({
      state: workflow({
        session: session({ phase: 'paused' }),
        availableActions: ['continue', 'abandon'],
      }),
    });
    handlers['sessions.finish'] = () => ({ session: session(), summary: {} });
    await renderHarness();

    expect(query('harness-failed')!.textContent).toContain('Local AI');
    expect(query('interview-actions-pause')).toBeNull();
    await click(query('interview-actions-retry'));
    expect(calls('workflow.continue').map((c) => c.payload.action)).toEqual([
      'retry',
    ]);
    expect(query('session-work-status')!.dataset.variant).toBe('large');

    // Cancelling one model operation is not a pause and not an abandon.
    await click(query('interview-actions-cancel_operation'));
    expect(calls('sessions.cancelOperation')).toHaveLength(1);
    expect(calls('workflow.pause')).toHaveLength(0);
    expect(calls('sessions.finish')).toHaveLength(0);
    // It re-reads the snapshot afterwards rather than guessing.
    expect(calls('workflow.state.get')).toHaveLength(2);
  });

  it('pauses durably and abandons only after an inline confirmation', async () => {
    handlers['workflow.state.get'] = () => ({ state: answerable() });
    handlers['workflow.pause'] = () => ({
      state: workflow({
        session: session({ phase: 'paused' }),
        availableActions: ['continue', 'abandon'],
      }),
    });
    handlers['sessions.finish'] = () => ({ session: session(), summary: {} });
    await renderHarness();

    await click(query('interview-actions-pause'));
    expect(calls('workflow.pause')).toHaveLength(1);
    expect(query('harness-phase')!.textContent).toBe('Paused');
    // Resume is offered but never sent by itself.
    expect(query('interview-actions-continue')!.textContent).toBe('Resume');
    expect(calls('workflow.continue')).toHaveLength(0);

    const abandon = query('interview-actions-abandon')!;
    await click(abandon);
    expect(calls('sessions.finish')).toHaveLength(0);
    const keep = query('interview-actions-confirm-keep')!;
    expect(document.activeElement).toBe(keep);
    await keyDown(keep, 'Escape');
    expect(query('interview-actions-confirm')).toBeNull();
    expect(document.activeElement).toBe(query('interview-actions-abandon'));
    expect(calls('sessions.finish')).toHaveLength(0);

    await click(query('interview-actions-abandon'));
    await click(query('interview-actions-confirm-accept'));
    expect(calls('sessions.finish').map((c) => c.payload)).toEqual([
      { sessionId: SESSION_ID, outcome: 'abandoned' },
    ]);
  });

  it('submits once despite rapid clicks and the keyboard shortcut', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    let release!: () => void;
    handlers['workflow.state.get'] = () => ({ state: answerable() });
    handlers['workflow.answer.submit'] = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            state: workflow({
              operationId: OPERATION_ID,
              availableActions: ['pause', 'abandon'],
              progress: {
                operationStatus: 'running',
                operation: 'working',
                answeredCount: 1,
              },
            }),
          });
      });
    await renderHarness();

    await type(input(), '  Token bucket per client.  ');
    const submit = query<HTMLButtonElement>('interview-composer-submit')!;
    expect(submit.disabled).toBe(false);
    await click(submit);
    await click(submit);
    await keyDown(input(), 'Enter', { metaKey: true });
    // A poll during the submit must not replace its result.
    await advance(SESSION_POLL_MS * 2);
    release();
    await settle();

    expect(calls('workflow.answer.submit').map((c) => c.payload)).toEqual([
      {
        sessionId: SESSION_ID,
        questionId: QUESTION_ID,
        answerText: 'Token bucket per client.',
      },
    ]);
    expect(query('session-work-status')!.textContent).toContain(
      'Preparing the next question',
    );
    // The consumed draft is never re-saved after the commit.
    await advance(DRAFT_SAVE_DELAY_MS * 2);
    expect(calls('answers.draft.save')).toHaveLength(0);
  });

  it('submits with Ctrl+Enter and keeps the answer when the backend refuses', async () => {
    handlers['workflow.answer.submit'] = () => {
      throw new Rejection(
        'CONFLICT',
        'This question is not ready for an answer.',
      );
    };
    await renderHarness();
    await type(input(), 'My answer');
    await keyDown(input(), 'Enter', { ctrlKey: true });

    expect(calls('workflow.answer.submit')).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'not ready',
    );
    expect(input().value).toBe('My answer');
  });
});

describe('answer draft ordering', () => {
  it('persists later edits after a slow save and waits for both before submitting', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    let releaseFirst!: () => void;
    let savedText = '';
    handlers['answers.draft.save'] = (payload) =>
      new Promise((resolve) => {
        const finish = () => {
          savedText = payload.draftText as string;
          resolve({ draft: { ...payload, updatedAt: NOW } });
        };
        if (!releaseFirst) releaseFirst = finish;
        else finish();
      });
    handlers['workflow.answer.submit'] = () => ({ state: workflow() });
    await renderHarness();

    await type(input(), 'First edit');
    await advance(DRAFT_SAVE_DELAY_MS);
    expect(calls('answers.draft.save')).toHaveLength(1);
    await type(input(), 'Final edit');
    await advance(DRAFT_SAVE_DELAY_MS);
    // The second write must not overtake the first on the wire.
    expect(calls('answers.draft.save')).toHaveLength(1);

    await act(async () => query('interview-composer-submit')!.click());
    expect(calls('workflow.answer.submit')).toHaveLength(0);
    releaseFirst();
    await settle();
    expect(calls('answers.draft.save')).toHaveLength(2);
    expect(savedText).toBe('Final edit');
    expect(calls('workflow.answer.submit')[0].payload.answerText).toBe(
      'Final edit',
    );
  });
});

// --- review card ------------------------------------------------------------

describe('InterviewReviewCard', () => {
  it('shows an unscored review as unscored, never as zero', async () => {
    const review: InterviewReviewView = {
      id: 'rv-1',
      roundId: 'r-1',
      decision: 'unscored',
      score: null,
      provisional: true,
      barKind: 'practice_benchmark',
      passThreshold: null,
      criteria: [
        {
          id: 'c1',
          label: 'Trade-offs',
          weight: 0.5,
          score: null,
          evidence: null,
          rationale: null,
        },
      ],
      strengths: [],
      gaps: ['Say which limits you chose.'],
      needsMoreEvidence: true,
      unscoredReason: 'The answer was too short to judge.',
      modelProvenance: {
        providerId: 'mock',
        modelId: 'mock-interview',
        promptVersion: 'ir-v1',
        validation: 'unscored',
        generatedAt: NOW,
      },
      createdAt: NOW,
    };
    await act(async () => root.render(<InterviewReviewCard review={review} />));
    expect(query('interview-review-decision')!.textContent).toBe('Unscored');
    expect(query('interview-review-score')!.textContent).toBe('No score');
    expect(container.textContent).not.toMatch(/\b0 \/ 100\b/);
    expect(container.textContent).toContain('Unscored · weight 50%');
  });
});

// --- voice ------------------------------------------------------------------

describe('voice answers', () => {
  it('records with real levels, transcribes into editable text and links the audio on submit', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    let sttJob = job({ status: 'queued' });
    handlers['stt.jobs.start'] = () => ({ job: sttJob });
    handlers['stt.jobs.get'] = () => ({ job: sttJob });
    handlers['workflow.answer.submit'] = () => ({
      state: workflow({
        availableActions: ['request_results', 'abandon'],
        progress: { answeredCount: 5 },
      }),
    });
    await renderHarness();

    await click(query('interview-voice-record'));
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(calls('capture.begin')).toHaveLength(1);
    expect(query('interview-recording')!.textContent).toContain('Recording');
    expect(query('interview-recording-time')!.textContent).toBe('0:00 / 5:00');
    // Submitting is held while the microphone is live; typing still works.
    expect(
      query<HTMLButtonElement>('interview-composer-submit')!.disabled,
    ).toBe(true);

    await act(async () => {
      media.emit(0.5);
      media.emit(0.02);
    });
    const bars = query('interview-recording-levels')!.children;
    expect(bars).toHaveLength(2);
    expect((bars[0] as HTMLElement).style.height).not.toBe(
      (bars[1] as HTMLElement).style.height,
    );
    await advance(2100);
    expect(query('interview-recording-time')!.textContent).toBe('0:02 / 5:00');

    await click(query('interview-recording-stop'));
    expect(media.track.stop).toHaveBeenCalled();
    expect(calls('capture.append').length).toBeGreaterThan(0);
    expect(calls('capture.complete')).toHaveLength(1);
    expect(calls('stt.jobs.start').map((c) => c.payload)).toEqual([
      { recordingId: RECORDING_ID },
    ]);
    // The draft keeps the recording link straight away.
    expect(calls('answers.draft.save').at(-1)!.payload).toMatchObject({
      recordingId: RECORDING_ID,
    });

    const bubble = query('interview-voice-transcribing')!;
    expect(bubble.dataset.tone).toBe('transcription');
    expect(bubble.textContent).toContain('Waiting to transcribe');

    sttJob = job({ status: 'running' });
    await advance(STT_POLL_MS);
    expect(query('interview-voice-transcribing')!.textContent).toContain(
      'Transcribing your answer',
    );

    sttJob = job({ status: 'succeeded', transcriptId: TRANSCRIPT_ID });
    await advance(STT_POLL_MS);
    expect(query('interview-voice-transcribing')).toBeNull();
    expect(input().value).toBe('I would use a token bucket.');
    expect(query('interview-voice-saved')!.textContent).toContain(
      'Check and edit it',
    );
    // A finished transcript is never submitted on its own.
    expect(calls('workflow.answer.submit')).toHaveLength(0);
    expect(calls('sessions.cancelOperation')).toHaveLength(0);

    await type(input(), 'I would use a token bucket per API key.');
    await click(query('interview-composer-submit'));
    expect(calls('workflow.answer.submit').map((c) => c.payload)).toEqual([
      {
        sessionId: SESSION_ID,
        questionId: QUESTION_ID,
        answerText: 'I would use a token bucket per API key.',
        audio: { recordingId: RECORDING_ID, transcriptId: TRANSCRIPT_ID },
      },
    ]);
  });

  it('recovers from a denied microphone with typing', async () => {
    media.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    await renderHarness();

    await click(query('interview-voice-record'));
    const error = query('interview-voice-error')!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('Microphone access was blocked');
    // The reserved capture is released; no recording exists.
    expect(calls('capture.cancel')).toHaveLength(1);
    expect(calls('capture.complete')).toHaveLength(0);

    await click(query('interview-voice-type-instead'));
    expect(document.activeElement).toBe(input());
    expect(query('interview-voice-record')).not.toBeNull();

    await type(input(), 'Typed instead');
    await click(query('interview-composer-submit'));
    expect(calls('workflow.answer.submit')[0].payload).not.toHaveProperty(
      'audio',
    );
  });

  it('cancels a recording without keeping audio', async () => {
    await renderHarness();
    await click(query('interview-voice-record'));
    await click(query('interview-recording-cancel'));

    expect(media.track.stop).toHaveBeenCalled();
    expect(media.closed).toBe(1);
    expect(calls('capture.cancel')).toHaveLength(1);
    expect(calls('capture.complete')).toHaveLength(0);
    expect(query('interview-voice-record')).not.toBeNull();
    expect(calls('answers.draft.save')).toHaveLength(0);
  });

  it('stops only transcription, then retries a failed job through Audio', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    handlers['stt.jobs.get'] = () => ({ job: job({ status: 'running' }) });
    handlers['stt.jobs.retry'] = () => ({ job: job({ status: 'running' }) });
    handlers['workflow.state.get'] = () => ({ state: answerable() });
    await renderHarness();

    await click(query('interview-voice-record'));
    await click(query('interview-recording-stop'));
    await click(query('interview-voice-cancel-transcription'));
    expect(
      calls('stt.jobs.cancel').map((c) => [c.module, c.payload.jobId]),
    ).toEqual([['audio', JOB_ID]]);
    // Interview work is untouched by Audio actions.
    expect(workCalls()).toEqual([]);
    expect(query('interview-voice-saved')!.textContent).toContain(
      'Recording saved (0:02)',
    );
    const reads = calls('stt.jobs.get').length;
    await advance(STT_POLL_MS * 3);
    expect(calls('stt.jobs.get')).toHaveLength(reads);

    handlers['stt.jobs.start'] = () => ({ job: job({ status: 'running' }) });
    handlers['stt.jobs.get'] = () => ({
      job: job({ status: 'failed', errorCode: 'engine_failed' }),
    });
    await click(query('interview-voice-transcribe'));
    await advance(STT_POLL_MS);
    expect(query('interview-voice-error')!.textContent).toContain(
      'Transcription didn’t finish',
    );
    await click(query('interview-voice-retry'));
    expect(calls('stt.jobs.retry').map((c) => c.payload)).toEqual([
      { jobId: JOB_ID },
    ]);
  });

  it('explains an unavailable speech engine without offering a futile retry', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    handlers['stt.jobs.get'] = () => ({
      job: job({ status: 'failed', errorCode: 'model_missing' }),
    });
    await renderHarness();
    await click(query('interview-voice-record'));
    await click(query('interview-recording-stop'));
    await advance(STT_POLL_MS);

    expect(query('interview-voice-error')!.textContent).toContain(
      'Speech-to-text isn’t set up',
    );
    expect(query('interview-voice-retry')).toBeNull();
    // The recording stays linked and can be replayed or removed.
    expect(query('interview-voice-listen')).not.toBeNull();
    await click(query('interview-voice-discard'));
    // Nothing left to keep, so the draft is cleared rather than saved empty.
    expect(calls('answers.draft.clear').map((c) => c.payload)).toEqual([
      { sessionId: SESSION_ID, questionId: QUESTION_ID },
    ]);
    expect(query('interview-voice-record')).not.toBeNull();
  });

  it('restores a saved voice draft and keeps typed edits', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    handlers['answers.draft.get'] = () => ({
      draft: {
        sessionId: SESSION_ID,
        questionId: QUESTION_ID,
        recordingId: RECORDING_ID,
        draftText: 'Restored transcript, edited.',
        updatedAt: NOW,
      },
    });
    handlers['stt.jobs.list'] = () => ({
      items: [
        job({
          id: 'old',
          createdAt: '2026-11-11T09:00:00.000Z',
          status: 'failed',
        }),
        job({ status: 'succeeded', transcriptId: TRANSCRIPT_ID }),
      ],
    });
    handlers['workflow.answer.submit'] = () => ({ state: workflow() });
    await renderHarness();

    expect(input().value).toBe('Restored transcript, edited.');
    expect(query('interview-voice-saved')!.textContent).toContain(
      'Transcript added',
    );
    expect(calls('stt.transcripts.get')).toHaveLength(0);

    await type(input(), 'Restored transcript, edited again.');
    await advance(DRAFT_SAVE_DELAY_MS);
    expect(calls('answers.draft.save').map((c) => c.payload)).toEqual([
      {
        sessionId: SESSION_ID,
        questionId: QUESTION_ID,
        recordingId: RECORDING_ID,
        draftText: 'Restored transcript, edited again.',
      },
    ]);

    await click(query('interview-composer-submit'));
    expect(calls('workflow.answer.submit')[0].payload.audio).toEqual({
      recordingId: RECORDING_ID,
      transcriptId: TRANSCRIPT_ID,
    });
  });

  it('resumes polling a transcription that was still running after navigation', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    handlers['answers.draft.get'] = () => ({
      draft: {
        sessionId: SESSION_ID,
        questionId: QUESTION_ID,
        recordingId: RECORDING_ID,
        draftText: null,
        updatedAt: NOW,
      },
    });
    handlers['stt.jobs.list'] = () => ({ items: [job({ status: 'running' })] });
    handlers['stt.jobs.get'] = () => ({
      job: job({ status: 'succeeded', transcriptId: TRANSCRIPT_ID }),
    });
    await renderHarness();
    expect(query('interview-voice-transcribing')).not.toBeNull();

    await advance(STT_POLL_MS);
    expect(input().value).toBe('I would use a token bucket.');
  });

  it('delivers a transcript that finished while the view was closed', async () => {
    handlers['answers.draft.get'] = () => ({
      draft: {
        sessionId: SESSION_ID,
        questionId: QUESTION_ID,
        recordingId: RECORDING_ID,
        draftText: 'Typed first.',
        updatedAt: '2026-11-11T10:00:00.000Z',
      },
    });
    handlers['stt.jobs.list'] = () => ({
      items: [
        job({
          status: 'succeeded',
          transcriptId: TRANSCRIPT_ID,
          updatedAt: '2026-11-11T10:00:05.000Z',
        }),
      ],
    });
    await renderHarness();

    expect(calls('stt.transcripts.get')).toHaveLength(1);
    expect(input().value).toBe('Typed first.\n\nI would use a token bucket.');
    expect(calls('answers.draft.save').at(-1)!.payload).toEqual({
      sessionId: SESSION_ID,
      questionId: QUESTION_ID,
      recordingId: RECORDING_ID,
      draftText: 'Typed first.\n\nI would use a token bucket.',
    });
  });

  it('keeps a recording that is still saving when the view is left', async () => {
    let complete!: () => void;
    handlers['capture.complete'] = () =>
      new Promise((resolve) => {
        complete = () => resolve({ recording });
      });
    await renderHarness();
    await click(query('interview-voice-record'));
    await click(query('interview-recording-stop'));
    expect(query('interview-recording')!.textContent).toContain(
      'Saving recording…',
    );

    await act(async () => root.render(<p />));
    complete();
    await settle();

    expect(calls('capture.cancel')).toHaveLength(0);
    expect(calls('answers.draft.save').at(-1)!.payload).toMatchObject({
      recordingId: RECORDING_ID,
    });
    // Leaving never starts STT on a view nobody sees.
    expect(calls('stt.jobs.start')).toHaveLength(0);
  });

  it('ignores a late draft restore while the microphone is live', async () => {
    let releaseDraft!: () => void;
    handlers['answers.draft.get'] = () =>
      new Promise((resolve) => {
        releaseDraft = () =>
          resolve({
            draft: {
              sessionId: SESSION_ID,
              questionId: QUESTION_ID,
              recordingId: '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c',
              draftText: null,
              updatedAt: NOW,
            },
          });
      });
    await renderHarness();
    await click(query('interview-voice-record'));
    releaseDraft();
    await settle();

    expect(query('interview-recording')).not.toBeNull();
    expect(calls('stt.jobs.list')).toHaveLength(0);
    await click(query('interview-recording-stop'));
    expect(media.track.stop).toHaveBeenCalled();
    expect(calls('capture.complete')).toHaveLength(1);
  });

  it('releases the microphone and timers when the view is left mid-recording, keeping typed text', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    await renderHarness();
    await type(input(), 'Half an answer');
    await click(query('interview-voice-record'));
    expect(calls('answers.draft.save')).toHaveLength(0);

    await act(async () => root.render(<p />));
    await settle();
    expect(media.track.stop).toHaveBeenCalled();
    expect(calls('capture.cancel')).toHaveLength(1);
    // The pending typed draft is flushed rather than lost.
    expect(calls('answers.draft.save').map((c) => c.payload.draftText)).toEqual(
      ['Half an answer'],
    );
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => media.emit(0.4));
    expect(calls('capture.append')).toHaveLength(0);
  });
});

// --- pure voice helpers -----------------------------------------------------

describe('voice helpers', () => {
  it('merges transcripts without losing edits', () => {
    expect(mergeTranscript('', ' hello ', null)).toBe('hello');
    expect(mergeTranscript('hello', 'again', 'hello')).toBe('again');
    expect(mergeTranscript('my edit', 'again', 'hello')).toBe(
      'my edit\n\nagain',
    );
  });

  it('maps device, storage and engine failures to recoverable messages', () => {
    expect(
      captureErrorMessage(
        Object.assign(new Error(), { name: 'NotFoundError' }),
      ),
    ).toContain('No microphone was found');
    expect(
      sttFailure({ status: 'interrupted', errorCode: null }),
    ).toMatchObject({ retryable: true });
    expect(
      sttFailure({ status: 'failed', errorCode: 'invalid_audio' }),
    ).toMatchObject({ retryable: false });
  });
});
