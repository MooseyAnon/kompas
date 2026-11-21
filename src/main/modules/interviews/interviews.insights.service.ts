import {
  approvedOrProvisionalBarSchema,
  type InsightsProgress,
  type InsightsProgressRow,
  type InterviewMethod,
} from '../../../shared/contracts';
import type { InterviewsRepository } from './interviews.repository';
import type { InterviewReviewService } from './interviews.review.service';
import { InterviewInsightsRepository } from './interviews.insights.repository';
import { sessionNotFound } from './interviews.shared';

type ProgressRow = InsightsProgressRow;
type RoundReviewResult = ReturnType<InterviewReviewService['getRoundReview']>;

interface InsightsQuestionEntry {
  id: string;
  kind: 'primary' | 'follow_up';
  question: string;
  competency: string | null;
  createdAt: string;
  answer: string | null;
}

interface InsightsRoundEntry {
  id: string;
  ordinal: number;
  reassessmentOfRoundId: string | null;
  questions: InsightsQuestionEntry[];
  review: RoundReviewResult['review'];
  coaching: RoundReviewResult['coaching'];
}

interface RoundTally {
  scoredRounds: number;
  unscoredRounds: number;
  pendingRounds: number;
  reassessments: number;
  pass: number;
  fail: number;
  sum: number;
}

/** Minimum distinct sessions for a cohort to show a progress trend. */
const MIN_COHORT_SESSIONS = 2;

/**
 * Aggregate progress rows into counts, an average score and one trend point
 * per completed session.
 */
export function aggregateInsights(
  rows: InsightsProgressRow[],
  limited: boolean,
  subject: string | null,
  method: InterviewMethod | null,
): InsightsProgress {
  const sessions = new Set(rows.map((r) => r.sessionId));
  const tally: RoundTally = {
    scoredRounds: 0,
    unscoredRounds: 0,
    pendingRounds: 0,
    reassessments: 0,
    pass: 0,
    fail: 0,
    sum: 0,
  };
  const bySession = new Map<string, { date: string; scores: number[] }>();
  const bars = new Set<string>();

  for (const row of rows) {
    if (row.status === 'completed' && row.barKey) {
      bars.add(row.barKey);
    }

    const score = tallyRow(row, tally);

    if (score !== null && row.status === 'completed' && row.completedAt) {
      const entry = bySession.get(row.sessionId) ?? {
        date: row.completedAt,
        scores: [],
      };
      entry.scores.push(score);
      bySession.set(row.sessionId, entry);
    }
  }

  const { scoredRounds, sum, ...counts } = tally;

  return {
    subject,
    method,
    sessions: sessions.size,
    scoredRounds,
    unscoredRounds: counts.unscoredRounds,
    pendingRounds: counts.pendingRounds,
    reassessments: counts.reassessments,
    pass: counts.pass,
    fail: counts.fail,
    averageScore: scoredRounds ? sum / scoredRounds : null,
    points: toTrendPoints(bySession),
    variedBars: bars.size > 1,
    limited,
  };
}

/** Count one row into the tally; returns its score only when it is scored. */
function tallyRow(row: ProgressRow, tally: RoundTally): number | null {
  if (!row.roundId) {
    return null;
  }

  if (row.reassessmentOfRoundId !== null) {
    tally.reassessments++;
    return null;
  }

  if (row.decision === 'unscored') {
    tally.unscoredRounds++;
    return null;
  }

  const isScored =
    (row.decision === 'pass' || row.decision === 'fail') &&
    row.score !== null &&
    Number.isFinite(row.score);

  if (!isScored || row.score === null) {
    tally.pendingRounds++;
    return null;
  }

  tally.scoredRounds++;
  tally.sum += row.score;

  if (row.decision === 'pass') {
    tally.pass++;
  } else {
    tally.fail++;
  }

  return row.score;
}

function toTrendPoints(
  bySession: Map<string, { date: string; scores: number[] }>,
): InsightsProgress['points'] {
  return [...bySession]
    .map(([sessionId, { date, scores }]) => ({
      sessionId,
      completedAt: date,
      scoredRoundCount: scores.length,
      score: scores.reduce((a, b) => a + b, 0) / scores.length,
    }))
    .sort(
      (a, b) =>
        a.completedAt.localeCompare(b.completedAt) ||
        a.sessionId.localeCompare(b.sessionId),
    );
}

/** Read-only history, detail and progress views over past interviews. */
export class InterviewInsightsService {
  constructor(
    private readonly reads: InterviewInsightsRepository,
    private readonly repository: InterviewsRepository,
    private readonly reviews: InterviewReviewService,
  ) {}

