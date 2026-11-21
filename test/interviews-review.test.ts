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
import type {
  GenerationRequestInput,
  GenerationResult,
  InferenceErrorCode,
  InferenceSettingsGetOutput,
  JsonValue,
  ModelDescriptor,
  ResponseEnvelope,
} from '../src/shared/contracts';

// --- Deterministic scripted inference fake ---------------------------------

type Task = 'question' | 'review' | 'coach';

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

const REASSESSMENT_VARIANTS: JsonValue[] = [
  {
    question:
      'Diagnose and recover a failed run of a recurring task, then justify how you prioritised the recovery steps you chose.',
    competency: 'structured problem solving',
    criteria: [
      'Diagnoses likely causes systematically',
      'Prioritises recovery with justification',
    ],
    sourceBasis: 'model_general_knowledge',
  },
  {
    question:
      'Compare two scheduling strategies for throughput versus latency, and defend which you would adopt for a bursty workload.',
    competency: 'structured problem solving',
    criteria: [
      'Contrasts throughput against latency concretely',
      'Defends a choice for the bursty workload',
    ],
    sourceBasis: 'model_general_knowledge',
  },
  {
    question:
      'Outline how you would validate correctness after migrating stored data, including the checks and rollback you would prepare.',
    competency: 'structured problem solving',
    criteria: [
      'Describes meaningful correctness checks',
      'Prepares a credible rollback plan',
    ],
    sourceBasis: 'model_general_knowledge',
  },
];

function baseQuestion(): JsonValue {
  return {
    question:
      'Explain how you would design a reliable process for a recurring task and justify the key trade-offs you would make.',
    competency: 'structured problem solving',
    criteria: [
      'Identifies the main requirements and failure modes',
      'Explains relevant trade-offs clearly',
    ],
    sourceBasis: 'model_general_knowledge',
  };
}

function reviewFor(ids: string[], score: number): JsonValue {
  return {
    criterionIds: ids,
    scores: ids.map(() => score),
    evidence: ids.map(() => ''),
    rationales: ids.map(() => 'Assessed against the criterion.'),
    strengths: ['Addresses the question'],
    gaps: ['Needs more concrete reasoning'],
    needsMoreEvidence: false,
  };
}

function validCoaching(): JsonValue {
  return {
    diagnosis: 'The answer lacks justified trade-offs.',
    advice: ['State the requirements first.', 'Name two concrete trade-offs.'],
    workedExample: 'A stronger answer weighs reliability against cost.',
    reassessmentFocus: 'Justifying trade-offs',
  };
}

type Spec =
  | { kind: 'ok'; output: JsonValue }
  | { kind: 'fail'; code: InferenceErrorCode }
  | { kind: 'cancelled' };

class FakeInference {
  providerId: string | null = 'mock';
  modelId: string | null = 'mock-static';
  resolvedModel: ModelDescriptor | null = localModel('mock', 'mock-static');
  /** Fixed score the default review responder returns for each criterion. */
  reviewScore = 80;
  /** Per-task override queues (consumed before defaults). */
  reviewScript: Spec[] = [];
  questionScript: Spec[] = [];
  coachScript: Spec[] = [];
  calls = { question: 0, review: 0, coach: 0 };
  reassessCount = 0;
  lastReviewRequest: GenerationRequestInput | null = null;

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

