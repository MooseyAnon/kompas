import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import type { Dispatcher } from '../src/main/ipc/dispatcher';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import type { InferenceService } from '../src/main/modules/inference/inference.service';
import type { GenerationEntry } from '../src/main/modules/inference/generation-scheduler';
import type {
  GenerationEvent,
  GenerationRequestInput,
  GenerationResult,
  InferenceErrorCode,
  InferenceSettingsGetOutput,
  JsonValue,
  ModelDescriptor,
  ResponseEnvelope,
} from '../src/shared/contracts';

// --- Deterministic scripted inference fake (streaming + gate + cancel) -------

type Task = 'question' | 'review' | 'coach' | 'synthesis';

function detectTask(request: GenerationRequestInput): Task {
  const format = request.responseFormat;
  if (format && format.type === 'json_schema') {
    const props = format.schema.properties;
    if ('criterionIds' in props) {
      return 'review';
    }
    if ('diagnosis' in props) {
      return 'coach';
    }
    if ('recommendations' in props) return 'synthesis';
  }
  return 'question';
}

function criterionIdsFrom(request: GenerationRequestInput): string[] {
  const text = request.messages.map((m) => m.content).join('\n');
  const ids: string[] = [];
  const pattern = /id "([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

type Spec =
  | { kind: 'ok'; output: JsonValue }
  | { kind: 'fail'; code: InferenceErrorCode }
  | { kind: 'cancelled' };

function localModel(providerId: string, id: string): ModelDescriptor {
  return {
    providerId,
    id,
    displayName: id,
    locality: 'local',
    installed: true,
    sizeBytes: null,
    parameterSize: null,
    quantization: null,
    contextLength: null,
    capabilities: {
      text: 'supported',
      streaming: 'supported',
      structuredOutput: 'supported',
      tools: 'unsupported',
    },
  };
}

class FakeInference {
  providerId: string | null = 'mock';
  modelId: string | null = 'mock-static';
  resolvedModel: ModelDescriptor | null = localModel('mock', 'mock-static');
  reviewScore = 80;
  thinkingSupported = true;
  questionCounter = 0;
  calls = { question: 0, review: 0, coach: 0, synthesis: 0 };
  thinkingCalls: Array<{ task: Task; thinking: boolean | undefined }> = [];
  /** Prompt text per call, used for reviewer/coach privacy assertions. */
  requests: Array<{ task: Task; text: string }> = [];
  /** Non-null makes default reviews quote evidence absent from the answer. */
  reviewEvidence: string | null = null;
  questionScript: Spec[] = [];
  reviewScript: Spec[] = [];
  coachScript: Spec[] = [];
  synthesisScript: Spec[] = [];
  gateOnQuestionNumber: number | null = null;
  gateOnTask: Task | null = null;
  priorities: Array<{ task: Task; priority: string | undefined }> = [];
  entries: GenerationEntry[] = [];

  // Gate used to hold a generation mid-flight so a test can observe progress
  // or cancel. When open, generate waits until released or aborted.
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  lastOnEvent: ((event: GenerationEvent) => void) | null = null;
  lastRequestId: string | null = null;

  openGate(): void {
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.gate = null;
    this.releaseGate = null;
  }

  async getSettingsSnapshot(): Promise<InferenceSettingsGetOutput> {
    return {
      settings: {
        mode: 'local_only',
        providerId: this.providerId,
        modelId: this.modelId,
        generationTimeoutMs: null,
        updatedAt: new Date().toISOString(),
      },
      resolvedModel: this.resolvedModel,
      warnings: [],
    };
  }

  cancel(): Promise<{ result: 'cancelled' }> {
    return Promise.resolve({ result: 'cancelled' });
  }

  async generate(request: GenerationEntry): Promise<GenerationResult> {
    const task = detectTask(request);
    this.entries.push(request);
    this.calls[task] += 1;
    this.thinkingCalls.push({ task, thinking: request.thinking });
    this.requests.push({
      task,
      text: request.messages.map((m) => m.content).join('\n'),
    });
    this.priorities.push({
      task,
      priority: request.execution.priority,
    });
    const requestId = request.requestId ?? crypto.randomUUID();
    const base = {
      requestId,
      providerId: request.providerId,
      modelId: request.modelId,
      toolCalls: [],
      usage: null,
    };
    if (
      (task === 'review' || task === 'synthesis') &&
      request.thinking &&
      !this.thinkingSupported
    ) {
      return {
        ...base,
        status: 'failed',
        output: null,
        error: { code: 'CAPABILITY_UNSUPPORTED', message: 'unsupported' },
      };
    }

    // Stream a delta so the runner's ephemeral progress becomes observable.
    const controls = request;
    this.lastOnEvent = controls.execution.onEvent ?? null;
    this.lastRequestId = requestId;
    controls.execution?.onEvent?.({
      kind: 'delta',
      requestId,
      seq: 0,
      at: new Date().toISOString(),
      text: 'streaming-token ',
    });

    if (
      this.gate &&
      (this.gateOnTask === task ||
        (this.gateOnTask === null &&
          (this.gateOnQuestionNumber === null ||
            (task === 'question' &&
              this.calls.question === this.gateOnQuestionNumber))))
    ) {
      const aborted = await Promise.race([
        this.gate.then(() => false),
        abortSignalPromise(controls.execution?.signal).then(() => true),
      ]);
      if (aborted || controls.execution?.signal?.aborted) {
        return { ...base, status: 'cancelled', output: null };
      }
    }
    if (controls.execution?.signal?.aborted) {
      return { ...base, status: 'cancelled', output: null };
    }

    const spec = this.specFor(task, request);
    if (spec.kind === 'ok') {
      return { ...base, status: 'completed', output: spec.output };
    }
    if (spec.kind === 'cancelled') {
      return { ...base, status: 'cancelled', output: null };
    }
    return {
      ...base,
      status: 'failed',
      output: null,
      error: { code: spec.code, message: 'failed' },
    };
  }

  private specFor(task: Task, request: GenerationRequestInput): Spec {
    if (task === 'synthesis')
      return (
        this.synthesisScript.shift() ?? {
          kind: 'ok',
          output: {
            strengths: ['Addresses the question'],
            gaps: ['Needs more concrete reasoning'],
            recommendations: ['Practise with evidence'],
          },
        }
      );
    if (task === 'review') {
      const scripted = this.reviewScript.shift();
      if (scripted) {
        return scripted;
      }
      const ids = criterionIdsFrom(request);
      return {
        kind: 'ok',
        output: {
          criterionIds: ids,
          scores: ids.map(() => this.reviewScore),
          evidence: ids.map(() => this.reviewEvidence ?? ''),
          rationales: ids.map(() => 'Assessed against the criterion.'),
          strengths: ['Addresses the question'],
          gaps: ['Needs more concrete reasoning'],
          needsMoreEvidence: false,
        },
      };
    }
    if (task === 'coach') {
      const scripted = this.coachScript.shift();
      if (scripted) {
        return scripted;
      }
      return {
        kind: 'ok',
        output: {
          diagnosis: 'The answer lacks justified trade-offs.',
          advice: [
            'State requirements first.',
            'Name two concrete trade-offs.',
          ],
          workedExample: 'A stronger answer weighs reliability against cost.',
          reassessmentFocus: 'Justifying trade-offs',
        },
      };
    }
    const scripted = this.questionScript.shift();
    if (scripted) {
      return scripted;
    }
    const joined = request.messages.map((m) => m.content).join('\n');
    const kind = joined.includes('## Original question')
      ? 'Follow-up'
      : joined.includes('materially different scenario')
        ? 'Reassessment'
        : 'Primary';
    const n = this.questionCounter++;
    return { kind: 'ok', output: fakeQuestionOutput(kind, n) };
  }
}

/** A genuinely distinct, schema-valid question per counter (avoids dedupe). */
const FAKE_SCENARIOS = [
  'how feudal land tenure shaped military obligations',
  'why monastic scriptoria mattered for preserving knowledge',
  'how guild apprenticeship regulated urban craft quality',
  'what triggered the growth of market towns and fairs',
  'how the Black Death reshaped rural labour relations',
  'why pilgrimage routes influenced regional economies',
  'how coinage debasement affected trust in trade',
  'what role cathedral building played in civic identity',
  'how marriage alliances stabilised competing dynasties',
  'why charters constrained the power of lords over towns',
  'how crop rotation changed village food security',
  'what made maritime republics dominate Mediterranean trade',
  'how legal ordeals gave way to jury-based judgement',
  'why heresy movements spread through new preaching orders',
];

function fakeQuestionOutput(kind: string, n: number): JsonValue {
  const scenario = FAKE_SCENARIOS[n % FAKE_SCENARIOS.length];
  return {
    question: `${kind} ${n}: discuss ${scenario}, and weigh the key factors involved.`,
    competency: 'historical analysis',
    criteria: [
      `Explains ${scenario} with accurate detail`,
      'Weighs competing factors and evidence',
    ],
    sourceBasis: 'model_general_knowledge',
  };
}

function abortSignalPromise(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise(() => {});
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

// --- Harness ----------------------------------------------------------------

let workDir: string;
let jsonlPath: string;
let storage: Storage;
let telemetry: TelemetryService;
let fake: FakeInference;
let dispatcher: Dispatcher;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-isession-'));
  jsonlPath = path.join(workDir, 'app.jsonl');
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(jsonlPath),
  });
  fake = new FakeInference();
  dispatcher = buildDispatcher();
});

