// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InsightsDetail,
  InterviewQuestionView,
  InterviewReviewDecision,
  InterviewSessionSummaryResult,
  InterviewWorkflowAction,
  InterviewWorkflowState,
  SttJob,
} from '../src/shared/contracts';
import { SESSION_POLL_MS } from '../src/renderer/pages/interviews/session/useSessionWorkflow';
import { STT_POLL_MS } from '../src/renderer/pages/interviews/answer/voiceAnswer';
import { SessionOutlet } from '../src/renderer/pages/interviews/session/SessionOutlet';
import { FakeMedia } from './fixtures/fake-microphone';

const SESSION_ID = '0b7e3c1e-5d1f-4b8a-9a43-0f2d6c2a9e11';
const OPERATION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const RECORDING_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const TRANSCRIPT_ID = '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e';
const JOB_ID = '4d5e6f7a-8b9c-4d4e-8f5a-6b7c8d9e0f1a';
const CAPTURE_ID = '5e6f7a8b-9c0d-4e5f-9a6b-7c8d9e0f1a2b';
const NOW = '2026-11-12T10:00:00.000Z';

const FAKED_TIMERS: (
  | 'setTimeout'
  | 'clearTimeout'
  | 'setInterval'
  | 'clearInterval'
  | 'Date'
)[] = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'];

/** Granular commands the Quick-fire UI must never call. */
const GRANULAR = [
  'sessions.advance',
  'reviews.run',
  'coaching.run',
  'questions.generate',
  'reassessment.generate',
  'answers.submit',
];
/** Reads that carry review data; only allowed after publication. */
const REVIEW_READS = [
  'reviews.get',
  'insights.sessions.get',
  'sessions.transcript',
];

const uuid = (prefix: string, index: number) =>
  `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
const questionId = (index: number) => uuid('11111111', index);
const roundId = (index: number) => uuid('22222222', index);

class Rejection {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

/**
 * Deterministic Quick-fire backend following the real snapshot rules
 * (`interviews.session.service.ts#getState`): questions generate in the
 * background, each answer is reviewed on its own, results are embargoed and
 * `workflow.results.request` only starts the synthesis once every review is
 * done. Tests drive time by finishing generation, reviews or synthesis.
 */
class FakeQuickFire {
  generated = 1;
  answers: Record<string, unknown>[] = [];
  reviewed = 0;
  generating = true;
  reviewsRunning = false;
  synthesisRunning = false;
  paused = false;
  status: 'active' | 'completed' | 'abandoned' = 'active';
  failure: { status: 'failed' | 'cancelled'; message: string | null } | null =
    null;
  publications = 0;
  synthesisStarts = 0;
  decisions: { decision: InterviewReviewDecision; score: number | null }[] = [];
  narrativeUnavailable = false;

  constructor(readonly count: number) {}

  question(index: number): InterviewQuestionView {
    return {
      id: questionId(index + 1),
      roundId: roundId(index + 1),
      question: `Quick-fire prompt ${index + 1}: how would you plan the work?`,
      competency: index % 2 ? 'Communication' : 'Problem solving',
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
    };
  }

  get answered() {
    return this.answers.length;
  }
  get running() {
    return (
      !this.paused &&
      (this.generating || this.reviewsRunning || this.synthesisRunning)
    );
  }

  state(): InterviewWorkflowState {
    const active = this.status === 'active';
    const current =
      active && !this.paused && this.answered < this.generated
        ? this.question(this.answered)
        : null;
    const allAnswered = this.answered === this.count;
    const allReviewed = this.reviewed === this.count;

    let actions: InterviewWorkflowAction[] = [];
    if (active && this.paused) actions = ['continue', 'abandon'];
    else if (active) {
      if (current) {
        actions.push('answer');
        if (this.failure) actions.push('retry');
      } else if (this.failure) actions.push('retry');
      else if (allAnswered && allReviewed && !this.reviewsRunning)
        actions.push('request_results');
      else actions.push('continue');
      if (allAnswered && !actions.includes('request_results'))
        actions.push('request_results');
      if (this.running) actions.push('pause');
      actions.push('abandon');
    }

    const phase = this.paused
      ? 'paused'
      : this.status === 'active'
        ? 'answering'
        : this.status;
    return {
      session: {
        id: SESSION_ID,
        method: 'quick_fire',
        subject: 'Platform engineering',
        careerTargetId: null,
        targetSnapshot: { role: 'Staff Engineer', level: null, sector: null },
        questionCount: this.count,
        additionalGuidance: null,
        status: this.status,
        phase,
        barSnapshot: null,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: NOW,
        completedAt: this.status === 'active' ? null : NOW,
      },
      currentQuestion: current,
      progress: {
        phase,
        operationStatus: this.running
          ? 'running'
          : (this.failure?.status ?? 'idle'),
        progressText: null,
        operation: this.running ? 'working' : null,
        errorMessage: this.running ? null : (this.failure?.message ?? null),
        questionCount: this.count,
        answeredCount: this.answered,
        reviewedCount: this.reviewed,
        canSubmit: actions.includes('answer'),
        canRetry: actions.includes('retry'),
      },
      operationId: this.running ? OPERATION_ID : null,
      availableActions: actions,
      feedback: null,
      result:
        this.status === 'completed' && this.publications > 0
          ? this.result()
          : null,
    };
  }