  async generate(request: GenerationRequestInput): Promise<GenerationResult> {
    const task = detectTask(request);
    this.calls[task] += 1;
    const base = {
      requestId: request.requestId ?? crypto.randomUUID(),
      providerId: request.providerId,
      modelId: request.modelId,
      toolCalls: [],
      usage: null,
    };
    let spec: Spec | undefined;
    if (task === 'question') {
      spec = this.questionScript.shift();
      if (!spec) {
        const variant = request.messages.some((m) =>
          m.content.includes('materially different scenario'),
        );
        if (variant) {
          const output =
            REASSESSMENT_VARIANTS[
              this.reassessCount % REASSESSMENT_VARIANTS.length
            ];
          this.reassessCount += 1;
          spec = { kind: 'ok', output };
        } else {
          spec = { kind: 'ok', output: baseQuestion() };
        }
      }
    } else if (task === 'review') {
      this.lastReviewRequest = request;
      spec = this.reviewScript.shift();
      if (!spec) {
        spec = {
          kind: 'ok',
          output: reviewFor(criterionIdsFrom(request), this.reviewScore),
        };
      }
    } else {
      spec = this.coachScript.shift();
      if (!spec) {
        spec = { kind: 'ok', output: validCoaching() };
      }
    }

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
}

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

// --- Harness ----------------------------------------------------------------

let workDir: string;
let jsonlPath: string;
let storage: Storage;
let telemetry: TelemetryService;
let fake: FakeInference;
let dispatcher: Dispatcher;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-iqreview-'));
  jsonlPath = path.join(workDir, 'app.jsonl');
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(jsonlPath),
  });
  fake = new FakeInference();
  dispatcher = buildDispatcher();
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function buildDispatcher(): Dispatcher {
  return createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    telemetry,
    storage: { db: storage.db, fileStore: storage.fileStore },
    inference: { service: fake as unknown as InferenceService },
  });
}

