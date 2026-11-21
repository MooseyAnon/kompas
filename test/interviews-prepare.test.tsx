// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InterviewQuestionView,
  InterviewSession,
  InterviewSessionSummary,
  InterviewWorkflowState,
} from '../src/shared/contracts';
import { InterviewsPage } from '../src/renderer/pages/interviews/InterviewsPage';
import {
  buildPatch,
  emptyPrepareForm,
  formFromSession,
  validateCreate,
} from '../src/renderer/pages/interviews/prepare/prepareForm';
import { selectSessionView } from '../src/renderer/pages/interviews/session/sessionView';
import { SESSION_POLL_MS } from '../src/renderer/pages/interviews/session/useSessionWorkflow';
import { STATUS_PHRASE_INTERVAL_MS } from '../src/renderer/presentation/components/interviews/InterviewStatusBubble';

const DRAFT_ID = '0b7e3c1e-5d1f-4b8a-9a43-0f2d6c2a9e11';
const OTHER_ID = '7f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const TARGET_ID = '3c9d2b1a-8e7f-4a6b-9c5d-1e2f3a4b5c6d';
const NOW = '2026-11-11T10:00:00.000Z';
// Only the app's timers; React's scheduler keeps real ticks.
const FAKED_TIMERS: (
  | 'setTimeout'
  | 'clearTimeout'
  | 'setInterval'
  | 'clearInterval'
)[] = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];

const WORK_STARTING = new Set([
  'sessions.start',
  'workflow.continue',
  'workflow.answer.submit',
  'workflow.pause',
  'workflow.results.request',
  'questions.generate',
]);

// --- fixtures -------------------------------------------------------------