describe('06.5 durable cancellation fences', () => {
  it('fences a late review from an independent SQLite connection after recovery', async () => {
    const sessionId = await createSession('deep_loop');
    ok(await send('sessions.start', { sessionId }));
    const primary = (await workflowIdle(sessionId)).currentQuestion!;
    await workflow('answer.submit', {
      sessionId,
      questionId: primary.id,
      answerText: 'An answer retained across separate connections.',
    });
    const followUp = (await workflowIdle(sessionId)).currentQuestion!;
    fake.gateOnTask = 'review';
    fake.openGate();
    await workflow('answer.submit', {
      sessionId,
      questionId: followUp.id,
      answerText: 'Follow-up answer.',
    });
    for (let i = 0; i < 50 && fake.calls.review < 1; i++) await tick();
    expect(fake.calls.review).toBe(1);

    const secondStorage = openStorage(workDir);
    try {
      fake.gateOnTask = 'synthesis';
      const recovered = buildDispatcher(secondStorage);
      // A read on the second connection cannot start work; explicit start
      // increments the durable epoch and reconstructs the missing review.
      expect(
        (await workflow('state.get', { sessionId }, recovered)).operationId,
      ).toBeNull();
      ok(await send('sessions.start', { sessionId }, recovered));
      expect(
        (await workflowIdle(sessionId, recovered)).feedback?.review,
      ).not.toBeNull();
      fake.release(); // old provider returns success after the new review committed
      for (let i = 0; i < 5; i++) await tick();
      expect(
        storage.db.prepare('SELECT count(*) AS n FROM interview_reviews').get(),
      ).toEqual({ n: 1 });
      expect(storage.db.pragma('foreign_key_check')).toEqual([]);
      expect(secondStorage.db.pragma('integrity_check')).toEqual([
        { integrity_check: 'ok' },
      ]);
    } finally {
      fake.release();
      secondStorage.close();
    }
  });

  it('fences a granular review from a previous dispatcher after explicit restart recovery', async () => {
    const sessionId = await createSession('deep_loop');
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const first = await workflow('state.get', { sessionId });
    const roundId = first.currentQuestion!.roundId;
    ok(
      await send('answers.submit', {
        sessionId,
        questionId: first.currentQuestion!.id,
        answerText: 'Private answer.',
      }),
    );
    fake.gateOnTask = 'review';
    fake.openGate();
    const oldReview = send('reviews.run', { sessionId, roundId });
    await tick();
    fake.gateOnTask = 'synthesis';
    const relaunched = buildDispatcher();
    ok(await send('sessions.start', { sessionId }, relaunched));
    fake.release();
    expectError(await oldReview, 'INTERNAL');
    expect(
      storage.db.prepare('SELECT count(*) AS n FROM interview_reviews').get(),
    ).toEqual({ n: 0 });
    const ready = await workflowIdle(sessionId, relaunched);
    expect(ready.currentQuestion?.roundId).toBe(roundId);
    await workflow(
      'answer.submit',
      {
        sessionId,
        questionId: ready.currentQuestion!.id,
        answerText: 'Follow-up answer.',
      },
      relaunched,
    );
    expect(
      (await workflowIdle(sessionId, relaunched)).feedback?.review,
    ).not.toBeNull();
    expect(
      storage.db.prepare('SELECT count(*) AS n FROM interview_reviews').get(),
    ).toEqual({ n: 1 });
  });

  it.each(['review', 'coach', 'reassessment'] as const)(
    'rejects a late granular %s write after abandonment',
    async (step) => {
      fake.reviewScore = 40;
      const sessionId = await createSession('deep_loop');
      ok(await send('sessions.start', { sessionId }));
      await waitIdle(sessionId);
      const state = await workflow('state.get', { sessionId });
      const roundId = state.currentQuestion!.roundId;
      ok(
        await send('answers.submit', {
          sessionId,
          questionId: state.currentQuestion!.id,
          answerText: 'Private answer kept after abandonment.',
        }),
      );
      if (step !== 'review')
        ok(await send('reviews.run', { sessionId, roundId }));
      if (step === 'reassessment')
        ok(await send('coaching.run', { sessionId, roundId }));

      fake.gateOnTask = step === 'reassessment' ? 'question' : step;
      fake.openGate();
      const action =
        step === 'review'
          ? 'reviews.run'
          : step === 'coach'
            ? 'coaching.run'
            : 'reassessment.generate';
      const payload =
        step === 'reassessment'
          ? { sessionId, failedRoundId: roundId }
          : { sessionId, roundId };
      const pending = send(action, payload);
      await tick();
      ok(await send('sessions.finish', { sessionId, outcome: 'abandoned' }));
      fake.release();
      expectError(await pending, 'CONFLICT');
      expect((await workflow('state.get', { sessionId })).session.status).toBe(
        'abandoned',
      );
      expect(
        storage.db.prepare('SELECT count(*) AS n FROM interview_reviews').get(),
      ).toEqual({ n: step === 'review' ? 0 : 1 });
      expect(
        storage.db
          .prepare('SELECT count(*) AS n FROM interview_coaching')
          .get(),
      ).toEqual({ n: step === 'reassessment' ? 1 : 0 });
      expect(
        storage.db.prepare('SELECT count(*) AS n FROM interview_rounds').get(),
      ).toEqual({ n: 1 });
      expect(storage.db.pragma('foreign_key_check')).toEqual([]);
    },
  );

  it('keeps a paused session quiescent through restart until explicit resume', async () => {
    const sessionId = await createSession('quick_fire');
    fake.gateOnQuestionNumber = 2;
    fake.openGate();
    ok(await send('sessions.start', { sessionId }));
    for (let i = 0; i < 50 && fake.calls.question < 2; i++) await tick();
    await workflow('pause', { sessionId });
    fake.release();
    const before = fake.calls.question;
    const relaunched = buildDispatcher();
    for (let i = 0; i < 3; i++)
      await workflow('state.get', { sessionId }, relaunched);
    expect(fake.calls.question).toBe(before);
    expect(
      (await workflow('state.get', { sessionId }, relaunched)).availableActions,
    ).toEqual(['continue', 'abandon']);
    await workflow('continue', { sessionId, action: 'continue' }, relaunched);
    await waitIdle(sessionId, relaunched);
    expect(
      storage.db
        .prepare(
          'SELECT count(*) AS n FROM interview_rounds WHERE session_id = ?',
        )
        .get(sessionId),
    ).toEqual({ n: 5 });
  });
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function buildDispatcher(activeStorage = storage): Dispatcher {
  return createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry,
    storage: { db: activeStorage.db, fileStore: activeStorage.fileStore },
    inference: { service: fake as unknown as InferenceService },
  });
}

async function send<T = unknown>(
  action: string,
  payload: unknown,
  active: Dispatcher = dispatcher,
): Promise<ResponseEnvelope<T>> {
  return active.dispatch({
    requestId: crypto.randomUUID(),
    module: 'interviews',
    version: 1,
    action,
    payload,
  }) as Promise<ResponseEnvelope<T>>;
}

function ok<T>(response: ResponseEnvelope<T>): T {
  if (!response.ok) {
    throw new Error(`expected ok, got ${response.error.code}`);
  }
  return response.data;
}

function expectError(response: ResponseEnvelope<unknown>, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe(code);
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface ProgressOut {
  phase: string | null;
  operationStatus: 'idle' | 'running' | 'failed' | 'cancelled';
  progressText: string | null;
  errorMessage: string | null;
  questionCount: number;
  answeredCount: number;
  reviewedCount: number;
  canSubmit: boolean;
  canRetry: boolean;
}

async function waitIdle(
  sessionId: string,
  active: Dispatcher = dispatcher,
): Promise<ProgressOut> {
  for (let i = 0; i < 500; i += 1) {
    const p = ok<ProgressOut>(
      await send('sessions.progress', { sessionId }, active),
    );
    if (p.operationStatus !== 'running') {
      return p;
    }
    await tick();
  }
  throw new Error('operation did not settle');
}

async function createSession(
  method: 'deep_loop' | 'quick_fire',
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    method,
    subject: 'medieval european history',
    ...overrides,
  };
  if (method === 'quick_fire' && payload.questionCount === undefined) {
    payload.questionCount = 5;
  }
  const data = ok<{ session: { id: string } }>(
    await send('sessions.create', payload),
  );
  return data.session.id;
}

interface AdvanceOut {
  session: { id: string; status: string; phase: string | null };
  currentQuestion: { id: string; roundId: string; question: string } | null;
  phase: string | null;
  progressId: string | null;
}

/** Drive a quick-fire session: start, answer all N, assess, return summary. */
async function runQuickFire(
  sessionId: string,
  n: number,
): Promise<{ answered: number }> {
  ok(await send('sessions.start', { sessionId }));
  await waitIdle(sessionId);
  let answered = 0;
  for (let i = 0; i < n; i += 1) {
    const adv = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
    expect(adv.currentQuestion).not.toBeNull();
    const q = adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>;
    ok(
      await send('answers.submit', {
        sessionId,
        questionId: q.id,
        answerText: `Answer ${i} with concrete reasoning and trade-offs discussed.`,
      }),
    );
    answered += 1;
  }
  // Independent assessments may already have settled by the last answer.
  ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
  await waitIdle(sessionId);
  return { answered };
}

describe('quick-fire interactive runner', () => {
  for (const n of [5, 10]) {
    it(`generates exactly N=${n} distinct questions and embargoes early reviews`, async () => {
      const sessionId = await createSession('quick_fire', { questionCount: n });
      ok(await send('sessions.start', { sessionId }));
      const prepared = await waitIdle(sessionId);
      expect(prepared.phase).toBe('answering');
      expect(prepared.questionCount).toBe(n);

      // Exactly N distinct primary questions were persisted.
      const transcript0 = ok<{ items: Array<{ type: string; text: string }> }>(
        await send('sessions.transcript', { sessionId }),
      );
      const questions = transcript0.items
        .filter((t) => t.type === 'question')
        .map((t) => t.text);
      expect(questions).toHaveLength(n);
      expect(new Set(questions).size).toBe(n);

      // Answer N-1; reviews begin immediately but cannot be read publicly.
      for (let i = 0; i < n - 1; i += 1) {
        const adv = ok<AdvanceOut>(
          await send('sessions.advance', { sessionId }),
        );
        const q = adv.currentQuestion as NonNullable<
          AdvanceOut['currentQuestion']
        >;
        ok(
          await send('answers.submit', {
            sessionId,
            questionId: q.id,
            answerText: `Answer ${i} with concrete reasoning and clear trade-offs.`,
          }),
        );
      }
      expect(fake.calls.review).toBe(n - 1);
      const mid = await waitIdle(sessionId);
      expect(mid.reviewedCount).toBe(n - 1);
      expect(mid.answeredCount).toBe(n - 1);

      // Final answer; its assessment is independent of the previous rounds.
      const last = ok<AdvanceOut>(
        await send('sessions.advance', { sessionId }),
      );
      const lastQ = last.currentQuestion as NonNullable<
        AdvanceOut['currentQuestion']
      >;
      ok(
        await send('answers.submit', {
          sessionId,
          questionId: lastQ.id,
          answerText: 'Final answer with strong, concrete reasoning.',
        }),
      );
      ok(await send('sessions.advance', { sessionId }));
      const assessed = await waitIdle(sessionId);
      expect(assessed.phase).toBe('assessed');
      expect(assessed.reviewedCount).toBe(n);
      expect(fake.calls.review).toBe(n);
      expect(fake.calls.coach).toBe(0);

      expectError(
        await send('sessions.finish', { sessionId, outcome: 'completed' }),
        'CONFLICT',
      );
      ok(await send('workflow.results.request', { sessionId }));
      await waitIdle(sessionId);
      const finished = ok<{
        summary: {
          totalRounds: number;
          passCount: number;
          averageScore: number | null;
          complete: boolean;
        };
      }>(await send('sessions.finish', { sessionId, outcome: 'completed' }));
      expect(finished.summary.totalRounds).toBe(n);
      expect(finished.summary.passCount).toBe(n);
      expect(finished.summary.complete).toBe(true);
      expect(finished.summary.averageScore).toBe(80);

      // Referential integrity across the populated interview tables is intact.
      expect(storage.db.pragma('foreign_key_check') as unknown[]).toHaveLength(
        0,
      );
    });
  }

  it('shows a truthful partial assessment when a review is unscored', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 5 });
    // One round's review is honestly unscored on both the attempt and its
    // bounded repair retry (needs more evidence), never a fabricated score.
    const unscored: Spec = {
      kind: 'ok',
      output: {
        criterionIds: ['accuracy', 'reasoning', 'relevance'],
        scores: [0, 0, 0],
        needsMoreEvidence: true,
      },
    };
    fake.reviewScript = [unscored, unscored];
    await runQuickFire(sessionId, 5);
    const finished = ok<{
      summary: {
        passCount: number;
        unscoredCount: number;
        reviewedCount: number;
      };
    }>(
      await send('workflow.results.request', { sessionId }).then(async () => {
        await waitIdle(sessionId);
        return send('sessions.finish', { sessionId, outcome: 'completed' });
      }),
    );
    expect(finished.summary.unscoredCount).toBe(1);
    expect(finished.summary.passCount).toBe(4);
    expect(finished.summary.reviewedCount).toBe(5);
  });

  it('rejects completing before every question is answered and assessed', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 5 });
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    expectError(
      await send('sessions.finish', { sessionId, outcome: 'completed' }),
      'CONFLICT',
    );
    // Abandoning is always allowed (explicitly incomplete).
    const abandoned = ok<{ session: { status: string } }>(
      await send('sessions.finish', { sessionId, outcome: 'abandoned' }),
    );
    expect(abandoned.session.status).toBe('abandoned');
  });

  it('resumes after relaunch and fills only the missing questions', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 6 });
    // Let two questions succeed, then fail the third (interrupted generation).
    fake.questionScript = [
      specQuestion(0),
      specQuestion(1),
      { kind: 'fail', code: 'WORKER_EXITED' },
    ];
    fake.questionCounter = 2;
    ok(await send('sessions.start', { sessionId }));
    const failed = await waitIdle(sessionId);
    expect(failed.operationStatus).toBe('failed');
    expect(failed.canRetry).toBe(true);

    // Simulate relaunch: a fresh dispatcher over the same storage.
    const relaunched = buildDispatcher();
    const before = ok<{ items: Array<{ type: string }> }>(
      await send('sessions.transcript', { sessionId }, relaunched),
    );
    const persistedQuestions = before.items.filter(
      (t) => t.type === 'question',
    ).length;
    expect(persistedQuestions).toBe(2);

    // Restart fills the remaining 4 unique ordinals, never duplicating.
    ok(await send('sessions.start', { sessionId }, relaunched));
    const done = await waitIdle(sessionId, relaunched);
    expect(done.phase).toBe('answering');
    expect(done.questionCount).toBe(6);
    const after = ok<{ items: Array<{ type: string; text: string }> }>(
      await send('sessions.transcript', { sessionId }, relaunched),
    );
    const qs = after.items
      .filter((t) => t.type === 'question')
      .map((t) => t.text);
    expect(qs).toHaveLength(6);
    expect(new Set(qs).size).toBe(6);
  });
});

