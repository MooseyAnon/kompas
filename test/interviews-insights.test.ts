import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import { InterviewsRepository } from '../src/main/modules/interviews/interviews.repository';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { aggregateInsights } from '../src/main/modules/interviews/interviews.insights.service';
import type {
  InsightsProgressRow,
  ResponseEnvelope,
} from '../src/shared/contracts';

let dir: string, storage: Storage, repo: InterviewsRepository;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-insights-'));
  storage = openStorage(dir);
  repo = new InterviewsRepository(storage.db);
});
afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const id = () => crypto.randomUUID();
const time = (day: number) =>
  `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const secret = 'PRIVATE_INTERVIEW_CANARY_01';
function session(
  day: number,
  method: 'deep_loop' | 'quick_fire' = 'deep_loop',
  subject = 'Architecture',
) {
  const sid = id();
  repo.createSession({
    id: sid,
    method,
    subject,
    careerTargetId: null,
    targetSnapshot: null,
    questionCount: method === 'quick_fire' ? 5 : null,
    now: time(day),
  });
  return sid;
}
function round(
  sid: string,
  ordinal: number,
  day: number,
  score: number | null,
  decision: 'pass' | 'fail' | 'unscored' | null,
  parent?: string,
) {
  const rid = id(),
    qid = id();
  repo.createRound({
    id: rid,
    sessionId: sid,
    ordinal,
    reassessmentOfRoundId: parent ?? null,
    now: time(day),
  });
  repo.createQuestion({
    id: qid,
    roundId: rid,
    ordinal: 1,
    kind: 'primary',
    questionText: secret,
    competency: 'Design',
    rubric: { hidden: secret },
    now: time(day),
  });
  repo.createAnswer({
    id: id(),
    questionId: qid,
    answerText: secret,
    now: time(day),
  });
  if (decision)
    repo.createReview({
      id: id(),
      roundId: rid,
      decision,
      score,
      feedback: {
        criteria: [
          {
            id: 'reasoning',
            label: 'Reasoning',
            weight: 1,
            score,
            evidence: secret,
            rationale: 'Recorded',
          },
        ],
        strengths: [],
        gaps: [],
        needsMoreEvidence: false,
        unscoredReason: decision === 'unscored' ? 'No evidence' : null,
      },
      now: time(day),
    });
  return rid;
}
async function send(
  action: string,
  payload: unknown,
): Promise<ResponseEnvelope<unknown>> {
  const dispatcher = createAppDispatcher({
    getAppVersion: () => '1',
    isStorageReady: () => true,
    storage: { db: storage.db, fileStore: storage.fileStore },
  });
  return dispatcher.dispatch({
    requestId: id(),
    module: 'interviews',
    version: 1,
    action,
    payload,
  });
}
function data<T>(response: ResponseEnvelope<unknown>): T {
  if (!response.ok) throw new Error(response.error.code);
  return response.data as T;
}

describe('interview insights read boundary', () => {
  it('paginates sessions and questions by date/id with filters and never duplicates on repeated reads', async () => {
    const a = session(1),
      b = session(2, 'quick_fire'),
      c = session(3);
    round(a, 1, 1, 0, 'fail');
    round(b, 1, 2, 50, 'pass');
    round(c, 1, 3, null, null);
    const first = data<{ items: Array<{ id: string }>; nextCursor: string }>(
      await send('insights.sessions.list', { limit: 2 }),
    );
    expect(first.items.map((s) => s.id)).toEqual([c, b]);
    expect(
      data<{ items: Array<{ id: string }> }>(
        await send('insights.sessions.list', {
          limit: 2,
          cursor: first.nextCursor,
        }),
      ).items.map((s) => s.id),
    ).toEqual([a]);
    expect(
      data<{ items: unknown[] }>(
        await send('insights.sessions.list', { method: 'quick_fire' }),
      ).items,
    ).toHaveLength(1);
    const questions = data<{
      items: Array<{ sessionId: string; id: string }>;
      nextCursor: string;
    }>(
      await send('insights.questions.list', {
        limit: 2,
        competency: ' design ',
      }),
    );
    expect(questions.items.map((q) => q.sessionId)).toEqual([c, b]);
    expect(
      data<{ items: Array<{ sessionId: string }> }>(
        await send('insights.questions.list', {
          limit: 2,
          cursor: questions.nextCursor,
          competency: 'design',
        }),
      ).items[0].sessionId,
    ).toBe(a);
    expect((await send('insights.sessions.list', { limit: 51 })).ok).toBe(
      false,
    );
    expect((await send('insights.questions.list', { cursor: 'bad' })).ok).toBe(
      false,
    );
    expect(
      data<{ items: unknown[] }>(
        await send('insights.questions.list', {
          subject: "Architecture' OR 1=1 --",
        }),
      ).items,
    ).toHaveLength(0);
    expect(
      data<{ items: unknown[] }>(
        await send('insights.questions.list', { limit: 2 }),
      ).items,
    ).toHaveLength(2);
    expect(
      (
        await send('insights.sessions.list', {
          cursor: a,
          method: 'quick_fire',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await send('insights.questions.list', {
          cursor: questions.items[0].id,
          subject: 'Other',
        })
      ).ok,
    ).toBe(false);
  });

  it('reads frozen review detail without leaking unanswered rubric or modifying domain rows', async () => {
    const sid = session(1);
    const rid = round(sid, 1, 1, 0, 'fail');
    const pending = id();
    repo.createRound({ id: pending, sessionId: sid, ordinal: 2, now: time(1) });
    repo.createQuestion({
      id: id(),
      roundId: pending,
      ordinal: 1,
      kind: 'primary',
      questionText: 'Unanswered',
      rubric: { secret },
      now: time(1),
    });
    const before = storage.db
      .prepare('SELECT count(*) AS n FROM interview_reviews')
      .get() as { n: number };
    const detail = data<{
      bar: unknown;
      rounds: Array<{
        id: string;
        review: { score: number; criteria: Array<{ evidence: string }> } | null;
        questions: Array<{ answer: string | null }>;
      }>;
    }>(await send('insights.sessions.get', { sessionId: sid }));
    expect(detail.bar).toBeNull();
    expect(detail.rounds[0].id).toBe(rid);
    expect(detail.rounds[0].review?.score).toBe(0);
    expect(detail.rounds[0].review?.criteria[0].evidence).toBe(secret);
    expect(detail.rounds[1].review).toBeNull();
    expect(detail.rounds[1].questions[0].answer).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('"hidden"');
    expect(
      storage.db.prepare('SELECT count(*) AS n FROM interview_reviews').get(),
    ).toEqual(before);
    expect((await send('insights.sessions.get', { sessionId: id() })).ok).toBe(
      false,
    );
  });

  it('separates follow-ups and reassessments; restores scored cohorts after reopening', async () => {
    const a = session(1);
    const primary = round(a, 1, 1, 0, 'fail');
    const follow = id();
    repo.createQuestion({
      id: follow,
      roundId: primary,
      ordinal: 2,
      kind: 'follow_up',
      questionText: 'Follow-up',
      now: time(1),
    });
    repo.createAnswer({
      id: id(),
      questionId: follow,
      answerText: secret,
      now: time(1),
    });
    round(a, 2, 1, 100, 'pass', primary);
    const b = session(2);
    round(b, 1, 2, 80, 'pass');
    round(b, 2, 2, null, 'unscored');
    const c = session(3);
    round(c, 1, 3, null, null);
    const d = session(4, 'quick_fire');
    for (let n = 1; n <= 5; n++) round(d, n, 4, 60, 'pass');
    for (const sid of [a, b, c, d])
      repo.markSessionStatus(
        sid,
        'completed',
        'completed',
        time(Number(repo.getSession(sid)!.createdAt.slice(8, 10))),
      );
    storage.db
      .prepare(
        'INSERT INTO interview_publications (session_id, summary_json, published_at) VALUES (?, NULL, ?)',
      )
      .run(d, time(4));
    const abandoned = session(5);
    repo.markSessionStatus(abandoned, 'abandoned', 'abandoned', time(5));
    const snapshot = data<{
      points: Array<{ score: number; scoredRoundCount: number }>;
      scoredRounds: number;
      reassessments: number;
      unscoredRounds: number;
      pendingRounds: number;
      averageScore: number;
    }>(
      await send('insights.progress.get', {
        subject: 'Architecture',
        method: 'deep_loop',
      }),
    );
    expect(snapshot.points.map((p) => [p.score, p.scoredRoundCount])).toEqual([
      [0, 1],
      [80, 1],
    ]);
    expect([
      snapshot.scoredRounds,
      snapshot.reassessments,
      snapshot.unscoredRounds,
      snapshot.pendingRounds,
      snapshot.averageScore,
    ]).toEqual([2, 1, 1, 1, 40]);
    expect(
      data<{ points: unknown[] }>(
        await send('insights.progress.get', {
          method: 'quick_fire',
          subject: 'Architecture',
        }),
      ).points,
    ).toHaveLength(1);
    storage.close();
    storage = openStorage(dir);
    repo = new InterviewsRepository(storage.db);
    expect(
      data(
        await send('insights.progress.get', {
          subject: 'Architecture',
          method: 'deep_loop',
        }),
      ),
    ).toEqual(snapshot);
  });

  it('keeps private answer, question and feedback out of operational telemetry', async () => {
    const sid = session(1);
    round(sid, 1, 1, 20, 'fail');
    const log = path.join(dir, 'app.jsonl');
    const dispatcher = createAppDispatcher({
      getAppVersion: () => '1',
      isStorageReady: () => true,
      storage: { db: storage.db, fileStore: storage.fileStore },
      telemetry: new TelemetryService({
        repository: new TelemetryRepository(storage.db),
        logger: new JsonlLogger(log),
      }),
    });
    for (const action of [
      'insights.sessions.list',
      'insights.questions.list',
      'insights.progress.get',
    ]) {
      const response = await dispatcher.dispatch({
        requestId: id(),
        module: 'interviews',
        version: 1,
        action,
        payload: {},
      });
      expect(response.ok).toBe(true);
    }
    expect(
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    ).not.toContain(secret);
    const telemetryRows = storage.db
      .prepare('SELECT detail_json FROM operation_runs')
      .all();
    expect(JSON.stringify(telemetryRows)).not.toContain(secret);
  });
});

it('pure aggregation treats zero as scored and excludes pending, unscored and reassessment-only points', () => {
  const base = {
    subject: 'A',
    method: 'deep_loop' as const,
    status: 'completed' as const,
    completedAt: time(1),
    barKey: null,
    competency: 'Design',
    reassessmentOfRoundId: null,
  };
  const rows: InsightsProgressRow[] = [
    { ...base, sessionId: id(), roundId: id(), decision: 'fail', score: 0 },
    {
      ...base,
      sessionId: id(),
      roundId: id(),
      decision: 'unscored',
      score: null,
    },
    { ...base, sessionId: id(), roundId: id(), decision: null, score: null },
    {
      ...base,
      sessionId: id(),
      roundId: id(),
      reassessmentOfRoundId: id(),
      decision: 'pass',
      score: 100,
    },
  ];
  const result = aggregateInsights(rows, false, 'A', 'deep_loop');
  expect(result.points).toHaveLength(1);
  expect(result.points[0].score).toBe(0);
  expect([
    result.scoredRounds,
    result.unscoredRounds,
    result.pendingRounds,
    result.reassessments,
  ]).toEqual([1, 1, 1, 1]);
});