  decision(index: number) {
    return (
      this.decisions[index] ??
      (index % 2
        ? { decision: 'fail' as const, score: 45 }
        : { decision: 'pass' as const, score: 80 })
    );
  }

  result(): InterviewSessionSummaryResult {
    const rounds = Array.from({ length: this.count }, (_, index) => ({
      roundId: roundId(index + 1),
      ordinal: index + 1,
      competency: this.question(index).competency,
      ...this.decision(index),
      isReassessment: false,
    }));
    const scored = rounds.filter((round) => round.score !== null);
    return {
      method: 'quick_fire',
      subject: 'Platform engineering',
      totalRounds: this.count,
      answeredCount: this.count,
      reviewedCount: this.count,
      passCount: rounds.filter((r) => r.decision === 'pass').length,
      failCount: rounds.filter((r) => r.decision === 'fail').length,
      unscoredCount: rounds.filter((r) => r.decision === 'unscored').length,
      averageScore: scored.length
        ? scored.reduce((sum, r) => sum + r.score!, 0) / scored.length
        : null,
      complete: true,
      recommendation: null,
      narrative: this.narrativeUnavailable
        ? null
        : {
            strengths: ['Clear structure throughout'],
            gaps: ['Quantify the impact more often'],
            recommendations: ['Practise naming one measurable outcome'],
          },
      narrativeUnavailable: this.narrativeUnavailable,
      publishedAt: NOW,
      rounds,
    };
  }