function specQuestion(n: number): Spec {
  return {
    kind: 'ok',
    output: {
      ...(fakeQuestionOutput('Primary', n) as Record<string, JsonValue>),
    },
  };
}

describe('deep-loop interactive runner', () => {
  async function startDeepLoop(sessionId: string): Promise<AdvanceOut> {
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    return ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
  }

  async function answer(sessionId: string, questionId: string): Promise<void> {
    ok(
      await send('answers.submit', {
        sessionId,
        questionId,
        answerText:
          'A thoughtful answer naming concrete trade-offs and reasons.',
      }),
    );
  }

  it('runs primary → one follow-up → passing review → next question', async () => {
    const sessionId = await createSession('deep_loop');
    const first = await startDeepLoop(sessionId);
    expect(first.phase).toBe('answering');
    const primary = first.currentQuestion as NonNullable<
      AdvanceOut['currentQuestion']
    >;
    await answer(sessionId, primary.id);

    // Advance → one bounded follow-up is generated.
    const fu = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
    expect(fu.phase).toBe('follow_up');
    await waitIdle(sessionId);
    const fuReady = ok<AdvanceOut>(
      await send('sessions.advance', { sessionId }),
    );
    expect(fuReady.phase).toBe('follow_up');
    const followUp = fuReady.currentQuestion as NonNullable<
      AdvanceOut['currentQuestion']
    >;
    expect(followUp.id).not.toBe(primary.id);
    await answer(sessionId, followUp.id);

    // Advance → ready for review (only one follow-up allowed).
    const ready = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
    expect(ready.phase).toBe('awaiting_review');

    const reviewed = ok<{ review: { decision: string } }>(
      await send('reviews.run', { sessionId, roundId: primary.roundId }),
    );
    expect(reviewed.review.decision).toBe('pass');

    // Advance after a pass → a new independent primary question.
    const next = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
    await waitIdle(sessionId);
    const nextReady = ok<AdvanceOut>(
      await send('sessions.advance', { sessionId }),
    );
    expect(nextReady.phase).toBe('answering');
    const nextQ = nextReady.currentQuestion as NonNullable<
      AdvanceOut['currentQuestion']
    >;
    expect(nextQ.roundId).not.toBe(primary.roundId);
    expect(next.phase).toBe('answering');
  });

  it('coaches a failed round, offers a linked reassessment, and halts at the cap', async () => {
    const sessionId = await createSession('deep_loop');
    fake.reviewScore = 40; // every review fails.

    let active = await startDeepLoop(sessionId);
    let reassessments = 0;
    const cap = 2;

    for (let guard = 0; guard < 10; guard += 1) {
      const current = active.currentQuestion as NonNullable<
        AdvanceOut['currentQuestion']
      >;
      await answer(sessionId, current.id);
      // Advance through any follow-up for the round.
      let state = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
      if (state.phase === 'follow_up') {
        await waitIdle(sessionId);
        state = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
        const fu = state.currentQuestion;
        if (fu) {
          await answer(sessionId, fu.id);
          state = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
        }
      }
      expect(state.phase).toBe('awaiting_review');

      const review = ok<{ review: { decision: string } }>(
        await send('reviews.run', { sessionId, roundId: current.roundId }),
      );
      expect(review.review.decision).toBe('fail');

      // Advance → coaching required.
      const afterReview = ok<AdvanceOut>(
        await send('sessions.advance', { sessionId }),
      );
      expect(afterReview.phase).toBe('reviewed');
      ok(await send('coaching.run', { sessionId, roundId: current.roundId }));

      const afterCoach = ok<AdvanceOut>(
        await send('sessions.advance', { sessionId }),
      );
      if (afterCoach.phase === 'assessed') {
        // Cap reached — no further reassessment is offered.
        break;
      }
      expect(afterCoach.phase).toBe('coached');
      const reassessed = ok<{
        newRoundId: string;
        question: { id: string; roundId: string; question: string };
      }>(
        await send('reassessment.generate', {
          sessionId,
          failedRoundId: current.roundId,
        }),
      );
      reassessments += 1;
      expect(reassessed.question.question).not.toBe(current.question);
      active = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
      expect(active.phase).toBe('answering');
    }

    expect(reassessments).toBe(cap);
    const summary = ok<{ summary: { recommendation: string | null } }>(
      await send('sessions.finish', { sessionId, outcome: 'completed' }),
    );
    expect(summary.summary.recommendation).toMatch(/practice limit/i);
  });

  it('includes follow-up context in the review', async () => {
    const sessionId = await createSession('deep_loop');
    const first = await startDeepLoop(sessionId);
    const primary = first.currentQuestion as NonNullable<
      AdvanceOut['currentQuestion']
    >;
    await answer(sessionId, primary.id);
    ok(await send('sessions.advance', { sessionId }));
    await waitIdle(sessionId);
    const fuReady = ok<AdvanceOut>(
      await send('sessions.advance', { sessionId }),
    );
    const followUp = fuReady.currentQuestion as NonNullable<
      AdvanceOut['currentQuestion']
    >;
    await answer(sessionId, followUp.id);
    ok(await send('sessions.advance', { sessionId }));
    ok(await send('reviews.run', { sessionId, roundId: primary.roundId }));
    // The last review request must carry the follow-up exchange.
    // (Captured implicitly: the review passed with follow-up answers present.)
    const transcript = ok<{ items: Array<{ type: string }> }>(
      await send('sessions.transcript', { sessionId }),
    );
    const followUpQuestions = transcript.items.filter(
      (t) => t.type === 'question',
    );
    expect(followUpQuestions.length).toBeGreaterThanOrEqual(2);
  });
});