function session(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    id: DRAFT_ID,
    method: 'quick_fire',
    subject: 'System design',
    careerTargetId: null,
    targetSnapshot: null,
    questionCount: 5,
    additionalGuidance: null,
    status: 'draft',
    phase: null,
    barSnapshot: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function summary(
  overrides: Partial<InterviewSessionSummary> = {},
): InterviewSessionSummary {
  return {
    id: DRAFT_ID,
    method: 'quick_fire',
    subject: 'System design',
    status: 'draft',
    questionCount: 5,
    targetRole: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const question = {
  id: 'q-1',
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
    session: session({ status: 'active', phase: 'preparing' }),
    currentQuestion: null,
    operationId: null,
    availableActions: [],
    feedback: null,
    result: null,
    ...rest,
    progress: {
      phase: 'preparing',
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

const running = (sessionId = DRAFT_ID) =>
  workflow({
    session: session({ id: sessionId, status: 'active', phase: 'preparing' }),
    operationId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    availableActions: ['pause', 'abandon'],
    progress: { operationStatus: 'running', operation: 'working' },
  });

// --- fake backend -----------------------------------------------------------

type Handler = (payload: Record<string, unknown>) => unknown;
class Rejection {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

let handlers: Record<string, Handler>;
let backend: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function calls(action?: string) {
  return backend.mock.calls
    .map(
      ([input]) =>
        input as { action: string; payload: Record<string, unknown> },
    )
    .filter((input) => !action || input.action === action);
}
function workCalls() {
  return calls().filter((input) => WORK_STARTING.has(input.action));
}

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
  handlers = {
    'sessions.list': () => ({ items: [] }),
    'targets.list': () => ({ items: [] }),
  };
  backend = vi.fn(
    async (input: { action: string; payload: Record<string, unknown> }) => {
      const handler = handlers[input.action];
      if (!handler)
        return {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Unhandled.',
            correlationId: 'x',
          },
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- DOM helpers ------------------------------------------------------------

function query<T extends HTMLElement = HTMLElement>(testId: string) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}
function byId<T extends HTMLElement>(id: string) {
  return container.querySelector<T>(`#${id}`)!;
}
async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });
}
async function type(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(element: HTMLElement | null) {
  await act(async () => element!.click());
  await settle();
}

async function renderPage(
  props: Partial<React.ComponentProps<typeof InterviewsPage>> = {},
) {
  await act(async () => root.render(<InterviewsPage {...props} />));
  await settle();
}

// --- tests ------------------------------------------------------------------

describe('Prepare form', () => {
  it('offers keyboard-native method radios and only shows a count for Quick-fire', async () => {
    await renderPage();

    const radios = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    expect(radios.map((radio) => radio.value)).toEqual([
      'quick_fire',
      'deep_loop',
    ]);
    expect(radios.every((radio) => radio.name === 'prepare-method')).toBe(true);
    expect(radios[0].checked).toBe(true);
    expect(container.querySelector('legend')!.textContent).toBe(
      'Practice method',
    );
    expect(byId('prepare-count')).not.toBeNull();

    await click(radios[1]);
    expect(radios[1].checked).toBe(true);
    expect(query('method-choice-deep_loop')!.classList).toContain(
      'is-selected',
    );
    expect(container.querySelector('#prepare-count')).toBeNull();

    // Opening Prepare only reads lists; it never starts work.
    expect(
      calls()
        .map((input) => input.action)
        .sort(),
    ).toEqual(['sessions.list', 'targets.list']);
  });

  it('saves a Quick-fire draft with trimmed guidance and target without starting it', async () => {
    handlers['targets.list'] = () => ({
      items: [
        {
          id: TARGET_ID,
          profileId: 'p',
          roleTitle: 'Staff engineer',
          targetLevel: 'Staff',
          sector: null,
          location: null,
          active: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    handlers['sessions.create'] = (payload) => ({
      session: session({
        subject: payload.subject as string,
        careerTargetId: TARGET_ID,
        targetSnapshot: {
          role: 'Staff engineer',
          level: 'Staff',
          sector: null,
        },
        questionCount: payload.questionCount as number,
        additionalGuidance: payload.additionalGuidance as string,
      }),
    });
    await renderPage();

    await type(byId('prepare-subject'), '  System design  ');
    await choose(byId('prepare-target'), TARGET_ID);
    await choose(byId('prepare-count'), '7');
    await type(byId('prepare-guidance'), '  Ask STAR questions  ');
    expect(query('prepare-guidance-count')!.textContent).toBe('18 / 2,000');
    await click(query('prepare-save'));

    expect(calls('sessions.create').map((input) => input.payload)).toEqual([
      {
        method: 'quick_fire',
        subject: 'System design',
        careerTargetId: TARGET_ID,
        questionCount: 7,
        additionalGuidance: 'Ask STAR questions',
      },
    ]);
    expect(workCalls()).toEqual([]);
    expect(query('prepare-notice')!.textContent).toBe('Draft saved.');
    expect(container.querySelector('#prepare-title')!.textContent).toBe(
      'Edit draft',
    );
    expect(byId<HTMLTextAreaElement>('prepare-guidance').value).toBe(
      'Ask STAR questions',
    );
    expect(calls('sessions.list').length).toBe(2);
  });

  it('omits count and blank guidance for Deep Loop drafts', async () => {
    handlers['sessions.create'] = (payload) => ({
      session: session({
        method: 'deep_loop',
        questionCount: null,
        subject: payload.subject as string,
      }),
    });
    await renderPage();

    await click(
      container.querySelector<HTMLInputElement>('input[value="deep_loop"]'),
    );
    await type(byId('prepare-subject'), 'Product sense');
    await type(byId('prepare-guidance'), '   ');
    await click(query('prepare-save'));

    expect(calls('sessions.create')[0].payload).toEqual({
      method: 'deep_loop',
      subject: 'Product sense',
      careerTargetId: null,
    });
  });

  it('blocks invalid subject and overlength guidance before any request', async () => {
    await renderPage();

    await click(query('prepare-save'));
    expect(container.textContent).toContain('Add a subject to practise.');
    expect(byId('prepare-subject').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(byId('prepare-subject'));

    await type(byId('prepare-subject'), 'Art history');
    await type(byId('prepare-guidance'), 'x'.repeat(2001));
    // Overlength guidance is flagged live and never truncated.
    expect(query('prepare-guidance-count')!.classList).toContain('is-over');
    expect(byId('prepare-guidance').getAttribute('aria-invalid')).toBe('true');
    expect(byId<HTMLTextAreaElement>('prepare-guidance').value).toHaveLength(
      2001,
    );

    await click(query('prepare-start'));
    expect(document.activeElement).toBe(byId('prepare-guidance'));

    await type(byId('prepare-guidance'), 'Use my \u0007 notes');
    await click(query('prepare-save'));
    expect(container.textContent).toContain('Guidance contains characters');
    expect(calls('sessions.create')).toEqual([]);
    expect(workCalls()).toEqual([]);
  });
});

describe('Editing drafts', () => {
  beforeEach(() => {
    handlers['sessions.list'] = () => ({
      items: [summary(), summary({ id: OTHER_ID, subject: 'Behavioural' })],
    });
  });

  it('round-trips saved guidance and sends only the changed key', async () => {
    let saved = session({
      additionalGuidance: 'Focus on Apple interview topics',
    });
    handlers['sessions.get'] = () => ({ session: saved });
    handlers['sessions.update'] = (payload) => {
      const patch = payload.patch as Partial<InterviewSession>;
      saved = { ...saved, ...patch };
      return { session: saved };
    };
    await renderPage();

    await click(query('recent-session-edit'));
    expect(container.querySelector('#prepare-title')!.textContent).toBe(
      'Edit draft',
    );
    expect(byId<HTMLTextAreaElement>('prepare-guidance').value).toBe(
      'Focus on Apple interview topics',
    );
    // A saved draft's method is fixed.
    expect(
      container.querySelector<HTMLFieldSetElement>('fieldset.method-choice')!
        .disabled,
    ).toBe(true);
    expect(query<HTMLButtonElement>('prepare-save')!.disabled).toBe(true);

    await type(
      byId('prepare-guidance'),
      'Ask STAR questions based on my latest approved role',
    );
    await click(query('prepare-save'));
    expect(calls('sessions.update')[0].payload).toEqual({
      id: DRAFT_ID,
      patch: {
        additionalGuidance:
          'Ask STAR questions based on my latest approved role',
      },
    });

    await type(byId('prepare-guidance'), '');
    await click(query('prepare-save'));
    expect(calls('sessions.update')[1].payload).toEqual({
      id: DRAFT_ID,
      patch: { additionalGuidance: null },
    });
    expect(workCalls()).toEqual([]);
  });

  it('ignores a stale draft load after another draft is selected', async () => {
    let releaseFirst!: () => void;
    handlers['sessions.get'] = (payload) =>
      payload.id === DRAFT_ID
        ? new Promise((resolve) => {
            releaseFirst = () =>
              resolve({ session: session({ subject: 'System design' }) });
          })
        : { session: session({ id: OTHER_ID, subject: 'Behavioural' }) };
    await renderPage();

    await click(
      query(`recent-session-${DRAFT_ID}`)!.querySelector<HTMLElement>(
        '[data-testid="recent-session-edit"]',
      ),
    );
    await click(
      query(`recent-session-${OTHER_ID}`)!.querySelector<HTMLElement>(
        '[data-testid="recent-session-edit"]',
      ),
    );
    expect(byId<HTMLInputElement>('prepare-subject').value).toBe('Behavioural');

    await act(async () => releaseFirst());
    await settle();
    expect(byId<HTMLInputElement>('prepare-subject').value).toBe('Behavioural');
  });

  it('explains a stale-preview conflict and lets the user clear the preview', async () => {
    handlers['sessions.get'] = () => ({ session: session() });
    let previewExists = true;
    handlers['sessions.update'] = () => {
      if (previewExists)
        throw new Rejection(
          'CONFLICT',
          'Clear the generated question preview before changing the subject, target or guidance.',
        );
      return { session: session({ subject: 'Systems' }) };
    };
    handlers['questions.preview.get'] = () => ({
      question: previewExists ? question : null,
      bar: null,
    });
    handlers['questions.preview.clear'] = () => {
      previewExists = false;
      return { cleared: true };
    };
    await renderPage();

    await click(query('recent-session-edit'));
    await type(byId('prepare-subject'), 'Systems');
    await click(query('prepare-save'));

    const notice = query('prepare-notice')!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain(
      'Clear the generated question preview',
    );
    await click(query('prepare-clear-preview'));
    expect(calls('questions.preview.clear')[0].payload).toEqual({
      sessionId: DRAFT_ID,
    });

    await click(query('prepare-save'));
    expect(calls('sessions.update')).toHaveLength(2);
    expect(query('prepare-notice')!.textContent).toBe('Draft saved.');
  });

  it('confirms before deleting a draft', async () => {
    handlers['sessions.delete'] = () => ({ deleted: true });
    await renderPage();

    await click(query('recent-session-delete'));
    expect(container.textContent).toContain('Delete this draft?');
    expect(document.activeElement).toBe(query('recent-session-confirm-cancel'));
    await click(query('recent-session-confirm-cancel'));
    expect(calls('sessions.delete')).toEqual([]);

    await click(query('recent-session-delete'));
    await click(query('recent-session-confirm'));
    expect(calls('sessions.delete')[0].payload).toEqual({ id: DRAFT_ID });
  });
});

describe('Starting a practice', () => {
  beforeEach(() => {
    handlers['sessions.create'] = (payload) => ({
      session: session({ subject: payload.subject as string }),
    });
  });

  it('creates once, starts, and hands over to the large preparing status', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    let snapshot = running();
    handlers['sessions.start'] = () => ({
      session: session({ status: 'active' }),
      phase: 'preparing',
      progressId: 'p-1',
    });
    handlers['workflow.state.get'] = () => ({ state: snapshot });
    await renderPage();

    await type(byId('prepare-subject'), 'System design');
    await act(async () => {
      query('prepare-start')!.click();
      query('prepare-start')!.click();
    });
    await settle();

    expect(calls('sessions.create')).toHaveLength(1);
    expect(calls('sessions.start')).toHaveLength(1);
    const outlet = query('interviews-session-outlet')!;
    expect(outlet.getAttribute('data-session-id')).toBe(DRAFT_ID);
    expect(document.activeElement).toBe(query('interviews-view-session'));

    const status = query('session-preparing')!;
    expect(status.getAttribute('data-variant')).toBe('large');
    expect(status.querySelector('[role="status"]')!.textContent).toBe(
      'Preparing your first question',
    );
    const phrase = () => query('session-preparing-phrase')!.textContent;
    expect(phrase()).toBe('Finding a good opening question…');
    expect(query('session-preparing-phrase')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(container.textContent).not.toMatch(/\d+\s*%|score/i);

    await act(async () =>
      vi.advanceTimersByTimeAsync(STATUS_PHRASE_INTERVAL_MS),
    );
    expect(phrase()).toBe('Putting the first challenge together…');

    // Polling is passive; when Q1 lands the runner hand-over replaces the bubble.
    snapshot = workflow({
      currentQuestion: question,
      operationId: null,
      availableActions: ['answer', 'abandon'],
      progress: { phase: 'answering' },
    });
    await act(async () => vi.advanceTimersByTimeAsync(SESSION_POLL_MS));
    await settle();
    expect(query('session-preparing')).toBeNull();
    expect(query('session-question')!.textContent).toContain(question.question);

    const reads = calls('workflow.state.get').length;
    await act(async () => vi.advanceTimersByTimeAsync(SESSION_POLL_MS * 5));
    expect(calls('workflow.state.get')).toHaveLength(reads);
    expect(calls('sessions.start')).toHaveLength(1);
    expect(calls('workflow.continue')).toEqual([]);
  });

  it('keeps the draft and points to Local AI settings when start is refused', async () => {
    const onNavigate = vi.fn();
    handlers['sessions.start'] = () => {
      throw new Rejection(
        'CONFLICT',
        'Select an installed local model in Local AI settings first.',
      );
    };
    await renderPage({ onNavigate });

    await type(byId('prepare-subject'), 'System design');
    await click(query('prepare-start'));

    const notice = query('prepare-notice')!;
    expect(notice.getAttribute('data-stage')).toBe('start');
    expect(notice.textContent).toContain('The interview didn’t start.');
    expect(container.querySelector('#prepare-title')!.textContent).toBe(
      'Edit draft',
    );
    await click(query('prepare-open-settings'));
    expect(onNavigate).toHaveBeenCalledWith('settings');

    // Starting again reuses the saved draft rather than creating another.
    await click(query('prepare-start'));
    expect(calls('sessions.create')).toHaveLength(1);
    expect(calls('sessions.start')).toHaveLength(2);
  });
});

describe('Session outlet states', () => {
  const failedState = () =>
    workflow({
      availableActions: ['retry', 'abandon'],
      progress: {
        operationStatus: 'failed',
        errorMessage:
          'Select an installed local model in Local AI settings first.',
      },
    });

  async function openSession(onNavigate = vi.fn()) {
    await renderPage({
      initialLocation: {
        view: 'session',
        sessionId: DRAFT_ID,
        returnTo: 'prepare',
      },
      onNavigate,
    });
    return onNavigate;
  }

  it('shows a missing-model failure with settings and an explicit retry, never auto-retrying', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    let snapshot = failedState();
    handlers['workflow.state.get'] = () => ({ state: snapshot });
    handlers['workflow.continue'] = () => {
      snapshot = running();
      return { state: snapshot };
    };
    const onNavigate = await openSession();

    expect(query('session-failed')!.textContent).toContain(
      'Select an installed local model',
    );
    await act(async () => vi.advanceTimersByTimeAsync(SESSION_POLL_MS * 4));
    expect(workCalls()).toEqual([]);
    expect(calls('workflow.state.get')).toHaveLength(1);

    await click(query('session-open-settings'));
    expect(onNavigate).toHaveBeenCalledWith('settings');

    await click(query('session-retry'));
    expect(calls('workflow.continue').map((input) => input.payload)).toEqual([
      { sessionId: DRAFT_ID, action: 'retry' },
    ]);
    expect(query('session-preparing')).not.toBeNull();
  });

  it('hides Retry when the snapshot does not advertise it', async () => {
    handlers['workflow.state.get'] = () => ({
      state: { ...failedState(), availableActions: ['abandon'] },
    });
    await openSession();
    expect(query('session-failed')).not.toBeNull();
    expect(query('session-retry')).toBeNull();
  });

  it('resumes a paused session only when asked', async () => {
    handlers['workflow.state.get'] = () => ({
      state: workflow({
        session: session({ status: 'active', phase: 'paused' }),
        availableActions: ['continue', 'abandon'],
      }),
    });
    handlers['workflow.continue'] = () => ({ state: running() });
    await openSession();

    expect(query('session-paused')).not.toBeNull();
    expect(workCalls()).toEqual([]);
    await click(query('session-resume'));
    expect(calls('workflow.continue')[0].payload).toEqual({
      sessionId: DRAFT_ID,
      action: 'continue',
    });
  });
});

describe('Resuming from Prepare', () => {
  beforeEach(() => {
    handlers['sessions.list'] = () => ({
      items: [summary({ status: 'active' })],
    });
  });

  it('continues a paused session through the advertised action', async () => {
    handlers['workflow.state.get'] = () => ({
      state: workflow({
        session: session({ status: 'active', phase: 'paused_review' }),
        availableActions: ['continue', 'abandon'],
      }),
    });
    handlers['workflow.continue'] = () => ({ state: running() });
    await renderPage();

    expect(query('recent-session-edit')).toBeNull();
    await click(query('recent-session-resume'));
    expect(calls('workflow.continue')[0].payload).toEqual({
      sessionId: DRAFT_ID,
      action: 'continue',
    });
    expect(calls('sessions.start')).toEqual([]);
    expect(query('session-preparing')).not.toBeNull();
  });

  it('rebuilds missing work with an explicit start when nothing is running', async () => {
    let started = false;
    handlers['workflow.state.get'] = () => ({
      state: started
        ? running()
        : workflow({ availableActions: ['continue', 'abandon'] }),
    });
    handlers['sessions.start'] = () => {
      started = true;
      return {
        session: session({ status: 'active' }),
        phase: 'preparing',
        progressId: null,
      };
    };
    await renderPage();

    await click(query('recent-session-resume'));
    expect(calls('sessions.start')).toHaveLength(1);
    expect(calls('workflow.continue')).toEqual([]);
    expect(query('session-preparing')).not.toBeNull();
  });

  it('does not retry a failed operation on resume', async () => {
    handlers['workflow.state.get'] = () => ({
      state: workflow({
        availableActions: ['retry', 'abandon'],
        progress: { operationStatus: 'failed', errorMessage: 'Model missing.' },
      }),
    });
    await renderPage();

    await click(query('recent-session-resume'));
    expect(workCalls()).toEqual([]);
    expect(query('session-retry')).not.toBeNull();
  });

  it('confirms before abandoning an unfinished session', async () => {
    handlers['sessions.finish'] = () => ({ session: session(), summary: {} });
    await renderPage();

    await click(query('recent-session-abandon'));
    expect(container.textContent).toContain('Abandon this interview?');
    await click(query('recent-session-confirm'));
    expect(calls('sessions.finish')[0].payload).toEqual({
      sessionId: DRAFT_ID,
      outcome: 'abandoned',
    });
  });
});

describe('Prepare form model', () => {
  it('mirrors the backend schema and only patches changed keys', () => {
    expect(validateCreate(emptyPrepareForm)).toEqual({
      subject: 'Add a subject to practise.',
    });
    expect(
      Object.keys(
        validateCreate({ ...emptyPrepareForm, subject: 'x'.repeat(201) }),
      ),
    ).toEqual(['subject']);
    expect(
      validateCreate({
        ...emptyPrepareForm,
        subject: 'A',
        additionalGuidance: ` ${'y'.repeat(2000)} `,
      }),
    ).toEqual({});

    const draft = session({
      careerTargetId: TARGET_ID,
      additionalGuidance: 'Old',
    });
    const values = formFromSession(draft);
    expect(buildPatch(draft, values)).toEqual({});
    expect(buildPatch(draft, { ...values, careerTargetId: '' })).toEqual({
      careerTargetId: null,
    });
    expect(
      buildPatch(draft, { ...values, additionalGuidance: '  Old ' }),
    ).toEqual({});
  });

  it('classifies only pre-question states for Prepare and hands later ones to the runner', () => {
    expect(selectSessionView(running()).kind).toBe('preparing');
    expect(
      selectSessionView(
        workflow({ currentQuestion: question, operationId: 'x' }),
      ).kind,
    ).toBe('runner');
    expect(
      selectSessionView(workflow({ progress: { answeredCount: 1 } })).kind,
    ).toBe('runner');
    expect(
      selectSessionView(
        workflow({ session: session({ status: 'completed' }) }),
      ),
    ).toEqual({ kind: 'finished', outcome: 'completed' });
    expect(
      selectSessionView(workflow({ availableActions: ['continue'] })),
    ).toEqual({ kind: 'stalled', canContinue: true });
  });
});