  detail(): InsightsDetail {
    const session = this.state().session;
    return {
      session,
      bar: {
        schemaVersion: 1,
        kind: 'practice_benchmark',
        status: 'practice',
        target: null,
        subject: 'Platform engineering',
        basis: [],
        assumptions: [],
        criteria: [
          { id: 'c1', label: 'Structure', description: 'd', weight: 0.5 },
          { id: 'c2', label: 'Impact', description: 'd', weight: 0.5 },
        ],
        passThreshold: 70,
      },
      rounds: Array.from({ length: this.count }, (_, index) => {
        const { decision, score } = this.decision(index);
        return {
          id: roundId(index + 1),
          ordinal: index + 1,
          reassessmentOfRoundId: null,
          questions: [
            {
              id: questionId(index + 1),
              kind: 'primary' as const,
              question: this.question(index).question,
              competency: this.question(index).competency,
              createdAt: NOW,
              answer: `Saved answer ${index + 1}`,
            },
          ],
          review: {
            id: uuid('33333333', index + 1),
            roundId: roundId(index + 1),
            decision,
            score,
            provisional: true as const,
            barKind: 'practice_benchmark' as const,
            passThreshold: 70,
            criteria: [],
            strengths: [`Round ${index + 1} strength`],
            gaps: [],
            needsMoreEvidence: false,
            unscoredReason: null,
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
        };
      }),
    };
  }

  // --- commands (mirroring the session service) ---------------------------

  submit(payload: Record<string, unknown>) {
    const state = this.state();
    if (
      !state.availableActions.includes('answer') ||
      state.currentQuestion?.id !== payload.questionId
    )
      throw new Rejection('CONFLICT', 'This question is not ready.');
    this.answers.push(payload);
    this.reviewsRunning = true;
    return { state: this.state() };
  }

  requestResults() {
    if (this.status !== 'active' || this.paused) return { state: this.state() };
    if (this.answered === this.count) {
      if (this.reviewed < this.count) {
        if (!this.failure) this.reviewsRunning = true;
      } else if (!this.synthesisRunning && !this.generating) {
        this.failure = null;
        this.synthesisRunning = true;
        this.synthesisStarts += 1;
      }
    }
    return { state: this.state() };
  }

  continue(action: InterviewWorkflowAction) {
    if (!this.state().availableActions.includes(action))
      throw new Rejection('CONFLICT', 'That action is not available.');
    this.paused = false;
    if (action === 'retry') this.failure = null;
    this.generating = this.generated < this.count;
    this.reviewsRunning = this.reviewed < this.answered;
    return { state: this.state() };
  }

  pause() {
    this.paused = true;
    this.synthesisRunning = false;
    return { state: this.state() };
  }

  // --- time ------------------------------------------------------------------

  finishGeneration(upTo = this.count) {
    this.generated = upTo;
    if (this.generated >= this.count) this.generating = false;
  }
  finishReviews() {
    this.reviewed = this.answered;
    this.reviewsRunning = false;
  }
  finishSynthesis() {
    this.synthesisRunning = false;
    this.status = 'completed';
    this.publications += 1;
  }
  fail(
    status: 'failed' | 'cancelled' = 'failed',
    message: string | null = null,
  ) {
    this.generating = false;
    this.reviewsRunning = false;
    this.synthesisRunning = false;
    this.failure = { status, message };
  }
  /** Every answer saved and reviewed, nothing running (after a restart). */
  allAnsweredAndReviewed() {
    this.finishGeneration();
    for (let index = 0; index < this.count; index += 1)
      this.answers.push({ questionId: questionId(index + 1) });
    this.finishReviews();
  }
}

// --- harness ------------------------------------------------------------------

type Handler = (payload: Record<string, unknown>) => unknown;
type Call = {
  module: string;
  action: string;
  payload: Record<string, unknown>;
};

let fake: FakeQuickFire;
let handlers: Record<string, Handler>;
let backend: ReturnType<typeof vi.fn>;
let media: FakeMedia;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onOpenLocalAi: ReturnType<typeof vi.fn>;

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

function quickFireHandlers(): Record<string, Handler> {
  return {
    'workflow.state.get': () => ({ state: fake.state() }),
    'workflow.answer.submit': (payload) => fake.submit(payload),
    'workflow.results.request': () => fake.requestResults(),
    'workflow.continue': (payload) =>
      fake.continue(payload.action as InterviewWorkflowAction),
    'workflow.pause': () => fake.pause(),
    'sessions.finish': () => {
      fake.status = 'abandoned';
      return { session: fake.state().session, summary: null };
    },
    'insights.sessions.get': () => fake.detail(),
    'answers.draft.get': () => ({ draft: null }),
    'answers.draft.save': (payload) => ({
      draft: { ...payload, updatedAt: NOW },
    }),
    'answers.draft.clear': () => ({ cleared: true }),
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
    'capture.complete': () => ({
      recording: {
        id: RECORDING_ID,
        mediaType: 'audio/wav',
        codec: 'pcm_s16le',
        sampleRate: 16000,
        channels: 1,
        sizeBytes: 64000,
        durationMs: 2000,
        label: 'Interview answer',
        createdAt: NOW,
      },
    }),
    'capture.cancel': () => ({ cancelled: true }),
    'stt.jobs.start': () => ({ job: job() }),
    'stt.jobs.get': () => ({
      job: job({ status: 'succeeded', transcriptId: TRANSCRIPT_ID }),
    }),
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
        text: ' I would split the rollout into stages. ',
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
  fake = new FakeQuickFire(5);
  handlers = quickFireHandlers();
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
  onOpenLocalAi = vi.fn();
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

function calls(action?: string) {
  return backend.mock.calls
    .map(([input]) => input as Call)
    .filter((input) => !action || input.action === action);
}
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
const input = () => query<HTMLTextAreaElement>('interview-composer-input')!;
const submitButton = () =>
  query<HTMLButtonElement>('interview-composer-submit')!;
const questionText = () => query('session-question-text')?.textContent;
const progressText = () => query('quick-fire-progress')!.textContent;

async function renderOutlet() {
  await act(async () =>
    root.render(
      <SessionOutlet sessionId={SESSION_ID} onOpenLocalAi={onOpenLocalAi} />,
    ),
  );
  await settle();
}

/** Nothing on screen or in reads may hint at an assessment before publication. */
function expectEmbargo() {
  expect(container.textContent).not.toMatch(
    /score|\/\s*100|%|met the bar|below the bar|unscored|strength|pass mark/i,
  );
  for (const action of REVIEW_READS) expect(calls(action)).toEqual([]);
}
function expectNoGranularCalls() {
  for (const action of GRANULAR) expect(calls(action)).toEqual([]);
}

// --- tests ----------------------------------------------------------------------

describe('Quick-fire runner', () => {
  it.each([5, 10])(
    'runs %i questions: Q1 early, a delayed next question, one submit each and one publication',
    async (count) => {
      vi.useFakeTimers({ toFake: FAKED_TIMERS });
      fake = new FakeQuickFire(count);
      await renderOutlet();

      // Q1 is answerable while the rest of the batch still generates.
      expect(fake.generated).toBe(1);
      expect(questionText()).toBe(fake.question(0).question);
      expect(progressText()).toContain(`Question 1 of ${count}`);
      expect(progressText()).toContain('0 answered');
      const background = query('quick-fire-background')!;
      expect(background.dataset.variant).toBe('chip');
      expect(background.textContent).toContain('Preparing the next question');
      expect(input().readOnly).toBe(false);
      expect(query('quick-fire-actions-pause')).not.toBeNull();
      expect(query('quick-fire-actions-abandon')).not.toBeNull();
      expectEmbargo();

      // Rapid clicks plus the shortcut commit exactly one answer.
      await type(input(), 'Answer 1');
      await act(async () => {
        submitButton().click();
        submitButton().click();
        input().dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            metaKey: true,
            bubbles: true,
          }),
        );
      });
      await settle();
      expect(calls('workflow.answer.submit')).toHaveLength(1);

      // Q2 is still generating: a small pending bubble, not a blocking panel.
      const waiting = query('quick-fire-next-pending')!;
      expect(waiting.dataset.variant).toBe('inline');
      expect(waiting.textContent).toContain('Preparing the next question');
      expect(waiting.textContent).toContain('Answer saved');
      expect(progressText()).toContain(`Question 2 of ${count}`);
      expect(progressText()).toContain('1 answered');
      expect(container.textContent).toContain('Answer 1 saved.');
      await advance(SESSION_POLL_MS * 3);
      expect(query('quick-fire-next-pending')).not.toBeNull();
      expectEmbargo();

      // The next question appears on the next passive read once it exists.
      fake.finishGeneration();
      await advance(SESSION_POLL_MS);
      for (let index = 1; index < count; index += 1) {
        expect(questionText()).toBe(fake.question(index).question);
        expect(progressText()).toContain(`Question ${index + 1} of ${count}`);
        await type(input(), `Answer ${index + 1}`);
        await click(submitButton());
      }
      expect(
        calls('workflow.answer.submit').map((call) => call.payload.questionId),
      ).toEqual(
        Array.from({ length: count }, (_, index) => questionId(index + 1)),
      );

      // All answered: reviews still run privately; nothing is disclosed.
      expect(query('quick-fire-all-answered')!.textContent).toContain(
        `All ${count} answers saved`,
      );
      expect(progressText()).toContain(`All ${count} answered`);
      expectEmbargo();

      const request = query('quick-fire-request-results')!;
      await act(async () => {
        request.click();
        request.click();
      });
      await settle();
      expect(calls('workflow.results.request')).toHaveLength(1);
      const checking = query('quick-fire-results-pending')!;
      expect(checking.dataset.variant).toBe('large');
      expect(checking.textContent).toContain('Checking your answers');

      // Polling stays passive while reviews finish.
      await advance(SESSION_POLL_MS * 4);
      expect(calls('workflow.results.request')).toHaveLength(1);
      expect(fake.synthesisStarts).toBe(0);

      // Once actionable, the request is sent exactly once more.
      fake.finishReviews();
      await advance(SESSION_POLL_MS);
      expect(calls('workflow.results.request')).toHaveLength(2);
      expect(fake.synthesisStarts).toBe(1);
      expect(query('quick-fire-results-pending')!.textContent).toContain(
        'Preparing your results',
      );
      expectEmbargo();
      await advance(SESSION_POLL_MS * 3);
      expect(calls('workflow.results.request')).toHaveLength(2);

      fake.finishSynthesis();
      await advance(SESSION_POLL_MS);
      expect(query('quick-fire-results')).not.toBeNull();
      expect(fake.publications).toBe(1);
      expect(calls('insights.sessions.get')).toHaveLength(1);
      for (let index = 1; index <= count; index += 1)
        expect(query(`quick-fire-result-round-${index}`)).not.toBeNull();

      // A published result stops polling and sends nothing else.
      const reads = calls('workflow.state.get').length;
      await advance(SESSION_POLL_MS * 4);
      expect(calls('workflow.state.get')).toHaveLength(reads);
      expect(calls('workflow.results.request')).toHaveLength(2);
      expectNoGranularCalls();
    },
  );

  it('starts the synthesis on the first request when reviews are already done', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    fake.allAnsweredAndReviewed();
    await renderOutlet();

    expect(query('quick-fire-all-answered')).not.toBeNull();
    await click(query('quick-fire-request-results'));
    expect(fake.synthesisStarts).toBe(1);
    expect(query('quick-fire-results-pending')!.textContent).toContain(
      'Preparing your results',
    );
    fake.finishSynthesis();
    await advance(SESSION_POLL_MS);
    expect(query('quick-fire-results')).not.toBeNull();
    expect(calls('workflow.results.request')).toHaveLength(1);
  });