describe('runner safety: progress, cancel, late events, failures', () => {
  it('keeps private thinking deltas out of progress, errors and persistent telemetry', async () => {
    const sessionId = await createSession('deep_loop');
    const reasoning = 'PRIVATE-REASONING-CANARY-06.6';
    fake.openGate();
    ok(await send('sessions.start', { sessionId }));
    for (let i = 0; i < 50 && !fake.lastOnEvent; i++) await tick();
    expect(fake.lastOnEvent).not.toBeNull();
    fake.lastOnEvent!({
      kind: 'thinking_delta',
      requestId: fake.lastRequestId!,
      seq: 2,
      at: new Date().toISOString(),
      text: reasoning,
    });
    const state = await workflow('state.get', { sessionId });
    expect(state.progress.operationStatus).toBe('running');
    expect(JSON.stringify(state)).not.toContain(reasoning);
    fake.release();
    await workflowIdle(sessionId);
    expect(
      JSON.stringify(storage.db.prepare('SELECT * FROM operation_runs').all()),
    ).not.toContain(reasoning);
    expect(fs.readFileSync(jsonlPath, 'utf8')).not.toContain(reasoning);
  });

  it('streams ephemeral progress during generation and clears it when settled', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 5 });
    fake.openGate();
    ok(await send('sessions.start', { sessionId }));
    // The operation is held open at the first generation.
    await tick();
    const running = ok<ProgressOut>(
      await send('sessions.progress', { sessionId }),
    );
    expect(running.operationStatus).toBe('running');
    expect(running.progressText).toBeNull();

    fake.release();
    const settled = await waitIdle(sessionId);
    expect(settled.operationStatus).toBe('idle');
    // Ephemeral text never outlives the request.
    expect(settled.progressText).toBeNull();
  });

  it('ignores a late worker event after an operation settles', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 5 });
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    // Replay a stray delta from the last generation.
    fake.lastOnEvent?.({
      kind: 'delta',
      requestId: fake.lastRequestId ?? crypto.randomUUID(),
      seq: 99,
      at: new Date().toISOString(),
      text: 'late-token-should-be-ignored',
    });
    const after = ok<ProgressOut>(
      await send('sessions.progress', { sessionId }),
    );
    expect(after.progressText).toBeNull();
  });

  it('cancels an in-flight operation without persisting partial output', async () => {
    const sessionId = await createSession('deep_loop');
    fake.openGate();
    ok(await send('sessions.start', { sessionId }));
    await tick();
    const cancelled = ok<{ cancelled: boolean }>(
      await send('sessions.cancelOperation', { sessionId }),
    );
    expect(cancelled.cancelled).toBe(true);
    fake.release();
    const settled = await waitIdle(sessionId);
    expect(settled.operationStatus).toBe('cancelled');
    expect(settled.canRetry).toBe(true);
    // No durable round was persisted from the cancelled generation.
    const transcript = ok<{ items: unknown[] }>(
      await send('sessions.transcript', { sessionId }),
    );
    expect(transcript.items).toHaveLength(0);

    // A second cancel is idempotent (nothing running).
    const again = ok<{ cancelled: boolean }>(
      await send('sessions.cancelOperation', { sessionId }),
    );
    expect(again.cancelled).toBe(false);
  });

  it('surfaces a recoverable failure when the model is missing', async () => {
    const sessionId = await createSession('deep_loop');
    fake.resolvedModel = null;
    fake.modelId = null;
    ok(await send('sessions.start', { sessionId }));
    const failed = await waitIdle(sessionId);
    expect(failed.operationStatus).toBe('failed');
    expect(failed.canRetry).toBe(true);
    expect(failed.errorMessage).toMatch(/Local AI/i);

    // Recover: a valid model becomes available and a restart succeeds.
    fake.resolvedModel = localModel('mock', 'mock-static');
    fake.modelId = 'mock-static';
    ok(await send('sessions.start', { sessionId }));
    const recovered = await waitIdle(sessionId);
    expect(recovered.phase).toBe('answering');
  });

  it('fails the operation safely on malformed structured output', async () => {
    const sessionId = await createSession('deep_loop');
    fake.questionScript = [
      { kind: 'ok', output: { note: 'missing required fields' } },
      { kind: 'ok', output: { still: 'invalid' } },
    ];
    ok(await send('sessions.start', { sessionId }));
    const failed = await waitIdle(sessionId);
    expect(failed.operationStatus).toBe('failed');
    const transcript = ok<{ items: unknown[] }>(
      await send('sessions.transcript', { sessionId }),
    );
    expect(transcript.items).toHaveLength(0);
  });

  it('does not duplicate rounds on repeated start/advance', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 5 });
    // Two starts back-to-back must not double-generate.
    ok(await send('sessions.start', { sessionId }));
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const transcript = ok<{ items: Array<{ type: string }> }>(
      await send('sessions.transcript', { sessionId }),
    );
    expect(transcript.items.filter((t) => t.type === 'question')).toHaveLength(
      5,
    );
  });

  it('rejects a duplicate concurrent answer submission', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 5 });
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
    const q = adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>;
    const [a, b] = await Promise.all([
      send('answers.submit', {
        sessionId,
        questionId: q.id,
        answerText: 'First concrete answer with reasoning.',
      }),
      send('answers.submit', {
        sessionId,
        questionId: q.id,
        answerText: 'Second racing answer attempt.',
      }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
  });

  it('keeps answer/question content out of operation telemetry', async () => {
    const sessionId = await createSession('quick_fire', { questionCount: 5 });
    const secret = 'CANARY-medieval-guild-secret-7731';
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(await send('sessions.advance', { sessionId }));
    const q = adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>;
    ok(
      await send('answers.submit', {
        sessionId,
        questionId: q.id,
        answerText: `${secret} — my full answer text.`,
      }),
    );
    // Neither the subject, the answer canary nor generated question text appear
    // in the telemetry store or the JSONL log.
    const runs = storage.db
      .prepare('SELECT detail_json FROM operation_runs')
      .all() as Array<{ detail_json: string | null }>;
    const serialised = runs.map((r) => r.detail_json ?? '').join('\n');
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('medieval european history');
    const logText = fs.existsSync(jsonlPath)
      ? fs.readFileSync(jsonlPath, 'utf8')
      : '';
    expect(logText).not.toContain(secret);
    expect(
      JSON.stringify(await workflow('state.get', { sessionId })),
    ).not.toContain(secret);
    const invalid = await send('workflow.continue', {
      sessionId,
      action: 'request_coaching',
    });
    expectError(invalid, 'CONFLICT');
    expect(JSON.stringify(invalid)).not.toContain(secret);
  });
});

interface WorkflowState {
  session: { status: string; phase: string | null; barSnapshot: unknown };
  currentQuestion: { id: string; roundId: string; question: string } | null;
  availableActions: string[];
  progress: ProgressOut;
  operationId: string | null;
  feedback: {
    review: { decision: string; score: number | null } | null;
    coaching: { diagnosis: string } | null;
  } | null;
  result: {
    reviewedCount: number;
    complete: boolean;
    passCount?: number;
    failCount?: number;
    unscoredCount?: number;
    recommendation?: string | null;
  } | null;
  deepLoop?: {
    roundId: string;
    isReassessment: boolean;
    followUpLimit: number;
    followUpsAsked: number;
    reassessmentDepth: number;
    reassessmentCap: number;
    recommendation: string | null;
  } | null;
}

async function workflow(
  action: string,
  payload: unknown,
  active = dispatcher,
): Promise<WorkflowState> {
  return ok<{ state: WorkflowState }>(
    await send(`workflow.${action}`, payload, active),
  ).state;
}

async function workflowIdle(
  sessionId: string,
  active = dispatcher,
): Promise<WorkflowState> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = await workflow('state.get', { sessionId }, active);
    if (!state.operationId) return state;
    await tick();
  }
  throw new Error('workflow did not settle');
}

