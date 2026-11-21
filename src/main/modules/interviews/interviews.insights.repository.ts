import type { SqliteDatabase } from '../../core/db/connection';
import { LOCAL_PROFILE_ID } from '../../core/db/database';
import { AppError } from '../../ipc/errors';
import type {
  InsightsProgressRow,
  InsightsQuestion,
  InsightsSession,
  InterviewMethod,
  InterviewStatus,
} from '../../../shared/contracts';

type Filters = {
  cursor?: string;
  limit: number;
  method?: InterviewMethod;
  subject?: string;
  status?: InterviewStatus;
  competency?: string;
};

type Page<T> = { items: T[]; nextCursor: string | null };

type SessionRow = Omit<InsightsSession, 'counts'> & InsightsSession['counts'];

type QuestionRow = Omit<InsightsQuestion, 'answered'> & { answered: number };

type DetailRow = {
  id: string;
  ordinal: number;
  reassessmentOfRoundId: string | null;
  questionId: string | null;
  kind: 'primary' | 'follow_up' | null;
  question: string | null;
  competency: string | null;
  createdAt: string | null;
  answer: string | null;
};

const PROGRESS_SESSION_LIMIT = 100;

const PUBLICATION_EXISTS =
  'EXISTS (SELECT 1 FROM interview_publications p WHERE p.session_id=s.id)';

/** Quick-fire results stay hidden until the session is published. */
const REVIEW_VISIBLE = `(s.method!='quick_fire' OR ${PUBLICATION_EXISTS})`;
const REVIEW_HIDDEN = `s.method='quick_fire' AND NOT ${PUBLICATION_EXISTS}`;

const COHORT_FILTER =
  '(@method IS NULL OR s.method=@method) AND ' +
  '(@subject IS NULL OR s.subject=@subject)';
const STATUS_FILTER = '(@status IS NULL OR s.status=@status)';
const COMPETENCY_FILTER =
  '(@competency IS NULL OR ' +
  'lower(trim(q.competency))=lower(trim(@competency)))';

const SESSION_CURSOR_SQL = `SELECT 1 FROM interview_sessions s
  WHERE s.id=@cursor AND s.profile_id=@profile
  AND ${COHORT_FILTER} AND ${STATUS_FILTER}`;

const SESSIONS_SQL = `SELECT s.id, s.subject, s.method, s.status,
  s.created_at AS createdAt, s.completed_at AS completedAt,
  s.updated_at AS updatedAt, s.question_count AS questionCount,
  json_extract(s.target_snapshot_json, '$.role') AS targetRole,
  (SELECT COUNT(*) FROM interview_questions q
    JOIN interview_rounds r ON r.id=q.round_id
    WHERE r.session_id=s.id) AS questions,
  (SELECT COUNT(*) FROM interview_answers a
    JOIN interview_questions q ON q.id=a.question_id
    JOIN interview_rounds r ON r.id=q.round_id
    WHERE r.session_id=s.id) AS answered,
  (SELECT COUNT(*) FROM interview_reviews v
    JOIN interview_rounds r ON r.id=v.round_id
    WHERE r.session_id=s.id AND ${REVIEW_VISIBLE}) AS reviewed,
  (SELECT COUNT(*) FROM interview_reviews v
    JOIN interview_rounds r ON r.id=v.round_id
    WHERE r.session_id=s.id AND v.decision IN ('pass','fail')
    AND v.score IS NOT NULL AND ${REVIEW_VISIBLE}) AS scored,
  (SELECT COUNT(*) FROM interview_reviews v
    JOIN interview_rounds r ON r.id=v.round_id
    WHERE r.session_id=s.id AND v.decision='unscored'
    AND ${REVIEW_VISIBLE}) AS unscored
  FROM interview_sessions s WHERE s.profile_id=@profile
  AND ${COHORT_FILTER} AND ${STATUS_FILTER}
  AND (@cursor IS NULL OR (s.created_at,s.id) < (SELECT created_at,id
    FROM interview_sessions WHERE id=@cursor AND profile_id=@profile))
  ORDER BY s.created_at DESC, s.id DESC LIMIT @take`;

const QUESTION_CURSOR_SQL = `SELECT 1 FROM interview_questions q
 
    JOIN interview_rounds r ON r.id=q.round_id
  JOIN interview_sessions s ON s.id=r.session_id
  WHERE q.id=@cursor AND s.profile_id=@profile
  AND ${COHORT_FILTER} AND ${COMPETENCY_FILTER}`;

const QUESTIONS_SQL = `SELECT q.id, s.id AS sessionId, r.id AS roundId,
  r.ordinal AS roundOrdinal, q.kind,
  r.reassessment_of_round_id AS reassessmentOfRoundId,
  q.question_text AS question, q.competency, s.subject, s.method,
  q.created_at AS createdAt, (a.id IS NOT NULL) AS answered,
  CASE WHEN ${REVIEW_HIDDEN} THEN NULL ELSE v.decision END AS decision
  FROM interview_questions q
    JOIN interview_rounds r ON r.id=q.round_id
  JOIN interview_sessions s ON s.id=r.session_id
  LEFT JOIN interview_answers a ON a.question_id=q.id
  LEFT JOIN interview_reviews v ON v.round_id=r.id
  WHERE s.profile_id=@profile AND ${COHORT_FILTER} AND ${COMPETENCY_FILTER}
  AND (@cursor IS NULL OR (q.created_at,q.id) < (SELECT created_at,id
    FROM interview_questions WHERE id=@cursor))
  ORDER BY q.created_at DESC,q.id DESC LIMIT @take`;