  it('sends at most one follow-up request when the snapshot stays idle', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    // After a restart: answers saved, reviews unfinished, nothing running.
    fake.allAnsweredAndReviewed();
    fake.reviewed = 2;
    // The first request resumes reviews; later ones never start anything.
    handlers['workflow.results.request'] = () =>
      calls('workflow.results.request').length === 1
        ? fake.requestResults()
        : { state: fake.state() };
    await renderOutlet();

    await click(query('quick-fire-request-results'));
    fake.finishReviews();
    await advance(SESSION_POLL_MS * 10);
    expect(calls('workflow.results.request')).toHaveLength(2);
    // The user's own button comes back instead of a loop.
    expect(query('quick-fire-request-results')).not.toBeNull();
  });

  it('never re-sends a refused results request on its own', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    fake.allAnsweredAndReviewed();
    handlers['workflow.results.request'] = () => {
      throw new Rejection('INTERNAL', 'Results could not be requested.');
    };
    await renderOutlet();

    await click(query('quick-fire-request-results'));
    await advance(SESSION_POLL_MS * 5);
    expect(calls('workflow.results.request')).toHaveLength(1);
    expect(container.textContent).toContain('Results could not be requested.');
    expect(query('quick-fire-request-results')).not.toBeNull();
  });

  it('recovers results after a restart and never publishes twice', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    // Restart: answers saved, reviews unfinished, nothing running.
    fake.allAnsweredAndReviewed();
    fake.reviewed = 2;
    await renderOutlet();

    const panel = query('quick-fire-all-answered')!;
    expect(panel).not.toBeNull();
    expect(query('quick-fire-actions-pause')).toBeNull();
    expectEmbargo();

    await click(query('quick-fire-request-results'));
    expect(query('quick-fire-results-pending')!.textContent).toContain(
      'Checking your answers',
    );
    fake.finishReviews();
    await advance(SESSION_POLL_MS);
    fake.finishSynthesis();
    await advance(SESSION_POLL_MS);
    expect(query('quick-fire-results')).not.toBeNull();

    // Re-opening after another restart reads the saved result only.
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderOutlet();
    expect(query('quick-fire-results')).not.toBeNull();
    expect(calls('workflow.results.request')).toHaveLength(2);
    expect(fake.publications).toBe(1);
  });

  it('shows unscored results honestly and says when no narrative exists', async () => {
    fake.allAnsweredAndReviewed();
    fake.decisions = Array.from({ length: 5 }, () => ({
      decision: 'unscored' as const,
      score: null,
    }));
    fake.narrativeUnavailable = true;
    fake.finishSynthesis();
    await renderOutlet();

    expect(query('interview-result-summary-score')!.textContent).toBe(
      'Unscored',
    );
    expect(container.textContent).toContain('5 unscored');
    expect(container.textContent).not.toMatch(/\b0(\.0)? \/ 100\b/);
    expect(
      query('interview-result-summary-narrative-unavailable'),
    ).not.toBeNull();
    expect(query('interview-result-summary-narrative')).toBeNull();
    expect(container.textContent).not.toContain('Try next');
    expect(query('quick-fire-result-round-1-score')!.textContent).toBe(
      'Unscored',
    );
  });

  it('shows the published score, narrative and each answer with its review', async () => {
    fake.allAnsweredAndReviewed();
    fake.finishSynthesis();
    await renderOutlet();

    // Three passes at 80 and two fails at 45 average 66.
    expect(query('interview-result-summary-score')!.textContent).toBe(
      '66 / 100 average',
    );
    expect(container.textContent).toContain('3 met the bar');
    expect(container.textContent).toContain('2 below the bar');
    expect(container.textContent).toContain(
      'Pass mark 70 · Practice benchmark (provisional)',
    );
    expect(query('interview-result-summary-narrative')!.textContent).toContain(
      'Practise naming one measurable outcome',
    );
    const round = query('quick-fire-result-round-2')!;
    expect(round.textContent).toContain(fake.question(1).question);
    expect(round.textContent).toContain('Below the bar');
    expect(round.textContent).toContain('45 / 100');
    expect(round.textContent).toContain('Saved answer 2');
    expect(
      round.querySelector('[data-testid="quick-fire-review-2"]'),
    ).not.toBeNull();
    // Terminal: no session actions remain.
    expect(query('quick-fire-actions')).toBeNull();
  });

  it('pauses durably, resumes only on request, and abandons after confirmation', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    await renderOutlet();
    await type(input(), 'Half an answer');

    await click(query('quick-fire-actions-pause'));
    expect(calls('workflow.pause')).toHaveLength(1);
    expect(query('session-paused')).not.toBeNull();
    // The unfinished answer was kept as a draft when the composer closed.
    expect(calls('answers.draft.save').at(-1)!.payload).toMatchObject({
      draftText: 'Half an answer',
    });

    // Paused is passive: no polling-triggered resume.
    await advance(SESSION_POLL_MS * 5);
    expect(calls('workflow.continue')).toEqual([]);

    await click(query('session-resume'));
    expect(calls('workflow.continue').map((c) => c.payload.action)).toEqual([
      'continue',
    ]);
    expect(questionText()).toBe(fake.question(0).question);

    // Abandon is terminal and distinct from pause; it needs confirmation.
    await click(query('quick-fire-actions-abandon'));
    expect(calls('sessions.finish')).toEqual([]);
    await click(query('quick-fire-actions-confirm-accept'));
    expect(calls('sessions.finish').map((c) => c.payload)).toEqual([
      { sessionId: SESSION_ID, outcome: 'abandoned' },
    ]);
    expect(query('session-finished')!.textContent).toContain('abandoned');
    expect(calls('sessions.cancelOperation')).toEqual([]);
  });

  it('sends nothing when the view is left', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    await renderOutlet();
    const before = calls().filter((c) => c.action !== 'answers.draft.get');
    await act(async () => root.unmount());
    await advance(SESSION_POLL_MS * 5);
    root = createRoot(container);
    expect(calls().filter((c) => c.action !== 'answers.draft.get')).toEqual(
      before,
    );
  });

  it('keeps answering beside a background failure and retries only when advertised', async () => {
    fake.answers.push({ questionId: questionId(1) });
    fake.finishGeneration(2);
    fake.fail('failed', 'The local model stopped responding.');
    await renderOutlet();

    const alert = query('quick-fire-background-error')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('The local model stopped responding.');
    expect(alert.textContent).not.toMatch(/review|score/i);
    expect(input().readOnly).toBe(false);

    await click(query('quick-fire-background-retry'));
    expect(calls('workflow.continue').map((c) => c.payload.action)).toEqual([
      'retry',
    ]);
    expect(query('quick-fire-background-error')).toBeNull();
  });

  it('offers retry and Local AI settings when the next question fails', async () => {
    fake.answers.push({ questionId: questionId(1) });
    fake.fail('failed', 'Select an installed model in Local AI settings.');
    await renderOutlet();

    const panel = query('quick-fire-failed')!;
    expect(panel.textContent).toContain(
      'The next question couldn’t be prepared',
    );
    await click(query('quick-fire-open-settings'));
    expect(onOpenLocalAi).toHaveBeenCalledTimes(1);
    await click(query('quick-fire-retry'));
    expect(calls('workflow.continue').map((c) => c.payload.action)).toEqual([
      'retry',
    ]);
    expect(query('quick-fire-next-pending')).not.toBeNull();
  });

  it('restarts a stopped synthesis only through an explicit results request', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    fake.allAnsweredAndReviewed();
    fake.fail('cancelled', 'The operation was cancelled.');
    await renderOutlet();

    const panel = query('quick-fire-failed')!;
    expect(panel.textContent).toContain('Preparing your results was stopped');
    expect(query('quick-fire-open-settings')).toBeNull();
    await advance(SESSION_POLL_MS * 3);
    expect(calls('workflow.results.request')).toEqual([]);

    await click(query('quick-fire-retry'));
    expect(calls('workflow.results.request')).toHaveLength(1);
    expect(calls('workflow.continue')).toEqual([]);
    expect(fake.synthesisStarts).toBe(1);
  });

  it('offers an explicit continue when nothing prepares the next question', async () => {
    fake.answers.push({ questionId: questionId(1) });
    fake.generating = false;
    await renderOutlet();

    expect(query('quick-fire-stalled')).not.toBeNull();
    await click(query('quick-fire-continue'));
    expect(calls('workflow.continue').map((c) => c.payload.action)).toEqual([
      'continue',
    ]);
  });

  it('keeps the typed answer when a submit is refused, then commits once', async () => {
    await renderOutlet();
    let refuse = true;
    handlers['workflow.answer.submit'] = (payload) => {
      if (refuse) {
        refuse = false;
        throw new Rejection('CONFLICT', 'This question is not ready.');
      }
      return fake.submit(payload);
    };
    await type(input(), 'My careful answer');
    await click(submitButton());
    expect(input().value).toBe('My careful answer');
    expect(container.textContent).toContain('This question is not ready.');
    expect(fake.answered).toBe(0);

    await click(submitButton());
    expect(fake.answered).toBe(1);
    expect(fake.answers[0]).toMatchObject({ answerText: 'My careful answer' });
  });
});