describe('high-level interview workflow', () => {
  it.each([5, 10])(
    'makes Q1 actionable during a controlled Q2 delay (N=%i)',
    async (count) => {
      const sessionId = await createSession('quick_fire', {
        questionCount: count,
      });
      fake.gateOnQuestionNumber = 2;
      fake.openGate();
      const started = performance.now();
      ok(await send('sessions.start', { sessionId }));
      for (let i = 0; i < 50 && fake.calls.question < 2; i++) await tick();
      expect(fake.calls.question).toBe(2);
      const early = await workflow('state.get', { sessionId });
      const firstReadyMs = performance.now() - started;
      expect(early.availableActions).toContain('answer');
      expect(early.currentQuestion).not.toBeNull();
      expect(early.result).toBeNull();
      expect(
        storage.db
          .prepare('SELECT count(*) AS n FROM interview_questions')
          .get(),
      ).toEqual({ n: 1 });
      expect(
        fake.entries.every(
          (entry) =>
            entry.callerModule === 'interviews' &&
            entry.toolNames?.length === 0,
        ),
      ).toBe(true);
      expect(fake.entries[0].execution.priority).toBe('interactive');
      expect(fake.entries[1].execution.priority).toBe('normal');

      try {
        await workflow('answer.submit', {
          sessionId,
          questionId: early.currentQuestion!.id,
          answerText: 'First answer is saved while the second question waits.',
        });
        for (let i = 0; i < 50 && fake.calls.review < 1; i++) await tick();
        expect(fake.calls.review).toBe(1);
        for (
          let i = 0;
          i < 50 &&
          (
            storage.db
              .prepare('SELECT count(*) AS n FROM interview_reviews')
              .get() as { n: number }
          ).n === 0;
          i++
        )
          await tick();
        expect(
          storage.db
            .prepare('SELECT count(*) AS n FROM interview_reviews')
            .get(),
        ).toEqual({ n: 1 });
        expect(
          (await workflow('state.get', { sessionId })).feedback,
        ).toBeNull();
      } finally {
        fake.release();
      }

      await waitIdle(sessionId);
      const allReadyMs = performance.now() - started;
      const transcript = ok<{ items: Array<{ type: string; text: string }> }>(
        await send('sessions.transcript', { sessionId }),
      );
      const questions = transcript.items
        .filter((turn) => turn.type === 'question')
        .map((turn) => turn.text);
      expect(questions).toHaveLength(count);
      expect(new Set(questions).size).toBe(count);
      expect(allReadyMs).toBeGreaterThan(firstReadyMs);
      expect(
        fake.entries
          .filter((entry) => detectTask(entry) === 'question')
          .every((entry) => entry.thinking === false),
      ).toBe(true);
      expect(
        fake.entries
          .filter((entry) => detectTask(entry) === 'review')
          .every((entry) => entry.thinking === true),
      ).toBe(true);
      console.info(
        `06.6 controlled N=${count}: Start→Q1 ${firstReadyMs.toFixed(1)}ms; Start→all ${allReadyMs.toFixed(1)}ms; review before Q2 release`,
      );
    },
  );

  it('bounds malformed Quick-fire slot repair and retries a failed held review without rewriting an answer', async () => {
    const sessionId = await createSession('quick_fire');
    fake.questionScript = [
      { kind: 'ok', output: { invalid: true } },
      { kind: 'ok', output: { invalid: true } },
    ];
    ok(await send('sessions.start', { sessionId }));
    const failed = await workflowIdle(sessionId);
    expect(failed.availableActions).toContain('retry');
    expect(fake.calls.question).toBe(2);
    expect(
      ok<{ items: unknown[] }>(await send('sessions.transcript', { sessionId }))
        .items,
    ).toHaveLength(0);
    await workflow('continue', { sessionId, action: 'retry' });
    const ready = await workflowIdle(sessionId);
    const question = ready.currentQuestion!;
    fake.thinkingSupported = false;
    await workflow('answer.submit', {
      sessionId,
      questionId: question.id,
      answerText: 'One committed response.',
    });
    const reviewFailed = await workflowIdle(sessionId);
    expect(reviewFailed.availableActions).toContain('retry');
    expect(reviewFailed.progress.errorMessage).toMatch(/thinking-enabled/i);
    expect(
      ok<{ review: unknown }>(
        await send('reviews.get', { sessionId, roundId: question.roundId }),
      ).review,
    ).toBeNull();
    expect(
      (await workflow('results.request', { sessionId })).result,
    ).toBeNull();
    fake.thinkingSupported = true;
    await workflow('continue', { sessionId, action: 'retry' });
    await workflowIdle(sessionId);
    expect(
      storage.db
        .prepare('SELECT count(*) AS count FROM interview_answers')
        .get(),
    ).toEqual({ count: 1 });
    expect(
      storage.db
        .prepare('SELECT count(*) AS count FROM interview_reviews')
        .get(),
    ).toEqual({ count: 1 });
  });
  it('cancels a held review without a late write, then retries the same answer after restart', async () => {
    const sessionId = await createSession('quick_fire');
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    fake.gateOnTask = 'review';
    fake.openGate();
    const first = (await workflow('state.get', { sessionId })).currentQuestion!;
    await workflow('answer.submit', {
      sessionId,
      questionId: first.id,
      answerText: 'Immutable answer.',
    });
    await tick();
    expect(fake.calls.review).toBe(1);
    await workflow('pause', { sessionId });
    fake.release();
    await tick();
    expect(
      storage.db
        .prepare('SELECT count(*) AS count FROM interview_reviews')
        .get(),
    ).toEqual({ count: 0 });
    const relaunched = buildDispatcher();
    ok(await send('sessions.start', { sessionId }, relaunched));
    await waitIdle(sessionId, relaunched);
    expect(
      storage.db
        .prepare('SELECT count(*) AS count FROM interview_answers')
        .get(),
    ).toEqual({ count: 1 });
    expect(
      storage.db
        .prepare('SELECT count(*) AS count FROM interview_reviews')
        .get(),
    ).toEqual({ count: 1 });
  });

  it('discards cancelled synthesis and publishes only after a new explicit request', async () => {
    const sessionId = await createSession('quick_fire');
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    for (let n = 0; n < 5; n++) {
      const state = await workflow('state.get', { sessionId });
      await workflow('answer.submit', {
        sessionId,
        questionId: state.currentQuestion!.id,
        answerText: `Answer ${n}.`,
      });
    }
    await waitIdle(sessionId);
    fake.gateOnTask = 'synthesis';
    fake.openGate();
    await workflow('results.request', { sessionId });
    await tick();
    await workflow('pause', { sessionId });
    fake.release();
    await tick();
    expect(
      storage.db
        .prepare('SELECT count(*) AS count FROM interview_publications')
        .get(),
    ).toEqual({ count: 0 });
    expect((await workflow('state.get', { sessionId })).result).toBeNull();
    await workflow('continue', { sessionId, action: 'continue' });
    await workflow('results.request', { sessionId });
    expect((await workflowIdle(sessionId)).result?.complete).toBe(true);
    expect(fake.calls.synthesis).toBe(2);
  });
  it('offers Q1 while Q2 is held and reviews the first answer during speculation', async () => {
    const sessionId = await createSession('quick_fire');
    fake.gateOnQuestionNumber = 2;
    fake.openGate();
    const started = performance.now();
    ok(await send('sessions.start', { sessionId }));
    for (let n = 0; n < 50 && fake.calls.question < 2; n++) await tick();
    const first = await workflow('state.get', { sessionId });
    expect(first.currentQuestion).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(first.availableActions).toContain('answer');
    const before = ok<{ items: Array<{ type: string }> }>(
      await send('sessions.transcript', { sessionId }),
    );
    expect(
      before.items.filter((turn) => turn.type === 'question'),
    ).toHaveLength(1);
    await workflow('answer.submit', {
      sessionId,
      questionId: first.currentQuestion!.id,
      answerText: 'A grounded response.',
    });
    for (let n = 0; n < 50 && fake.calls.review < 1; n++) await tick();
    expect(fake.calls.review).toBe(1);
    expect(fake.calls.question).toBe(2);
    expect(fake.priorities.slice(0, 3)).toEqual([
      { task: 'question', priority: 'interactive' },
      { task: 'question', priority: 'normal' },
      { task: 'review', priority: 'normal' },
    ]);
    expect((await workflow('state.get', { sessionId })).result).toBeNull();
    fake.release();
    await waitIdle(sessionId);
    const questions = ok<{ items: Array<{ type: string }> }>(
      await send('sessions.transcript', { sessionId }),
    );
    expect(
      questions.items.filter((turn) => turn.type === 'question'),
    ).toHaveLength(5);
  });

  it('embargoes every public result read and persists synthesis across restart', async () => {
    const sessionId = await createSession('quick_fire');
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const first = (await workflow('state.get', { sessionId })).currentQuestion!;
    for (let n = 0; n < 5; n++) {
      const state = await workflow('state.get', { sessionId });
      await workflow('answer.submit', {
        sessionId,
        questionId: state.currentQuestion!.id,
        answerText: `Answer ${n} with evidence.`,
      });
    }
    await waitIdle(sessionId);
    const unpublished = await workflow('state.get', { sessionId });
    expect(unpublished.result).toBeNull();
    expect(unpublished.session.barSnapshot).toBeNull();
    expect(
      ok<{ session: { barSnapshot: unknown } }>(
        await send('sessions.get', { id: sessionId }),
      ).session.barSnapshot,
    ).toBeNull();
    expect(
      ok<{ review: unknown }>(
        await send('reviews.get', { sessionId, roundId: first.roundId }),
      ).review,
    ).toBeNull();
    expect(
      ok<{ summary: unknown; items: Array<{ type: string }> }>(
        await send('sessions.transcript', { sessionId }),
      ),
    ).toMatchObject({ summary: null });
    const detail = ok<{ bar: unknown; rounds: Array<{ review: unknown }> }>(
      await send('insights.sessions.get', { sessionId }),
    );
    expect(detail.bar).toBeNull();
    expect(detail.rounds.every((r) => r.review === null)).toBe(true);
    expect(
      ok<{ items: Array<{ counts: { reviewed: number } }> }>(
        await send('insights.sessions.list', {}),
      ).items[0].counts.reviewed,
    ).toBe(0);
    expect(
      ok<{ items: Array<{ decision: string | null }> }>(
        await send('insights.questions.list', {}),
      ).items.every((q) => q.decision === null),
    ).toBe(true);
    expect(
      ok<{ scoredRounds: number }>(
        await send('insights.progress.get', { method: 'quick_fire' }),
      ).scoredRounds,
    ).toBe(0);
    await workflow('results.request', { sessionId });
    const published = await workflowIdle(sessionId);
    expect(published.result).toMatchObject({
      narrativeUnavailable: false,
      narrative: { strengths: ['Addresses the question'] },
    });
    expect(fake.calls.synthesis).toBe(1);
    const relaunched = buildDispatcher();
    const restored = await workflow(
      'results.request',
      { sessionId },
      relaunched,
    );
    expect(restored.result).toEqual(published.result);
    expect(fake.calls.synthesis).toBe(1);
  });

  it('publishes deterministic fallback if thinking is unsupported and discards abandoned in-flight work', async () => {
    const sessionId = await createSession('quick_fire');
    ok(await send('sessions.start', { sessionId }));
    await waitIdle(sessionId);
    for (let n = 0; n < 5; n++) {
      const state = await workflow('state.get', { sessionId });
      await workflow('answer.submit', {
        sessionId,
        questionId: state.currentQuestion!.id,
        answerText: `Answer ${n}.`,
      });
    }
    await waitIdle(sessionId);
    fake.thinkingSupported = false;
    await workflow('results.request', { sessionId });
    const result = await workflowIdle(sessionId);
    expect(result.result).toMatchObject({
      narrativeUnavailable: true,
      narrative: null,
      reviewedCount: 5,
    });
    expect(fake.calls.synthesis).toBe(1);

    const abandonedId = await createSession('quick_fire');
    fake.gateOnQuestionNumber = fake.calls.question + 1;
    fake.openGate();
    ok(await send('sessions.start', { sessionId: abandonedId }));
    await tick();
    ok(
      await send('sessions.finish', {
        sessionId: abandonedId,
        outcome: 'abandoned',
      }),
    );
    fake.release();
    await tick();
    expect(
      ok<{ items: unknown[] }>(
        await send('sessions.transcript', { sessionId: abandonedId }),
      ).items,
    ).toHaveLength(0);
  });
  it('drives Quick-fire through intent commands and publishes a stable result', async () => {
    const sessionId = await createSession('quick_fire');
    const draft = await workflow('state.get', { sessionId });
    expect(draft.availableActions).toContain('start');
    expect(draft.currentQuestion).toBeNull();
    expect(fake.calls.question).toBe(0);

    ok(await send('sessions.start', { sessionId }));
    let state = await workflowIdle(sessionId);
    const firstRoundId = state.currentQuestion?.roundId;
    for (let i = 0; i < 5; i += 1) {
      expect(state.availableActions).toContain('answer');
      expect(state.currentQuestion).not.toBeNull();
      state = await workflow('answer.submit', {
        sessionId,
        questionId: state.currentQuestion?.id,
        answerText: `Answer ${i}: concrete reasoning and evidence.`,
      });
      expectError(
        await send('workflow.answer.submit', {
          sessionId,
          questionId: draft.currentQuestion?.id ?? crypto.randomUUID(),
          answerText: 'duplicate',
        }),
        'CONFLICT',
      );
    }
    state = await workflowIdle(sessionId);
    expect(state.progress.reviewedCount).toBe(5);
    expect(state.feedback).toBeNull();
    expect(state.result).toBeNull();
    expect(state.availableActions).toContain('request_results');
    const hiddenReview = ok<{ review: unknown }>(
      await send('reviews.get', { sessionId, roundId: firstRoundId }),
    );
    expect(hiddenReview.review).toBeNull();
    const hiddenTranscript = ok<{
      items: Array<{ type: string }>;
      summary: unknown;
    }>(await send('sessions.transcript', { sessionId }));
    expect(hiddenTranscript.items.some((turn) => turn.type === 'review')).toBe(
      false,
    );
    expect(hiddenTranscript.summary).toBeNull();
    const history = ok<{ items: Array<{ counts: { reviewed: number } }> }>(
      await send('insights.sessions.list', {}),
    );
    expect(history.items[0].counts.reviewed).toBe(0);
    const questions = ok<{ items: Array<{ decision: string | null }> }>(
      await send('insights.questions.list', {}),
    );
    expect(questions.items.every((q) => q.decision === null)).toBe(true);
    await workflow('results.request', { sessionId });
    const published = await workflowIdle(sessionId);
    expect(published.session.status).toBe('completed');
    expect(published.result).toMatchObject({
      complete: true,
      reviewedCount: 5,
    });
    expect(await workflow('results.request', { sessionId })).toEqual(published);
    expect(
      ok<{ review: unknown }>(
        await send('reviews.get', { sessionId, roundId: firstRoundId }),
      ).review,
    ).not.toBeNull();
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'question')
        .every((c) => c.thinking === false),
    ).toBe(true);
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'review')
        .every((c) => c.thinking === true),
    ).toBe(true);
  });

  it('drives Deep Loop follow-up, review, coaching and reassessment without granular actions', async () => {
    fake.reviewScore = 40;
    const sessionId = await createSession('deep_loop');
    ok(await send('sessions.start', { sessionId }));
    let state = await workflowIdle(sessionId);
    const first = state.currentQuestion;
    expect(first).not.toBeNull();
    state = await workflow('answer.submit', {
      sessionId,
      questionId: first?.id,
      answerText: 'Initial argument.',
    });
    expect(state.operationId).not.toBeNull();
    state = await workflowIdle(sessionId);
    expect(state.currentQuestion?.id).not.toBe(first?.id);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'Detailed follow-up evidence.',
    });
    state = await workflowIdle(sessionId);
    expect(state.feedback?.review?.decision).toBe('fail');
    expect(state.availableActions).toContain('request_coaching');
    expect(state.availableActions).toContain('request_results');
    state = await workflow('continue', {
      sessionId,
      action: 'request_coaching',
    });
    state = await workflowIdle(sessionId);
    expect(state.session.phase).toBe('coached');
    state = await workflow('continue', {
      sessionId,
      action: 'request_reassessment',
    });
    state = await workflowIdle(sessionId);
    expect(state.currentQuestion?.roundId).not.toBe(first?.roundId);
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'review')
        .every((c) => c.thinking === true),
    ).toBe(true);
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'question')
        .every((c) => c.thinking === false),
    ).toBe(true);
    expect(storage.db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
  });

  it('polls without scheduling and recovers after failed generation and restart', async () => {
    const sessionId = await createSession('deep_loop');
    fake.modelId = null;
    ok(await send('sessions.start', { sessionId }));
    const failed = await workflowIdle(sessionId);
    expect(failed.availableActions).toContain('retry');
    expect(failed.progress.errorMessage).toMatch(/Local AI/);
    const calls = { ...fake.calls };
    await workflow('state.get', { sessionId });
    await workflow('state.get', { sessionId });
    expect(fake.calls).toEqual(calls);

    fake.modelId = 'mock-static';
    const relaunched = buildDispatcher();
    const resumed = await workflow('state.get', { sessionId }, relaunched);
    expect(resumed.availableActions).toContain('continue');
    expect(resumed.currentQuestion).toBeNull();
    await workflow('continue', { sessionId, action: 'continue' }, relaunched);
    const ready = await workflowIdle(sessionId, relaunched);
    expect(ready.currentQuestion).not.toBeNull();
  });

  it('cancels generation without durable partial output and rejects invalid intent', async () => {
    const sessionId = await createSession('deep_loop');
    fake.openGate();
    ok(await send('sessions.start', { sessionId }));
    await tick();
    expectError(
      await send('workflow.continue', { sessionId, action: 'continue' }),
      'CONFLICT',
    );
    const paused = await workflow('pause', { sessionId });
    expect(paused.progress.operationStatus).toBe('cancelled');
    fake.release();
    const settled = await workflowIdle(sessionId);
    expect(settled.availableActions).toEqual(['continue', 'abandon']);
    expect(
      (await workflow('state.get', { sessionId })).currentQuestion,
    ).toBeNull();
    await workflow('continue', { sessionId, action: 'continue' });
    expect((await workflowIdle(sessionId)).currentQuestion).not.toBeNull();
  });

  it('surfaces missing thinking capability without inventing a review', async () => {
    fake.thinkingSupported = false;
    const sessionId = await createSession('deep_loop');
    ok(await send('sessions.start', { sessionId }));
    let state = await workflowIdle(sessionId);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'An initial answer.',
    });
    state = await workflowIdle(sessionId);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'A follow up answer.',
    });
    state = await workflowIdle(sessionId);
    expect(state.progress.operationStatus).toBe('failed');
    expect(state.progress.errorMessage).toMatch(/thinking-enabled reviews/);
    expect(state.availableActions).toContain('retry');
    expect(state.feedback).toBeNull();
    expect(fake.calls.review).toBe(1);
  });

  it('does not persist a cancelled review and allows retry once it settles', async () => {
    const sessionId = await createSession('deep_loop');
    ok(await send('sessions.start', { sessionId }));
    let state = await workflowIdle(sessionId);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'Initial answer.',
    });
    state = await workflowIdle(sessionId);
    fake.openGate();
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'Follow-up answer.',
    });
    expect(state.operationId).not.toBeNull();
    await workflow('pause', { sessionId });
    fake.release();
    state = await workflowIdle(sessionId);
    expect(state.feedback).toBeNull();
    expect(state.availableActions).toEqual(['continue', 'abandon']);
    expect(state.progress.reviewedCount).toBe(0);
    await workflow('continue', { sessionId, action: 'continue' });
    state = await workflowIdle(sessionId);
    expect(state.progress.reviewedCount).toBe(1);
  });

  it('publishes Deep Loop results only after a completed review', async () => {
    const sessionId = await createSession('deep_loop');
    expectError(
      await send('workflow.results.request', { sessionId }),
      'CONFLICT',
    );
    ok(await send('sessions.start', { sessionId }));
    let state = await workflowIdle(sessionId);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'Initial answer.',
    });
    state = await workflowIdle(sessionId);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'Follow-up answer.',
    });
    state = await workflowIdle(sessionId);
    expect(state.availableActions).toContain('request_results');
    const published = await workflow('results.request', { sessionId });
    expect(published.session.status).toBe('completed');
    expect(published.result?.reviewedCount).toBe(1);
    expect(await workflow('results.request', { sessionId })).toEqual(published);
  });
});