const DETAIL_SQL = `SELECT r.id, r.ordinal,
  r.reassessment_of_round_id AS reassessmentOfRoundId,
  q.id AS questionId, q.kind, q.question_text AS question, q.competency,
  q.created_at AS createdAt, a.answer_text AS answer
  FROM interview_rounds r JOIN interview_sessions s ON s.id=r.session_id
  LEFT JOIN interview_questions q ON q.round_id=r.id
  LEFT JOIN interview_answers a ON a.question_id=q.id
  WHERE s.profile_id=? AND s.id=? ORDER BY r.ordinal,q.ordinal`;

const PROGRESS_SQL = `WITH recent AS (
  SELECT id,subject,method,status,completed_at,bar_snapshot_json
  FROM interview_sessions WHERE profile_id=@profile
  AND (@method IS NULL OR method=@method)
  AND (@subject IS NULL OR subject=@subject)
  ORDER BY created_at DESC,id DESC LIMIT ${PROGRESS_SESSION_LIMIT + 1}
) SELECT s.id AS sessionId,s.subject,s.method,s.status,
  s.completed_at AS completedAt,
  s.bar_snapshot_json AS barKey,r.id AS roundId,pq.competency,
  r.reassessment_of_round_id AS reassessmentOfRoundId,
  CASE WHEN ${REVIEW_HIDDEN} THEN NULL ELSE v.decision END AS decision,
  CASE WHEN ${REVIEW_HIDDEN} THEN NULL ELSE v.score END AS score
  FROM recent s LEFT JOIN interview_rounds r ON r.session_id=s.id
  LEFT JOIN interview_questions pq ON pq.round_id=r.id AND pq.kind='primary'
  LEFT JOIN interview_reviews v ON v.round_id=r.id
  ORDER BY s.id,r.ordinal`;

/** Read-only interview projections. All filters are bound values, never SQL fragments. */
export class InterviewInsightsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  sessions(filter: Filters): Page<InsightsSession> {
    this.assertCursor(
      SESSION_CURSOR_SQL,
      filter,
      { status: filter.status ?? null },
      'This history page is no longer available. Start again.',
    );

    const rows = this.db.prepare(SESSIONS_SQL).all({
      ...this.cohortParams(filter),
      status: filter.status ?? null,
      cursor: filter.cursor ?? null,
      take: filter.limit + 1,
    }) as SessionRow[];

    return toPage(
      rows,
      filter.limit,
      ({ questions, answered, reviewed, scored, unscored, ...row }) => ({
        ...row,
        counts: { questions, answered, reviewed, scored, unscored },
      }),
    );
  }

  questions(filter: Filters): Page<InsightsQuestion> {
    this.assertCursor(
      QUESTION_CURSOR_SQL,
      filter,
      { competency: filter.competency ?? null },
      'This question page is no longer available. Start again.',
    );

    const rows = this.db.prepare(QUESTIONS_SQL).all({
      ...this.cohortParams(filter),
      competency: filter.competency ?? null,
      cursor: filter.cursor ?? null,
      take: filter.limit + 1,
    }) as QuestionRow[];

    return toPage(rows, filter.limit, (row) => ({
      ...row,
      answered: row.answered === 1,
    }));
  }

  detail(sessionId: string) {
    return this.db
      .prepare(DETAIL_SQL)
      .all(LOCAL_PROFILE_ID, sessionId) as DetailRow[];
  }

  /** Most recent 100 sessions in the selected cohort, fetched with one bounded join. */
  progress(
    method: InterviewMethod | null,
    subject: string | null,
  ): { rows: InsightsProgressRow[]; limited: boolean } {
    const rows = this.db.prepare(PROGRESS_SQL).all({
      profile: LOCAL_PROFILE_ID,
      method,
      subject,
    }) as InsightsProgressRow[];

    const ids = [...new Set(rows.map((row) => row.sessionId))];

    return {
      rows: rows.filter(
        (row) => ids.indexOf(row.sessionId) < PROGRESS_SESSION_LIMIT,
      ),
      limited: ids.length > PROGRESS_SESSION_LIMIT,
    };
  }

  private cohortParams(filter: Filters) {
    return {
      profile: LOCAL_PROFILE_ID,
      method: filter.method ?? null,
      subject: filter.subject ?? null,
    };
  }

  /** Rejects a cursor that no longer belongs to the filtered result set. */
  private assertCursor(
    sql: string,
    filter: Filters,
    extraParams: Record<string, string | null>,
    expiredMessage: string,
  ): void {
    if (!filter.cursor) return;

    const cursorRow = this.db.prepare(sql).get({
      cursor: filter.cursor,
      ...this.cohortParams(filter),
      ...extraParams,
    });

    if (!cursorRow) throw new AppError('INVALID_INPUT', expiredMessage);
  }
}

/** Fetches use `limit + 1` rows; the extra row signals another page. */
function toPage<Row, Item extends { id: string }>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => Item,
): Page<Item> {
  const items = rows.slice(0, limit).map(toItem);
  const hasMore = rows.length > limit;

  return { items, nextCursor: hasMore ? items.at(-1)!.id : null };
}