describe('Quick-fire voice answers', () => {
  it('records, transcribes into editable text and submits with the audio link', async () => {
    vi.useFakeTimers({ toFake: FAKED_TIMERS });
    await renderOutlet();

    await click(query('interview-voice-record'));
    expect(query('interview-recording')!.textContent).toContain('Recording');
    expect(submitButton().disabled).toBe(true);
    await act(async () => media.emit(0.4));
    await advance(1000);
    await click(query('interview-recording-stop'));
    expect(media.track.stop).toHaveBeenCalled();
    expect(calls('stt.jobs.start')).toHaveLength(1);

    await advance(STT_POLL_MS);
    expect(input().value).toBe('I would split the rollout into stages.');
    // A transcript is never submitted on its own.
    expect(calls('workflow.answer.submit')).toEqual([]);

    await type(input(), 'I would split the rollout into three stages.');
    await click(submitButton());
    expect(calls('workflow.answer.submit').map((c) => c.payload)).toEqual([
      {
        sessionId: SESSION_ID,
        questionId: questionId(1),
        answerText: 'I would split the rollout into three stages.',
        audio: { recordingId: RECORDING_ID, transcriptId: TRANSCRIPT_ID },
      },
    ]);
    // Audio work never touched interview operations.
    expect(calls('sessions.cancelOperation')).toEqual([]);
    expect(calls('workflow.pause')).toEqual([]);
  });

  it('keeps typed text when the microphone is denied or recording is cancelled', async () => {
    await renderOutlet();
    await type(input(), 'Typed first');

    media.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    await click(query('interview-voice-record'));
    expect(query('interview-voice-error')!.textContent).toContain(
      'Microphone access was blocked',
    );
    expect(input().value).toBe('Typed first');

    await click(query('interview-voice-type-instead'));
    await click(query('interview-voice-record'));
    await click(query('interview-recording-cancel'));
    expect(calls('capture.cancel').length).toBeGreaterThan(0);
    expect(input().value).toBe('Typed first');

    await click(submitButton());
    expect(calls('workflow.answer.submit')[0].payload).not.toHaveProperty(
      'audio',
    );
    expect(calls('workflow.answer.submit')[0].payload.answerText).toBe(
      'Typed first',
    );
  });
});