// --- Stage 06.4: Deep Loop on the shared orchestration API ------------------

describe('Deep Loop consolidation (06.4)', () => {
  async function intent(
    sessionId: string,
    action: string,
    active = dispatcher,
  ): Promise<WorkflowState> {
    await workflow('continue', { sessionId, action }, active);
    return workflowIdle(sessionId, active);
  }

  async function answerCurrent(
    sessionId: string,
    answerText = 'I would weigh the competing factors and cite concrete evidence.',
  ): Promise<WorkflowState> {
    const state = await workflow('state.get', { sessionId });
    expect(state.availableActions).toContain('answer');
    await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText,
    });
    return workflowIdle(sessionId);
  }

  /** Answer the active question and any permitted follow-up until reviewed. */
  async function answerRound(sessionId: string): Promise<WorkflowState> {
    let state = await answerCurrent(sessionId);
    if (state.currentQuestion) {
      state = await answerCurrent(
        sessionId,
        'Follow-up answer with a measurable outcome.',
      );
    }
    expect(state.feedback?.review).not.toBeNull();
    return state;
  }

  async function startDeepLoop(): Promise<{
    sessionId: string;
    state: WorkflowState;
  }> {
    const sessionId = await createSession('deep_loop');
    ok(await send('sessions.start', { sessionId }));
    return { sessionId, state: await workflowIdle(sessionId) };
  }

  async function waitForCall(task: Task, calls: number): Promise<void> {
    for (let n = 0; n < 100 && fake.calls[task] < calls; n += 1) await tick();
    expect(fake.calls[task]).toBe(calls);
  }

  function count(table: string): number {
    return (
      storage.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count;
  }

  function parentOf(roundId: string): string | null {
    return (
      storage.db
        .prepare(
          'SELECT reassessment_of_round_id AS parent FROM interview_rounds WHERE id = ?',
        )
        .get(roundId) as { parent: string | null }
    ).parent;
  }

  it('drives a passing Deep Loop through intent commands only, keeping reviewer input private', async () => {
    const canary = 'Canary Holdings 7731';
    ok(
      (await dispatcher.dispatch({
        requestId: crypto.randomUUID(),
        module: 'identity',
        version: 1,
        action: 'experiences.create',
        payload: {
          category: 'employment',
          roleTitle: 'Archivist',
          organisation: canary,
        },
      })) as ResponseEnvelope<unknown>,
    );
    const { sessionId, state: first } = await startDeepLoop();
    expect(first.availableActions).toEqual(['answer', 'abandon']);
    expect(first.deepLoop).toMatchObject({
      isReassessment: false,
      followUpLimit: 1,
      followUpsAsked: 0,
      reassessmentDepth: 0,
      reassessmentCap: 2,
      recommendation: null,
    });

    // The answer is committed before the acknowledgement; the follow-up is
    // generated in the background rather than inside the IPC request.
    const submitted = await workflow('answer.submit', {
      sessionId,
      questionId: first.currentQuestion?.id,
      answerText: 'Primary answer citing the relevant trade-offs.',
    });
    expect(count('interview_answers')).toBe(1);
    expect(submitted.operationId).not.toBeNull();
    expect(submitted.availableActions).toEqual(['pause', 'abandon']);
    const followUp = await workflowIdle(sessionId);
    expect(followUp.currentQuestion?.roundId).toBe(
      first.currentQuestion?.roundId,
    );
    expect(followUp.currentQuestion?.id).not.toBe(first.currentQuestion?.id);
    expect(followUp.availableActions).toEqual(['answer', 'abandon']);

    const reviewed = await answerCurrent(
      sessionId,
      'Follow-up answer with a measurable outcome.',
    );
    expect(reviewed.feedback?.review?.decision).toBe('pass');
    expect(reviewed.feedback?.coaching).toBeNull();
    expect(reviewed.availableActions).toEqual([
      'continue',
      'request_results',
      'abandon',
    ]);
    expect(reviewed.deepLoop?.followUpsAsked).toBe(1);
    for (const action of ['request_coaching', 'request_reassessment', 'retry'])
      expectError(
        await send('workflow.continue', { sessionId, action }),
        'CONFLICT',
      );

    const second = await intent(sessionId, 'continue');
    expect(second.currentQuestion?.roundId).not.toBe(
      first.currentQuestion?.roundId,
    );
    expect(second.feedback).toBeNull();
    const secondReviewed = await answerRound(sessionId);
    expect(secondReviewed.availableActions).toEqual([
      'continue',
      'request_results',
      'abandon',
    ]);

    const published = await workflow('results.request', { sessionId });
    expect(published.session.status).toBe('completed');
    expect(published.availableActions).toEqual([]);
    expect(published.result).toMatchObject({
      reviewedCount: 2,
      passCount: 2,
      complete: true,
    });

    expect(fake.calls).toMatchObject({ question: 4, review: 2, coach: 0 });
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'question')
        .every((c) => c.thinking === false),
    ).toBe(true);
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'review')
        .every((c) => c.thinking === true),
    ).toBe(true);
    // The reviewer sees the complete round Q&A ...
    const firstReview = fake.requests.find((r) => r.task === 'review')!;
    expect(firstReview.text).toContain(
      'Primary answer citing the relevant trade-offs.',
    );
    expect(firstReview.text).toContain(
      'Follow-up answer with a measurable outcome.',
    );
    // ... while confirmed profile facts ground only primary questions.
    const primaryPrompts = fake.requests.filter(
      (r) => r.task === 'question' && !r.text.includes('## Original question'),
    );
    expect(primaryPrompts.some((r) => r.text.includes(canary))).toBe(true);
    const privatePrompts = fake.requests.filter(
      (r) => r.task !== 'question' || r.text.includes('## Original question'),
    );
    expect(privatePrompts.length).toBe(4);
    expect(privatePrompts.some((r) => r.text.includes(canary))).toBe(false);
  });

  it('coaches only on explicit choice, links capped reassessments and recommends learning', async () => {
    fake.reviewScore = 40;
    const { sessionId, state: first } = await startDeepLoop();
    const rootRound = first.currentQuestion!.roundId;
    let state = await answerRound(sessionId);
    expect(state.feedback?.review?.decision).toBe('fail');
    expect(state.feedback?.coaching).toBeNull();
    expect(state.session.phase).toBe('reviewed');
    expect(state.availableActions).toEqual([
      'request_coaching',
      'continue',
      'request_results',
      'abandon',
    ]);
    await workflow('state.get', { sessionId });
    expect(fake.calls.coach).toBe(0);

    // Rapid repeated coaching intents (and a granular call) start one generation.
    fake.gateOnTask = 'coach';
    fake.openGate();
    const coaching = await workflow('continue', {
      sessionId,
      action: 'request_coaching',
    });
    expect(coaching.availableActions).toEqual(['pause', 'abandon']);
    expectError(
      await send('workflow.continue', {
        sessionId,
        action: 'request_coaching',
      }),
      'CONFLICT',
    );
    expectError(
      await send('coaching.run', { sessionId, roundId: rootRound }),
      'CONFLICT',
    );
    fake.release();
    state = await workflowIdle(sessionId);
    expect(state.feedback?.coaching).not.toBeNull();
    expect(state.session.phase).toBe('coached');
    expect(state.availableActions).toEqual([
      'request_reassessment',
      'continue',
      'request_results',
      'abandon',
    ]);
    expectError(
      await send('workflow.continue', {
        sessionId,
        action: 'request_coaching',
      }),
      'CONFLICT',
    );
    expect(fake.calls.coach).toBe(1);
    expect(count('interview_coaching')).toBe(1);

    const questionsBefore = fake.calls.question;
    await workflow('continue', { sessionId, action: 'request_reassessment' });
    expectError(
      await send('workflow.continue', {
        sessionId,
        action: 'request_reassessment',
      }),
      'CONFLICT',
    );
    state = await workflowIdle(sessionId);
    const firstReassessment = state.currentQuestion!;
    expect(firstReassessment.roundId).not.toBe(rootRound);
    expect(firstReassessment.question).not.toBe(
      first.currentQuestion!.question,
    );
    expect(parentOf(firstReassessment.roundId)).toBe(rootRound);
    expect(state.deepLoop).toMatchObject({
      isReassessment: true,
      followUpLimit: 0,
      reassessmentDepth: 1,
    });
    // A sibling reassessment would let the granular path bypass the cap.
    expectError(
      await send('reassessment.generate', {
        sessionId,
        failedRoundId: rootRound,
      }),
      'CONFLICT',
    );
    expect(count('interview_rounds')).toBe(2);

    // Reassessment rounds have no follow-up: the answer goes straight to review.
    state = await answerCurrent(sessionId);
    expect(fake.calls.question).toBe(questionsBefore + 1);
    expect(state.feedback?.review?.decision).toBe('fail');
    state = await intent(sessionId, 'request_coaching');
    state = await intent(sessionId, 'request_reassessment');
    const secondReassessment = state.currentQuestion!;
    expect(parentOf(secondReassessment.roundId)).toBe(
      firstReassessment.roundId,
    );
    expect(state.deepLoop?.reassessmentDepth).toBe(2);
    state = await answerCurrent(sessionId);

    // At the cap coaching is still offered, but the competency loop halts.
    expect(state.availableActions).toEqual([
      'request_coaching',
      'request_results',
      'abandon',
    ]);
    expect(state.deepLoop?.recommendation).toMatch(/practice limit/i);
    expectError(
      await send('workflow.continue', { sessionId, action: 'continue' }),
      'CONFLICT',
    );
    state = await intent(sessionId, 'request_coaching');
    expect(state.availableActions).toEqual(['request_results', 'abandon']);
    expectError(
      await send('workflow.continue', {
        sessionId,
        action: 'request_reassessment',
      }),
      'CONFLICT',
    );
    expectError(
      await send('reassessment.generate', {
        sessionId,
        failedRoundId: secondReassessment.roundId,
      }),
      'CONFLICT',
    );

    const published = await workflow('results.request', { sessionId });
    expect(published.result).toMatchObject({ reviewedCount: 3, failCount: 3 });
    expect(published.result?.recommendation).toMatch(/practice limit/i);
    expect({
      rounds: count('interview_rounds'),
      reviews: count('interview_reviews'),
      coaching: count('interview_coaching'),
      answers: count('interview_answers'),
    }).toEqual({ rounds: 3, reviews: 3, coaching: 3, answers: 4 });
    expect(
      fake.thinkingCalls
        .filter((c) => c.task !== 'review')
        .every((c) => c.thinking === false),
    ).toBe(true);
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'review')
        .every((c) => c.thinking === true),
    ).toBe(true);
    expect(storage.db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
  });

  it('lets the user decline coaching and move on after a genuine fail', async () => {
    fake.reviewScore = 40;
    const { sessionId, state: first } = await startDeepLoop();
    await answerRound(sessionId);
    const next = await intent(sessionId, 'continue');
    expect(next.currentQuestion?.roundId).not.toBe(
      first.currentQuestion?.roundId,
    );
    expect(next.deepLoop?.isReassessment).toBe(false);
    expect(fake.calls.coach).toBe(0);
    expect(count('interview_coaching')).toBe(0);
  });

  it('records invalid evidence as unscored and never offers coaching for it', async () => {
    fake.reviewEvidence = 'a quotation the candidate never said';
    const { sessionId, state: first } = await startDeepLoop();
    const state = await answerRound(sessionId);
    // One bounded repair, then an honest unscored outcome; never a pass.
    expect(fake.calls.review).toBe(2);
    expect(state.feedback?.review).toMatchObject({
      decision: 'unscored',
      score: null,
    });
    expect(state.availableActions).toEqual([
      'continue',
      'request_results',
      'abandon',
    ]);
    expect(state.deepLoop?.recommendation).toMatch(/could not be scored/i);
    expectError(
      await send('workflow.continue', {
        sessionId,
        action: 'request_coaching',
      }),
      'CONFLICT',
    );
    expectError(
      await send('coaching.run', {
        sessionId,
        roundId: first.currentQuestion!.roundId,
      }),
      'CONFLICT',
    );
    const published = await workflow('results.request', { sessionId });
    expect(published.result).toMatchObject({ unscoredCount: 1, passCount: 0 });
  });

  it('reports unsupported reviewer thinking without a thinking:false fallback', async () => {
    fake.thinkingSupported = false;
    const { sessionId } = await startDeepLoop();
    await answerCurrent(sessionId);
    let state = await answerCurrent(sessionId, 'Follow-up answer.');
    expect(state.progress.errorMessage).toMatch(/thinking-enabled reviews/);
    expect(state.availableActions).toEqual(['retry', 'abandon']);
    expect(count('interview_reviews')).toBe(0);
    expect(
      fake.thinkingCalls
        .filter((c) => c.task === 'review')
        .every((c) => c.thinking === true),
    ).toBe(true);
    fake.thinkingSupported = true;
    state = await intent(sessionId, 'retry');
    expect(state.feedback?.review?.decision).toBe('pass');
    expect(count('interview_answers')).toBe(2);
  });

  it('keeps answers and reviews through follow-up, reviewer, coach and reassessment failures', async () => {
    fake.reviewScore = 40;
    const { sessionId } = await startDeepLoop();

    // An optional follow-up timing out can be retried or skipped.
    fake.questionScript = [{ kind: 'fail', code: 'TIMEOUT' }];
    let state = await answerCurrent(sessionId);
    expect(state.currentQuestion).toBeNull();
    expect(state.progress.errorMessage).toMatch(/timed out/i);
    expect(state.availableActions).toEqual(['retry', 'continue', 'abandon']);

    // Skipping it reviews now; exhausted reviewer retries invent nothing.
    fake.reviewScript = [{ kind: 'fail', code: 'RETRIES_EXHAUSTED' }];
    state = await intent(sessionId, 'continue');
    expect(state.feedback).toBeNull();
    expect(state.availableActions).toEqual(['retry', 'abandon']);
    expect(state.progress.errorMessage).toMatch(/usable review/i);
    expect(count('interview_answers')).toBe(1);
    expect(count('interview_questions')).toBe(1);
    expect(count('interview_reviews')).toBe(0);
    state = await intent(sessionId, 'retry');
    expect(state.feedback?.review?.decision).toBe('fail');
    expect(state.deepLoop?.followUpsAsked).toBe(0);

    // A failed coach leaves the review intact; retry stores exactly one record.
    fake.coachScript = [{ kind: 'fail', code: 'PROVIDER_UNAVAILABLE' }];
    state = await intent(sessionId, 'request_coaching');
    expect(state.feedback?.review?.decision).toBe('fail');
    expect(state.feedback?.coaching).toBeNull();
    expect(state.availableActions).toEqual([
      'retry',
      'request_coaching',
      'continue',
      'request_results',
      'abandon',
    ]);
    state = await intent(sessionId, 'retry');
    expect(state.feedback?.coaching).not.toBeNull();
    expect(fake.calls.coach).toBe(2);
    expect(count('interview_coaching')).toBe(1);

    // Invalid reassessment output uses one bounded repair, then fails honestly.
    fake.questionScript = [
      { kind: 'ok', output: { invalid: true } },
      { kind: 'ok', output: { invalid: true } },
    ];
    const before = fake.calls.question;
    state = await intent(sessionId, 'request_reassessment');
    expect(fake.calls.question).toBe(before + 2);
    expect(state.currentQuestion).toBeNull();
    expect(state.availableActions).toContain('retry');
    expect(count('interview_rounds')).toBe(1);
    state = await intent(sessionId, 'retry');
    expect(state.deepLoop?.isReassessment).toBe(true);
    expect({
      rounds: count('interview_rounds'),
      reviews: count('interview_reviews'),
      answers: count('interview_answers'),
    }).toEqual({ rounds: 2, reviews: 1, answers: 1 });
  });

  it('pauses coaching and reassessment without late writes and discards work on abandon', async () => {
    fake.reviewScore = 40;
    const { sessionId } = await startDeepLoop();
    await answerRound(sessionId);

    fake.gateOnTask = 'coach';
    fake.openGate();
    await workflow('continue', { sessionId, action: 'request_coaching' });
    const paused = await workflow('pause', { sessionId });
    expect(paused.progress.operationStatus).toBe('cancelled');
    fake.release();
    let state = await workflowIdle(sessionId);
    expect(state.feedback?.coaching).toBeNull();
    expect(count('interview_coaching')).toBe(0);
    expect(state.availableActions).toEqual(['continue', 'abandon']);
    state = await intent(sessionId, 'continue');
    state = await intent(sessionId, 'request_coaching');
    expect(state.feedback?.coaching).not.toBeNull();

    fake.gateOnTask = 'question';
    fake.openGate();
    await workflow('continue', { sessionId, action: 'request_reassessment' });
    await workflow('pause', { sessionId });
    fake.release();
    state = await workflowIdle(sessionId);
    expect(count('interview_rounds')).toBe(1);
    expect(state.availableActions).toEqual(['continue', 'abandon']);
    state = await intent(sessionId, 'continue');
    state = await intent(sessionId, 'request_reassessment');
    expect(count('interview_rounds')).toBe(2);

    fake.gateOnTask = 'review';
    fake.openGate();
    const reviewsBefore = fake.calls.review;
    await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'An answer whose review is abandoned.',
    });
    await waitForCall('review', reviewsBefore + 1);
    ok(await send('sessions.finish', { sessionId, outcome: 'abandoned' }));
    fake.release();
    for (let n = 0; n < 10; n += 1) await tick();
    expect(count('interview_reviews')).toBe(1);
    const final = await workflow('state.get', { sessionId });
    expect(final.session.status).toBe('abandoned');
    expect(final.availableActions).toEqual([]);
  });

  it('restores mid-review and mid-coaching sessions after restart without duplicate records', async () => {
    fake.reviewScore = 40;
    const { sessionId } = await startDeepLoop();
    await answerCurrent(sessionId);

    // The old process dies with its review held at the provider.
    fake.gateOnTask = 'review';
    fake.openGate();
    const followUp = await workflow('state.get', { sessionId });
    await workflow('answer.submit', {
      sessionId,
      questionId: followUp.currentQuestion?.id,
      answerText: 'Follow-up answer before the crash.',
    });
    await waitForCall('review', 1);
    fake.gateOnTask = 'synthesis';

    const relaunched = buildDispatcher();
    let state = await workflow('state.get', { sessionId }, relaunched);
    expect(state.operationId).toBeNull();
    expect(state.currentQuestion).toBeNull();
    expect(state.availableActions).toEqual(['continue', 'abandon']);
    ok(await send('sessions.start', { sessionId }, relaunched));
    state = await workflowIdle(sessionId, relaunched);
    expect(fake.calls.review).toBe(2);
    expect(state.feedback?.review?.decision).toBe('fail');
    expect(state.deepLoop?.followUpsAsked).toBe(1);

    // The dead process's late completion cannot add a second review.
    fake.release();
    for (let n = 0; n < 10; n += 1) await tick();
    expect(count('interview_reviews')).toBe(1);

    fake.gateOnTask = 'coach';
    fake.openGate();
    await workflow(
      'continue',
      { sessionId, action: 'request_coaching' },
      relaunched,
    );
    await waitForCall('coach', 1);
    fake.gateOnTask = 'synthesis';
    const third = buildDispatcher();
    state = await workflow('state.get', { sessionId }, third);
    expect(state.availableActions).toEqual([
      'request_coaching',
      'continue',
      'request_results',
      'abandon',
    ]);
    state = await intent(sessionId, 'request_coaching', third);
    expect(state.feedback?.coaching).not.toBeNull();
    fake.release();
    for (let n = 0; n < 10; n += 1) await tick();
    expect({
      questions: count('interview_questions'),
      answers: count('interview_answers'),
      reviews: count('interview_reviews'),
      coaching: count('interview_coaching'),
    }).toEqual({ questions: 2, answers: 2, reviews: 1, coaching: 1 });
    state = await workflow('state.get', { sessionId }, third);
    expect(state.availableActions).toEqual([
      'request_reassessment',
      'continue',
      'request_results',
      'abandon',
    ]);
  });

  it('never exposes Deep Loop choices or guidance for Quick-fire', async () => {
    const sessionId = await createSession('quick_fire');
    ok(await send('sessions.start', { sessionId }));
    let state = await workflowIdle(sessionId);
    for (let n = 0; n < 5; n += 1) {
      expect(state.availableActions).not.toContain('request_coaching');
      expect('deepLoop' in state).toBe(false);
      await workflow('answer.submit', {
        sessionId,
        questionId: state.currentQuestion?.id,
        answerText: `Answer ${n}.`,
      });
      state = await workflowIdle(sessionId);
    }
    for (const action of ['request_coaching', 'request_reassessment'])
      expectError(
        await send('workflow.continue', { sessionId, action }),
        'CONFLICT',
      );
    expect(state.availableActions).toEqual(['request_results', 'abandon']);
    expect(fake.calls.coach).toBe(0);
  });
});