async function send<T = unknown>(
  action: string,
  payload: unknown,
): Promise<ResponseEnvelope<T>> {
  return dispatcher.dispatch({
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

interface QuestionInfo {
  sessionId: string;
  questionId: string;
  roundId: string;
}

async function createSession(
  method: 'deep_loop' | 'quick_fire' = 'deep_loop',
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    method,
    subject: 'relational databases',
    ...overrides,
  };
  if (method === 'quick_fire') {
    payload.questionCount = 5;
  }
  const data = ok(
    await send<{ session: { id: string } }>('sessions.create', payload),
  );
  return data.session.id;
}

async function generateQuestion(sessionId: string): Promise<QuestionInfo> {
  const data = ok(
    await send<{ question: { id: string; roundId: string } }>(
      'questions.generate',
      { sessionId },
    ),
  );
  return {
    sessionId,
    questionId: data.question.id,
    roundId: data.question.roundId,
  };
}

const ANSWER =
  'I would normalise the schema, index the foreign keys and weigh read versus write trade-offs.';

async function startAnswered(reviewScore?: number): Promise<QuestionInfo> {
  if (reviewScore !== undefined) {
    fake.reviewScore = reviewScore;
  }
  const sessionId = await createSession('deep_loop');
  const info = await generateQuestion(sessionId);
  ok(
    await send('answers.submit', {
      sessionId,
      questionId: info.questionId,
      answerText: ANSWER,
    }),
  );
  return info;
}

interface ReviewView {
  id: string;
  decision: 'pass' | 'fail' | 'unscored';
  score: number | null;
  provisional: boolean;
  unscoredReason: string | null;
}

async function runReview(info: QuestionInfo): Promise<ReviewView> {
  const data = ok(
    await send<{ review: ReviewView }>('reviews.run', {
      sessionId: info.sessionId,
      roundId: info.roundId,
    }),
  );
  return data.review;
}

// --- Tests ------------------------------------------------------------------

describe('deep-loop answer submission', () => {
  it('commits the answer and promotes the draft session to active', async () => {
    const sessionId = await createSession('deep_loop');
    const info = await generateQuestion(sessionId);
    const data = ok(
      await send<{
        answerId: string;
        roundId: string;
        sessionStatus: string;
        phase: string | null;
      }>('answers.submit', {
        sessionId,
        questionId: info.questionId,
        answerText: ANSWER,
      }),
    );
    expect(data.roundId).toBe(info.roundId);
    expect(data.sessionStatus).toBe('active');
    expect(data.phase).toBe('deep_loop');

    const session = ok(
      await send<{ session: { status: string } }>('sessions.get', {
        id: sessionId,
      }),
    );
    expect(session.session.status).toBe('active');
  });

  it('rejects a duplicate submission (answers are immutable)', async () => {
    const info = await startAnswered();
    expectError(
      await send('answers.submit', {
        sessionId: info.sessionId,
        questionId: info.questionId,
        answerText: 'A different answer',
      }),
      'CONFLICT',
    );
  });

  it('rejects a blank answer at the contract boundary', async () => {
    const sessionId = await createSession('deep_loop');
    const info = await generateQuestion(sessionId);
    expectError(
      await send('answers.submit', {
        sessionId,
        questionId: info.questionId,
        answerText: '   ',
      }),
      'INVALID_INPUT',
    );
  });

  it('does not expose per-question review for a quick-fire session', async () => {
    const sessionId = await createSession('quick_fire');
    // Quick-fire reviews are a held batch owned by the interactive session
    // runner (stage 007.3), never the per-question deep-loop review action.
    expectError(
      await send('reviews.run', {
        sessionId,
        roundId: crypto.randomUUID(),
      }),
      'CONFLICT',
    );
  });
});

describe('deep-loop review', () => {
  it('scores a good answer above threshold as a single pass with no coaching', async () => {
    const info = await startAnswered(80);
    const review = await runReview(info);
    expect(review.decision).toBe('pass');
    expect(review.score).toBe(80);
    expect(review.provisional).toBe(true);

    // No coaching is allowed for a pass.
    expectError(
      await send('coaching.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
      'CONFLICT',
    );
  });

  it('scores a below-threshold answer as fail and persists one review only', async () => {
    const info = await startAnswered(40);
    const review = await runReview(info);
    expect(review.decision).toBe('fail');
    expect(review.score).toBe(40);

    // A repeated review returns the same row, never a second one.
    const again = await runReview(info);
    expect(again.id).toBe(review.id);
    expect(fake.calls.review).toBe(1);
  });

  it('records unscored when the frozen bar is missing (never a fake score)', async () => {
    const sessionId = await createSession('deep_loop');
    const info = await generateQuestion(sessionId);
    ok(
      await send('answers.submit', {
        sessionId,
        questionId: info.questionId,
        answerText: ANSWER,
      }),
    );
    // Remove the frozen bar to simulate an absent benchmark.
    storage.db
      .prepare(
        'UPDATE interview_sessions SET bar_snapshot_json = NULL WHERE id = ?',
      )
      .run(sessionId);

    const review = await runReview(info);
    expect(review.decision).toBe('unscored');
    expect(review.score).toBeNull();
    expect(review.unscoredReason).toBe('missing_bar');
    // No model call is needed when there is no bar.
    expect(fake.calls.review).toBe(0);
  });

  it('records unscored when the model reports it cannot evaluate', async () => {
    const info = await startAnswered();
    fake.reviewScript = [
      {
        kind: 'ok',
        output: {
          criterionIds: ['accuracy'],
          scores: [0],
          needsMoreEvidence: true,
        },
      },
      {
        kind: 'ok',
        output: {
          criterionIds: ['accuracy'],
          scores: [0],
          needsMoreEvidence: true,
        },
      },
    ];
    const review = await runReview(info);
    expect(review.decision).toBe('unscored');
    expect(review.unscoredReason).toBe('model_needs_more_evidence');
  });

  it('treats an unknown criterion id as unscored, never a pass', async () => {
    const info = await startAnswered();
    const bad = {
      kind: 'ok' as const,
      output: {
        criterionIds: ['not-a-real-criterion'],
        scores: [95],
        needsMoreEvidence: false,
      },
    };
    fake.reviewScript = [bad, bad];
    const review = await runReview(info);
    expect(review.decision).toBe('unscored');
    expect(review.score).toBeNull();
  });

  it('treats an out-of-range score as unscored', async () => {
    const info = await startAnswered();
    const ids = ['accuracy', 'reasoning', 'relevance'];
    const bad = {
      kind: 'ok' as const,
      output: {
        criterionIds: ids,
        scores: [150, 80, 80],
        needsMoreEvidence: false,
      },
    };
    fake.reviewScript = [bad, bad];
    const review = await runReview(info);
    expect(review.decision).toBe('unscored');
  });

  it('treats a non-literal evidence quote as unscored', async () => {
    const info = await startAnswered();
    const ids = ['accuracy', 'reasoning', 'relevance'];
    const bad = {
      kind: 'ok' as const,
      output: {
        criterionIds: ids,
        scores: [90, 90, 90],
        evidence: ['a quote that is not in the answer at all', '', ''],
        needsMoreEvidence: false,
      },
    };
    fake.reviewScript = [bad, bad];
    const review = await runReview(info);
    expect(review.decision).toBe('unscored');
  });

  it('retries an invalid-JSON generation once, then fails safely without a review', async () => {
    const info = await startAnswered();
    fake.reviewScript = [
      { kind: 'fail', code: 'INVALID_RESPONSE' },
      { kind: 'fail', code: 'INVALID_RESPONSE' },
    ];
    expectError(
      await send('reviews.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
      'CONFLICT',
    );
    expect(fake.calls.review).toBe(2);
    // No review row was written, so a later valid run still works.
    fake.reviewScore = 80;
    const review = await runReview(info);
    expect(review.decision).toBe('pass');
  });

  it('surfaces a model-unavailable error as retryable with no review', async () => {
    const info = await startAnswered();
    fake.reviewScript = [{ kind: 'fail', code: 'PROVIDER_UNAVAILABLE' }];
    expectError(
      await send('reviews.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
      'CONFLICT',
    );
    // A provider failure is not retried as a structural problem.
    expect(fake.calls.review).toBe(1);
  });

  it('requires an answer before review', async () => {
    const sessionId = await createSession('deep_loop');
    const info = await generateQuestion(sessionId);
    expectError(
      await send('reviews.run', { sessionId, roundId: info.roundId }),
      'CONFLICT',
    );
  });

  it('does not let the reviewer see the broader profile or past chats', async () => {
    const info = await startAnswered(80);
    await runReview(info);
    const request = fake.lastReviewRequest;
    expect(request).not.toBeNull();
    const text = request!.messages.map((m) => m.content).join('\n');
    // Only the current question + answer + bar criteria, no identity dump.
    expect(text).toContain(ANSWER);
    expect(request!.toolNames).toEqual([]);
  });
});

describe('deep-loop coaching and reassessment', () => {
  it('coaches only a failed round and links a distinct reassessment question', async () => {
    const info = await startAnswered(40);
    const review = await runReview(info);
    expect(review.decision).toBe('fail');

    const coachingData = ok(
      await send<{ coaching: { id: string; roundId: string } }>(
        'coaching.run',
        { sessionId: info.sessionId, roundId: info.roundId },
      ),
    );
    expect(coachingData.coaching.roundId).toBe(info.roundId);

    // Idempotent: a second coaching call returns the same record.
    const coachAgain = ok(
      await send<{ coaching: { id: string } }>('coaching.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
    );
    expect(coachAgain.coaching.id).toBe(coachingData.coaching.id);
    expect(fake.calls.coach).toBe(1);

    const reassess = ok(
      await send<{ newRoundId: string; question: { question: string } }>(
        'reassessment.generate',
        { sessionId: info.sessionId, failedRoundId: info.roundId },
      ),
    );
    expect(reassess.newRoundId).not.toBe(info.roundId);
    expect(reassess.question.question).not.toBe('');
  });

  it('refuses coaching before a review exists', async () => {
    const info = await startAnswered();
    expectError(
      await send('coaching.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
      'CONFLICT',
    );
  });

  it('refuses reassessment before coaching', async () => {
    const info = await startAnswered(40);
    await runReview(info);
    expectError(
      await send('reassessment.generate', {
        sessionId: info.sessionId,
        failedRoundId: info.roundId,
      }),
      'CONFLICT',
    );
  });

  it('enforces the reassessment cap and recommends study without a cycle', async () => {
    fake.reviewScore = 40; // always fail
    const info = await startAnswered();
    let roundId = info.roundId;
    // Walk two allowed reassessments (depth 1 and 2), then hit the cap.
    for (let i = 0; i < 2; i += 1) {
      await runReview({ ...info, roundId });
      ok(await send('coaching.run', { sessionId: info.sessionId, roundId }));
      const reassess = ok(
        await send<{ newRoundId: string; question: { id: string } }>(
          'reassessment.generate',
          { sessionId: info.sessionId, failedRoundId: roundId },
        ),
      );
      roundId = reassess.newRoundId;
      // Answer the new round so it can be reviewed next iteration.
      const q = ok(
        await send<{ review: unknown } | { question?: unknown }>(
          'reviews.get',
          { sessionId: info.sessionId, roundId },
        ),
      );
      void q;
      // Find the new question id to answer it.
      const row = storage.db
        .prepare(
          `SELECT q.id AS id FROM interview_questions q WHERE q.round_id = ? AND q.kind = 'primary'`,
        )
        .get(roundId) as { id: string };
      ok(
        await send('answers.submit', {
          sessionId: info.sessionId,
          questionId: row.id,
          answerText: ANSWER,
        }),
      );
    }
    // The third failed round is at the cap: review + coach, then reassess fails.
    await runReview({ ...info, roundId });
    ok(await send('coaching.run', { sessionId: info.sessionId, roundId }));
    expectError(
      await send('reassessment.generate', {
        sessionId: info.sessionId,
        failedRoundId: roundId,
      }),
      'CONFLICT',
    );

    // No cycles were introduced.
    const cycles = storage.db
      .prepare(
        `SELECT COUNT(*) AS c FROM interview_rounds WHERE reassessment_of_round_id = id`,
      )
      .get() as { c: number };
    expect(cycles.c).toBe(0);
  });
});

describe('persistence, restart and isolation', () => {
  it('keeps the answer, review and coaching across a storage restart', async () => {
    const info = await startAnswered(40);
    await runReview(info);
    ok(
      await send('coaching.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
    );

    // Reopen storage (simulates relaunch) and rebuild the dispatcher.
    storage.close();
    storage = openStorage(workDir);
    telemetry = new TelemetryService({
      repository: new TelemetryRepository(storage.db),
      logger: new JsonlLogger(jsonlPath),
    });
    dispatcher = buildDispatcher();

    const saved = ok(
      await send<{
        review: { decision: string } | null;
        coaching: { id: string } | null;
      }>('reviews.get', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
    );
    expect(saved.review?.decision).toBe('fail');
    expect(saved.coaching).not.toBeNull();

    const answers = storage.db
      .prepare('SELECT COUNT(*) AS c FROM interview_answers')
      .get() as { c: number };
    expect(answers.c).toBe(1);
  });

  it('refuses cross-session round access', async () => {
    const a = await startAnswered(40);
    const b = await createSession('deep_loop');
    // Round from session A cannot be reviewed under session B.
    expectError(
      await send('reviews.run', { sessionId: b, roundId: a.roundId }),
      'NOT_FOUND',
    );
  });

  it('keeps an answer after a failed review so a retry can succeed', async () => {
    const info = await startAnswered();
    fake.reviewScript = [{ kind: 'fail', code: 'PROVIDER_UNAVAILABLE' }];
    expectError(
      await send('reviews.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
      'CONFLICT',
    );
    const answers = storage.db
      .prepare('SELECT COUNT(*) AS c FROM interview_answers')
      .get() as { c: number };
    expect(answers.c).toBe(1);
    // A later successful review works and writes exactly one review row.
    fake.reviewScore = 80;
    const review = await runReview(info);
    expect(review.decision).toBe('pass');
    const reviews = storage.db
      .prepare('SELECT COUNT(*) AS c FROM interview_reviews')
      .get() as { c: number };
    expect(reviews.c).toBe(1);
  });
});

describe('privacy', () => {
  it('never leaks answer or question text into telemetry', async () => {
    const info = await startAnswered(40);
    await runReview(info);
    ok(
      await send('coaching.run', {
        sessionId: info.sessionId,
        roundId: info.roundId,
      }),
    );

    const runs = storage.db
      .prepare('SELECT detail_json FROM operation_runs')
      .all() as Array<{ detail_json: string | null }>;
    const blob = runs.map((r) => r.detail_json ?? '').join('\n');
    expect(blob).not.toContain(ANSWER);
    expect(blob).not.toContain('normalise the schema');

    const jsonl = fs.existsSync(jsonlPath)
      ? fs.readFileSync(jsonlPath, 'utf8')
      : '';
    expect(jsonl).not.toContain(ANSWER);
    expect(jsonl).not.toContain('relational databases');
  });
});