  sessions(input: Parameters<InterviewInsightsRepository['sessions']>[0]) {
    return this.reads.sessions(input);
  }

  questions(input: Parameters<InterviewInsightsRepository['questions']>[0]) {
    return this.reads.questions(input);
  }

  /**
   * One session with its rounds. Reviews and the bar are disclosed only once
   * the session may show them (quick-fire requires publication).
   */
  detail(sessionId: string) {
    const session = this.repository.getSession(sessionId);

    if (!session) {
      throw sessionNotFound();
    }

    const rounds = this.collectRounds(sessionId, session.method);
    const isFinished =
      session.status === 'completed' ||
      (session.status === 'abandoned' && session.method !== 'quick_fire');
    const disclosed =
      isFinished &&
      (session.method !== 'quick_fire' ||
        !!this.repository.getPublication(sessionId)) &&
      rounds.some((r) => r.review);
    const barParsed = disclosed
      ? approvedOrProvisionalBarSchema.safeParse(session.barSnapshot)
      : null;

    return {
      session: {
        ...session,
        barSnapshot: disclosed && barParsed?.success ? barParsed.data : null,
      },
      bar: barParsed?.success ? barParsed.data : null,
      rounds,
    };
  }

  /**
   * Progress for the requested cohort, or — when subject or method is
   * omitted — the most recent comparable cohort.
   */
  progress(subject?: string, method?: InterviewMethod): InsightsProgress {
    const { rows, limited } = this.reads.progress(
      method ?? null,
      subject ?? null,
    );
    const cohort =
      !subject || !method ? pickLatestCohort(rows, subject, method) : null;
    const selectedSubject = subject ?? cohort?.subject ?? null;
    const selectedMethod = method ?? cohort?.method ?? null;
    const selectedRows = rows.filter(
      (r) =>
        (selectedSubject === null || r.subject === selectedSubject) &&
        (selectedMethod === null || r.method === selectedMethod),
    );

    return aggregateInsights(
      selectedRows,
      limited,
      selectedSubject,
      selectedMethod,
    );
  }

  private collectRounds(
    sessionId: string,
    method: InterviewMethod,
  ): InsightsRoundEntry[] {
    const rounds: InsightsRoundEntry[] = [];

    for (const row of this.reads.detail(sessionId)) {
      let round = rounds.at(-1);

      if (!round || round.id !== row.id) {
        const saved = this.readSavedReview(sessionId, method, row);
        round = {
          id: row.id,
          ordinal: row.ordinal,
          reassessmentOfRoundId: row.reassessmentOfRoundId,
          questions: [],
          ...saved,
        };
        rounds.push(round);
      }

      if (row.questionId && row.kind && row.question && row.createdAt) {
        round.questions.push({
          id: row.questionId,
          kind: row.kind,
          question: row.question,
          competency: row.competency,
          createdAt: row.createdAt,
          answer: row.answer,
        });
      }
    }

    return rounds;
  }

  private readSavedReview(
    sessionId: string,
    method: InterviewMethod,
    row: { id: string; questionId: string | null },
  ): RoundReviewResult {
    const mayShowReview =
      row.questionId &&
      (method !== 'quick_fire' || this.repository.getPublication(sessionId));

    return mayShowReview
      ? this.reviews.getRoundReview(sessionId, row.id)
      : { review: null, coaching: null };
  }
}

/**
 * Prefer the most recent comparable cohort with two scored sessions, falling
 * back to the most recent cohort.
 */
function pickLatestCohort(
  rows: ProgressRow[],
  subject: string | undefined,
  method: InterviewMethod | undefined,
): ProgressRow | undefined {
  const candidates = rows.filter(
    (r) =>
      r.status === 'completed' &&
      r.reassessmentOfRoundId === null &&
      r.score !== null &&
      (r.decision === 'pass' || r.decision === 'fail') &&
      (!subject || r.subject === subject) &&
      (!method || r.method === method),
  );
  const cohorts = new Map<string, ProgressRow[]>();

  for (const row of candidates) {
    const key = JSON.stringify([row.subject, row.method]);
    cohorts.set(key, [...(cohorts.get(key) ?? []), row]);
  }

  const latest = (group: ProgressRow[]) =>
    group.reduce((date, row) => {
      const completedAt = row.completedAt ?? '';
      return completedAt > date ? completedAt : date;
    }, '');
  const sorted = [...cohorts.values()].sort((a, b) =>
    latest(b).localeCompare(latest(a)),
  );
  const comparable = sorted.find(
    (group) =>
      new Set(group.map((r) => r.sessionId)).size >= MIN_COHORT_SESSIONS,
  );

  return (comparable ?? sorted[0])?.[0];
}