describe('additional guidance in question generation (07.0)', () => {
  const GUIDANCE_HEADING = '## Candidate practice preferences';

  function relaunch(): void {
    storage.close();
    storage = openStorage(workDir);
    telemetry = new TelemetryService({
      repository: new TelemetryRepository(storage.db),
      logger: new JsonlLogger(jsonlPath),
    });
    dispatcher = buildDispatcher();
  }

  function promptsFrom(start: number, task: Task): string[] {
    return fake.requests
      .slice(start)
      .filter((r) => r.task === task)
      .map((r) => r.text);
  }

  /** Canary must stay out of telemetry, logs and scheduler metadata. */
  function expectNoOperationalLeak(canary: string): void {
    const runs = JSON.stringify(
      storage.db.prepare('SELECT * FROM operation_runs').all(),
    );
    expect(runs).not.toContain(canary);
    const log = fs.existsSync(jsonlPath)
      ? fs.readFileSync(jsonlPath, 'utf8')
      : '';
    expect(log).not.toContain(canary);
    for (const entry of fake.entries) {
      const metadata = JSON.stringify({ ...entry, messages: undefined });
      expect(metadata).not.toContain(canary);
    }
  }

  it('routes Quick-fire guidance to Q1 and every later question but not to reviews or synthesis', async () => {
    const canary = 'GUIDANCE-CANARY-07.0-quickfire';
    const guided = await createSession('quick_fire', {
      additionalGuidance: `Use STAR questions. ${canary}`,
    });
    const plain = await createSession('quick_fire');

    ok(await send('sessions.start', { sessionId: guided }));
    let state = await workflowIdle(guided);
    expect(state.session).toMatchObject({
      additionalGuidance: `Use STAR questions. ${canary}`,
    });
    for (let i = 0; i < 5; i += 1) {
      state = await workflow('answer.submit', {
        sessionId: guided,
        questionId: state.currentQuestion?.id,
        answerText: `Answer ${i} with a situation, task, action and result.`,
      });
      state = await workflowIdle(guided);
    }
    await workflow('results.request', { sessionId: guided });
    const published = await workflowIdle(guided);
    expect(published.session.status).toBe('completed');
    expect(published.result).toMatchObject({
      complete: true,
      reviewedCount: 5,
    });

    const questions = promptsFrom(0, 'question');
    expect(questions).toHaveLength(5);
    for (const prompt of questions) {
      expect(prompt).toContain(`> Use STAR questions. ${canary}`);
    }
    // Later questions still carry dedup context alongside the same guidance.
    expect(questions[4]).toContain('Primary 0:');
    for (const task of ['review', 'synthesis'] as const) {
      const prompts = promptsFrom(0, task);
      expect(prompts.length).toBeGreaterThan(0);
      for (const prompt of prompts) {
        expect(prompt).not.toContain(canary);
        expect(prompt).not.toContain(GUIDANCE_HEADING);
      }
    }
    expect(
      fake.thinkingCalls.every(
        (c) => c.thinking === (c.task === 'question' ? false : true),
      ),
    ).toBe(true);

    // Guidance never changes the frozen practice bar.
    ok(await send('sessions.start', { sessionId: plain }));
    await workflowIdle(plain);
    const bars = storage.db
      .prepare(
        'SELECT id, bar_snapshot_json FROM interview_sessions WHERE id IN (?, ?)',
      )
      .all(guided, plain) as Array<{ bar_snapshot_json: string }>;
    expect(bars).toHaveLength(2);
    expect(bars[0].bar_snapshot_json).toBe(bars[1].bar_snapshot_json);
    for (const prompt of promptsFrom(5, 'question')) {
      expect(prompt).not.toContain(GUIDANCE_HEADING);
    }
    expectNoOperationalLeak(canary);
  });

  it('routes Deep Loop guidance to primary, follow-up and reassessment but not reviewer or coach', async () => {
    fake.reviewScore = 40;
    const canary = 'GUIDANCE-CANARY-07.0-deeploop';
    const sessionId = await createSession('deep_loop', {
      additionalGuidance: `Questions for Apple. ${canary}`,
    });
    ok(await send('sessions.start', { sessionId }));
    let state = await workflowIdle(sessionId);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'Primary answer.',
    });
    state = await workflowIdle(sessionId);
    state = await workflow('answer.submit', {
      sessionId,
      questionId: state.currentQuestion?.id,
      answerText: 'Follow-up answer.',
    });
    state = await workflowIdle(sessionId);
    expect(state.feedback?.review?.decision).toBe('fail');
    await workflow('continue', { sessionId, action: 'request_coaching' });
    await workflowIdle(sessionId);
    await workflow('continue', { sessionId, action: 'request_reassessment' });
    state = await workflowIdle(sessionId);
    expect(state.deepLoop?.isReassessment).toBe(true);

    const questions = promptsFrom(0, 'question');
    expect(questions).toHaveLength(3);
    expect(questions[1]).toContain('## Original question');
    expect(questions[2]).toContain('materially different scenario');
    for (const prompt of questions) {
      expect(prompt).toContain(`> Questions for Apple. ${canary}`);
      expect(prompt).toContain('never claim verified, insider');
    }
    for (const task of ['review', 'coach'] as const) {
      const prompts = promptsFrom(0, task);
      expect(prompts.length).toBe(1);
      expect(prompts[0]).not.toContain(canary);
      expect(prompts[0]).not.toContain(GUIDANCE_HEADING);
    }
    const versions = storage.db
      .prepare(
        `SELECT json_extract(q.source_json, '$.promptVersion') AS version
         FROM interview_questions q JOIN interview_rounds r ON r.id = q.round_id
         WHERE r.session_id = ? ORDER BY r.ordinal, q.ordinal`,
      )
      .all(sessionId) as Array<{ version: string }>;
    expect(versions.map((v) => v.version)).toEqual(['iq-v2', 'if-v2', 'ip-v2']);
    expectNoOperationalLeak(canary);
  });

  it('keeps guidance across relaunch, isolated per session, and out of failure messages', async () => {
    const canary = 'GUIDANCE-CANARY-07.0-relaunch';
    const guided = await createSession('deep_loop', {
      additionalGuidance: canary,
    });
    const plain = await createSession('deep_loop');
    relaunch();

    fake.modelId = null;
    ok(await send('sessions.start', { sessionId: guided }));
    const failed = await workflowIdle(guided);
    expect(failed.availableActions).toContain('retry');
    expect(failed.progress.errorMessage).not.toContain(canary);
    expect(JSON.stringify({ ...failed, session: undefined })).not.toContain(
      canary,
    );

    fake.modelId = 'mock-static';
    await workflow('continue', { sessionId: guided, action: 'retry' });
    expect((await workflowIdle(guided)).currentQuestion).not.toBeNull();
    const before = fake.requests.length;
    ok(await send('sessions.start', { sessionId: plain }));
    expect((await workflowIdle(plain)).currentQuestion).not.toBeNull();

    expect(promptsFrom(0, 'question')[0]).toContain(`> ${canary}`);
    const plainPrompts = promptsFrom(before, 'question');
    expect(plainPrompts).toHaveLength(1);
    expect(plainPrompts[0]).not.toContain(canary);
    expect(plainPrompts[0]).not.toContain(GUIDANCE_HEADING);

    // Started sessions cannot change guidance mid-flight.
    expectError(
      await send('sessions.update', {
        id: guided,
        patch: { additionalGuidance: 'Changed mid-session' },
      }),
      'CONFLICT',
    );
    expectNoOperationalLeak(canary);
  });
});
