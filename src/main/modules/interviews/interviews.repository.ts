import type { SqliteDatabase } from '../../core/db/connection';
import { LOCAL_PROFILE_ID } from '../../core/db/database';
import type {
  InterviewMethod,
  InterviewSession,
  InterviewSessionSummary,
  InterviewStatus,
  InterviewTargetSnapshot,
} from '../../../shared/contracts';
import { interviewTargetSnapshotSchema } from '../../../shared/contracts';

/** Round lifecycle states (internal; mirrors the DB CHECK). */
export type RoundStatus =
  | 'pending'
  | 'in_progress'
  | 'awaiting_review'
  | 'completed';

export type QuestionKind = 'primary' | 'follow_up';
export type ReviewDecisionValue = 'pass' | 'fail' | 'unscored';

/** Resolved values for creating a new draft session. */
export interface SessionCreateRecord {
  id: string;
  careerTargetId: string | null;
  targetSnapshot: InterviewTargetSnapshot | null;
  method: InterviewMethod;
  subject: string;
  questionCount: number | null;
  /** Normalised guidance; omitted or null means none. */
  additionalGuidance?: string | null;
  now: string;
}

/** Resolved column changes for updating a draft session (present keys only). */
export interface SessionUpdateChanges {
  subject?: string;
  careerTargetId?: string | null;
  targetSnapshot?: InterviewTargetSnapshot | null;
  questionCount?: number | null;
  additionalGuidance?: string | null;
}

/** Internal fixture record for a round (tests / future engine; not an IPC API). */
export interface RoundRecord {
  id: string;
  sessionId: string;
  ordinal: number;
  reassessmentOfRoundId?: string | null;
  status?: RoundStatus;
  now: string;
  completedAt?: string | null;
}

/** Internal fixture record for a question (tests / future engine). */
export interface QuestionRecord {
  id: string;
  roundId: string;
  ordinal: number;
  kind: QuestionKind;
  questionText: string;
  competency?: string | null;
  rubric?: unknown;
  source?: unknown;
  now: string;
}

/** Internal fixture record for an answer (tests / future engine). */
export interface AnswerRecord {
  id: string;
  questionId: string;
  answerText: string;
  now: string;
}

/** Internal fixture record for a review (tests / future engine). */
export interface ReviewRecord {
  id: string;
  roundId: string;
  decision: ReviewDecisionValue;
  score?: number | null;
  feedback: unknown;
  rubricSnapshot?: unknown;
  now: string;
  expectedEpoch?: number;
}

/** A draft's persisted preview question as read back from the repository. */
export interface PreviewRecord {
  roundId: string;
  questionId: string;
  questionText: string;
  competency: string | null;
  rubricJson: string | null;
  sourceJson: string | null;
  createdAt: string;
}

/** Resolved values for atomically persisting one draft preview question. */
export interface PreviewInsertRecord {
  sessionId: string;
  roundId: string;
  questionId: string;
  questionText: string;
  competency: string;
  rubric: unknown;
  source: unknown;
  bar: unknown;
  now: string;
}

/** A deep-loop round with its primary question and (optional) answer. */
export interface DeepLoopRoundRecord {
  roundId: string;
  ordinal: number;
  status: RoundStatus;
  reassessmentOfRoundId: string | null;
  questionId: string;
  questionText: string;
  competency: string | null;
  rubricJson: string | null;
  answerId: string | null;
  answerText: string | null;
  answerCreatedAt: string | null;
}

/** Resolved values for submitting one answer and starting the round/session. */
export interface AnswerSubmitRecord {
  sessionId: string;
  questionId: string;
  answerId: string;
  answerText: string;
  audio?: AnswerAudioLink;
  now: string;
}

/** Outcome of an atomic answer submission. */
export interface AnswerSubmitResult {
  answerId: string;
  roundId: string;
  sessionStatus: InterviewStatus;
  phase: string | null;
}

/** A committed review as read back from the repository. */
export interface ReviewRow {
  id: string;
  roundId: string;
  decision: ReviewDecisionValue;
  score: number | null;
  feedbackJson: string;
  rubricSnapshotJson: string | null;
  createdAt: string;
}

/** A committed coaching record as read back from the repository. */
export interface CoachingRow {
  id: string;
  roundId: string;
  contentJson: string;
  createdAt: string;
}

/** Resolved values for persisting a coaching record. */
export interface CoachingInsertRecord {
  id: string;
  roundId: string;
  content: unknown;
  now: string;
  expectedEpoch?: number;
}

/** Resolved values for atomically persisting one reassessment round. */
export interface ReassessmentInsertRecord {
  sessionId: string;
  failedRoundId: string;
  roundId: string;
  questionId: string;
  questionText: string;
  competency: string;
  rubric: unknown;
  source: unknown;
  now: string;
  expectedEpoch?: number;
}

/** Resolved values for inserting one primary round at a fixed ordinal (007.3). */
export interface PrimaryRoundInsertRecord {
  sessionId: string;
  roundId: string;
  questionId: string;
  ordinal: number;
  questionText: string;
  competency: string;
  rubric: unknown;
  source: unknown;
  now: string;
  expectedEpoch?: number;
}

/** Resolved values for inserting one follow-up question in a round (007.3). */
export interface FollowUpInsertRecord {
  roundId: string;
  questionId: string;
  ordinal: number;
  questionText: string;
  competency: string;
  rubric: unknown;
  source: unknown;
  now: string;
  expectedEpoch?: number;
}

/** Resolved values for committing one answer without lifecycle promotion. */
/** Optional audio association persisted atomically with a committed answer. */
export interface AnswerAudioLink {
  id: string;
  recordingId: string;
  transcriptId: string | null;
}

export interface AnswerCommitRecord {
  roundId: string;
  sessionId: string;
  questionId: string;
  answerId: string;
  answerText: string;
  roundStatus?: RoundStatus;
  audio?: AnswerAudioLink;
  now: string;
}

/** A persisted voice draft row as read back from the repository. */
export interface AnswerDraftRow {
  sessionId: string;
  questionId: string;
  recordingId: string | null;
  draftText: string | null;
  updatedAt: string;
}

/** The immutable committed audio link for an answered question. */
export interface AnswerAudioRow {
  answerId: string;
  recordingId: string;
  transcriptId: string | null;
  createdAt: string;
}

/** A per-round roll-up used to drive the interactive runner and the summary. */
export interface SessionRoundRow {
  roundId: string;
  ordinal: number;
  status: RoundStatus;
  reassessmentOfRoundId: string | null;
  primaryQuestionId: string;
  primaryQuestionText: string;
  competency: string | null;
  primaryAnswered: boolean;
  followUpTotal: number;
  followUpAnswered: number;
  reviewDecision: ReviewDecisionValue | null;
  reviewScore: number | null;
  hasCoaching: boolean;
}

/** A single question with its persisted rubric/provenance, scoped to a session. */
export interface QuestionDetailRow {
  questionId: string;
  roundId: string;
  kind: QuestionKind;
  questionText: string;
  competency: string | null;
  rubricJson: string | null;
  sourceJson: string | null;
  createdAt: string;
}

interface SessionRow {
  id: string;
  profile_id: string;
  career_target_id: string | null;
  target_snapshot_json: string | null;
  method: string;
  subject: string;
  question_count: number | null;
  additional_guidance: string | null;
  status: string;
  phase: string | null;
  bar_snapshot_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  generation_epoch: number;
}

/** Fields shared by every insert of a round with its primary question. */
type PrimaryQuestionInput = Pick<
  PrimaryRoundInsertRecord,
  | 'sessionId'
  | 'roundId'
  | 'questionId'
  | 'questionText'
  | 'competency'
  | 'rubric'
  | 'source'
  | 'now'
>;

const QUESTION_DETAIL_SELECT = `SELECT q.id AS question_id,
                q.round_id AS round_id, q.kind AS kind,
                q.question_text AS question_text, q.competency AS competency,
                q.rubric_json AS rubric_json, q.source_json AS source_json,
                q.created_at AS created_at
           FROM interview_questions q`;

const QUESTION_SESSION_JOINS = `JOIN interview_rounds r ON r.id = q.round_id
           JOIN interview_sessions s ON s.id = r.session_id`;

/**
 * Interviews-owned repository for `interview_sessions` and the supporting
 * `interview_rounds`, `interview_questions`, `interview_answers` and
 * `interview_reviews` tables. Owns all SQL for those tables; no raw handle is
 * exposed. Session reads/writes power the public IPC surface, while the
 * round/question/answer/review writers are internal fixtures for tests and a
 * future inference-backed engine — they are never exported as renderer commands.
 */
export class InterviewsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  // --- sessions -------------------------------------------------------------

  listSummaries(): InterviewSessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM interview_sessions
         WHERE profile_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(LOCAL_PROFILE_ID) as SessionRow[];
    return rows.map(mapSummary);
  }

  getSession(id: string): InterviewSession | null {
    const row = this.findSessionRow(id);
    return row ? mapSession(row) : null;
  }

  getPublication(
    sessionId: string,
  ): { summary: unknown; publishedAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT p.summary_json, p.published_at FROM interview_publications p
       JOIN interview_sessions s ON s.id = p.session_id
       WHERE p.session_id = ? AND s.profile_id = ? AND s.status = 'completed'`,
      )
      .get(sessionId, LOCAL_PROFILE_ID) as
      | { summary_json: string | null; published_at: string }
      | undefined;
    return row
      ? {
          summary: row.summary_json ? safeSnapshotJson(row.summary_json) : null,
          publishedAt: row.published_at,
        }
      : null;
  }

  /** Publish only a complete Quick-fire in the same transaction as its terminal status. */
  publishQuickFire(
    sessionId: string,
    summary: unknown,
    timestamp: string,
    expectedEpoch?: number,
  ): void {
    this.db.transaction(() => {
      const session = this.findSessionRow(sessionId);
      if (
        !session ||
        session.method !== 'quick_fire' ||
        session.status !== 'active'
      )
        throw new Error('Quick-fire is not active');
      this.assertGeneration(sessionId, expectedEpoch);
      const counts = this.db
        .prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS answered,
        SUM(CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END) AS reviewed
        FROM interview_rounds r
        JOIN interview_questions q ON q.round_id = r.id AND q.kind = 'primary'
        LEFT JOIN interview_answers a ON a.question_id = q.id
        LEFT JOIN interview_reviews v ON v.round_id = r.id
        WHERE r.session_id = ?`)
        .get(sessionId) as {
        total: number;
        answered: number;
        reviewed: number;
      };
      if (
        counts.total !== session.question_count ||
        counts.answered !== counts.total ||
        counts.reviewed !== counts.total
      )
        throw new Error('Quick-fire is incomplete');
      this.db
        .prepare(`INSERT INTO interview_publications
          (session_id, summary_json, published_at)
        VALUES (?, ?, ?)`)
        .run(sessionId, JSON.stringify(summary), timestamp);
      this.markSessionStatus(sessionId, 'completed', 'completed', timestamp);
    })();
  }

  /** Lightweight status lookup used to guard draft-only mutations. */
  getSessionStatus(id: string): InterviewStatus | null {
    const row = this.db
      .prepare(
        'SELECT status FROM interview_sessions WHERE id = ? AND profile_id = ?',
      )
      .get(id, LOCAL_PROFILE_ID) as { status: string } | undefined;
    return row ? toInterviewStatus(row.status) : null;
  }

  generationEpoch(sessionId: string): number {
    const session = this.findSessionRow(sessionId);
    if (!session) throw new Error('Interview not found');
    return session.generation_epoch;
  }

  /** Invalidate outstanding generation before aborting its worker/queue entries. */
  invalidateGeneration(sessionId: string, phase?: string): void {
    this.db
      .prepare(`UPDATE interview_sessions
      SET generation_epoch = generation_epoch + 1,
          phase = COALESCE(?, phase), updated_at = ?
      WHERE id = ? AND profile_id = ? AND status = 'active'`)
      .run(
        phase ?? null,
        new Date().toISOString(),
        sessionId,
        LOCAL_PROFILE_ID,
      );
  }

  /** One terminal transition fences all earlier generations in the same write. */
  abandonSession(sessionId: string, now: string): void {
    this.db
      .prepare(`UPDATE interview_sessions
      SET status = 'abandoned', phase = 'abandoned',
          completed_at = COALESCE(completed_at, @now), updated_at = @now,
          generation_epoch = generation_epoch + 1
      WHERE id = @id AND profile_id = @profile
        AND status NOT IN ('completed', 'abandoned')`)
      .run({ now, id: sessionId, profile: LOCAL_PROFILE_ID });
  }

  private assertGeneration(sessionId: string, expectedEpoch?: number): void {
    const session = this.findSessionRow(sessionId);
    if (
      !session ||
      (session.status !== 'active' && session.status !== 'draft') ||
      session.phase?.startsWith('paused') ||
      (expectedEpoch !== undefined &&
        session.generation_epoch !== expectedEpoch)
    ) {
      throw new Error('Interview generation is no longer current');
    }
  }

  createSession(record: SessionCreateRecord): InterviewSession {
    const row: SessionRow = {
      id: record.id,
      profile_id: LOCAL_PROFILE_ID,
      career_target_id: record.careerTargetId,
      target_snapshot_json: stringifyOrNull(record.targetSnapshot),
      method: record.method,
      subject: record.subject,
      question_count: record.questionCount,
      additional_guidance: record.additionalGuidance ?? null,
      status: 'draft',
      phase: null,
      bar_snapshot_json: null,
      created_at: record.now,
      updated_at: record.now,
      started_at: null,
      completed_at: null,
      generation_epoch: 0,
    };
    this.db
      .prepare(
        `INSERT INTO interview_sessions
           (id, profile_id, career_target_id, target_snapshot_json, method,
            subject, question_count, additional_guidance, status, phase,
            bar_snapshot_json, created_at, updated_at, started_at, completed_at)
         VALUES
           (@id, @profile_id, @career_target_id, @target_snapshot_json, @method,
            @subject, @question_count, @additional_guidance, @status, @phase,
            @bar_snapshot_json, @created_at, @updated_at, @started_at,
            @completed_at)`,
      )
      .run(row);
    return mapSession(row);
  }

  updateSession(
    id: string,
    changes: SessionUpdateChanges,
    now: string,
  ): InterviewSession {
    const apply = this.db.transaction((): InterviewSession => {
      const existing = this.findSessionRow(id);
      if (!existing) {
        throw new Error('missing session');
      }
      const next: SessionRow = {
        ...existing,
        subject: has(changes, 'subject')
          ? (changes.subject as string)
          : existing.subject,
        career_target_id: has(changes, 'careerTargetId')
          ? (changes.careerTargetId ?? null)
          : existing.career_target_id,
        target_snapshot_json: has(changes, 'targetSnapshot')
          ? stringifyOrNull(changes.targetSnapshot ?? null)
          : existing.target_snapshot_json,
        question_count: has(changes, 'questionCount')
          ? (changes.questionCount ?? null)
          : existing.question_count,
        additional_guidance: has(changes, 'additionalGuidance')
          ? (changes.additionalGuidance ?? null)
          : existing.additional_guidance,
        updated_at: now,
      };
      this.db
        .prepare(
          `UPDATE interview_sessions
             SET subject = @subject,
                 career_target_id = @career_target_id,
                 target_snapshot_json = @target_snapshot_json,
                 question_count = @question_count,
                 additional_guidance = @additional_guidance,
                 updated_at = @updated_at
           WHERE id = @id AND profile_id = @profile_id`,
        )
        .run(next);
      return mapSession(next);
    });
    return apply();
  }

  deleteSession(id: string): void {
    this.db
      .prepare('DELETE FROM interview_sessions WHERE id = ? AND profile_id = ?')
      .run(id, LOCAL_PROFILE_ID);
  }

  // --- internal fixtures (not exposed over IPC) -----------------------------

  createRound(record: RoundRecord): void {
    this.db
      .prepare(
        `INSERT INTO interview_rounds
           (id, session_id, ordinal, reassessment_of_round_id, status,
            created_at, completed_at)
         VALUES (@id, @session_id, @ordinal, @reassessment_of_round_id,
                 @status, @created_at, @completed_at)`,
      )
      .run({
        id: record.id,
        session_id: record.sessionId,
        ordinal: record.ordinal,
        reassessment_of_round_id: record.reassessmentOfRoundId ?? null,
        status: record.status ?? 'pending',
        created_at: record.now,
        completed_at: record.completedAt ?? null,
      });
  }

  /** The round a given round reassesses, or null (used for cycle detection). */
  parentRoundId(roundId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT reassessment_of_round_id AS parent
           FROM interview_rounds WHERE id = ?`,
      )
      .get(roundId) as { parent: string | null } | undefined;
    return row ? row.parent : null;
  }

  roundSessionId(roundId: string): string | null {
    const row = this.db
      .prepare('SELECT session_id AS s FROM interview_rounds WHERE id = ?')
      .get(roundId) as { s: string } | undefined;
    return row ? row.s : null;
  }

  createQuestion(record: QuestionRecord): void {
    this.db
      .prepare(
        `INSERT INTO interview_questions
           (id, round_id, ordinal, kind, question_text, competency,
            rubric_json, source_json, created_at)
         VALUES (@id, @round_id, @ordinal, @kind, @question_text, @competency,
                 @rubric_json, @source_json, @created_at)`,
      )
      .run({
        id: record.id,
        round_id: record.roundId,
        ordinal: record.ordinal,
        kind: record.kind,
        question_text: record.questionText,
        competency: record.competency ?? null,
        rubric_json: stringifyOrNull(record.rubric),
        source_json: stringifyOrNull(record.source),
        created_at: record.now,
      });
  }

  createAnswer(record: AnswerRecord): void {
    this.db
      .prepare(
        `INSERT INTO interview_answers
           (id, question_id, answer_text, created_at)
         VALUES (@id, @question_id, @answer_text, @created_at)`,
      )
      .run({
        id: record.id,
        question_id: record.questionId,
        answer_text: record.answerText,
        created_at: record.now,
      });
  }

  createReview(record: ReviewRecord): void {
    this.db
      .prepare(
        `INSERT INTO interview_reviews
           (id, round_id, decision, score, feedback_json, rubric_snapshot_json,
            created_at)
         VALUES (@id, @round_id, @decision, @score, @feedback_json,
                 @rubric_snapshot_json, @created_at)`,
      )
      .run({
        id: record.id,
        round_id: record.roundId,
        decision: record.decision,
        score: record.score ?? null,
        feedback_json: JSON.stringify(record.feedback ?? {}),
        rubric_snapshot_json: stringifyOrNull(record.rubricSnapshot),
        created_at: record.now,
      });
  }

  // --- draft question preview (stage 007.1) ---------------------------------

  /**
   * The draft's single primary preview question (lowest-ordinal round), or null.
   * Used both for rendering the preview and for idempotent generation guards.
   */
  getPreview(sessionId: string): PreviewRecord | null {
    const row = this.db
      .prepare(
        `SELECT q.id AS question_id, q.round_id AS round_id,
                q.question_text AS question_text, q.competency AS competency,
                q.rubric_json AS rubric_json, q.source_json AS source_json,
                q.created_at AS created_at
           FROM interview_questions q
           JOIN interview_rounds r ON r.id = q.round_id
           JOIN interview_sessions s ON s.id = r.session_id
          WHERE r.session_id = ? AND s.profile_id = ? AND q.kind = 'primary'
          ORDER BY r.ordinal ASC
          LIMIT 1`,
      )
      .get(sessionId, LOCAL_PROFILE_ID) as
      | {
          question_id: string;
          round_id: string;
          question_text: string;
          competency: string | null;
          rubric_json: string | null;
          source_json: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      questionId: row.question_id,
      roundId: row.round_id,
      questionText: row.question_text,
      competency: row.competency,
      rubricJson: row.rubric_json,
      sourceJson: row.source_json,
      createdAt: row.created_at,
    };
  }

  /** True when the session already has any recorded answer or review. */
  hasRoundActivity(sessionId: string): boolean {
    const answer = this.db
      .prepare(
        `SELECT 1 FROM interview_answers a
           JOIN interview_questions q ON q.id = a.question_id
           JOIN interview_rounds r ON r.id = q.round_id
          WHERE r.session_id = ? LIMIT 1`,
      )
      .get(sessionId);
    if (answer) {
      return true;
    }
    const review = this.db
      .prepare(
        `SELECT 1 FROM interview_reviews rv
           JOIN interview_rounds r ON r.id = rv.round_id
          WHERE r.session_id = ? LIMIT 1`,
      )
      .get(sessionId);
    return Boolean(review);
  }

  /**
   * Atomically persist a draft preview: one preview round, its primary question
   * and rubric/provenance, and (once) the frozen bar snapshot. The round
   * `UNIQUE(session_id, ordinal)` and the partial unique primary-question index
   * reject a concurrent duplicate, so a double click cannot create two primary
   * questions in the same draft slot.
   */
  insertPreview(record: PreviewInsertRecord): void {
    const tx = this.db.transaction(() => {
      const session = this.findSessionRow(record.sessionId);
      if (!session) {
        throw new Error('missing session');
      }
      if (session.status !== 'draft') {
        throw new Error('not draft');
      }
      this.insertRoundWithPrimary(record, { ordinal: 1, status: 'pending' });

      this.db
        .prepare(
          `UPDATE interview_sessions
              SET bar_snapshot_json = COALESCE(bar_snapshot_json, @bar),
                  phase = 'preview',
                  updated_at = @now
            WHERE id = @id AND profile_id = @profile_id`,
        )
        .run({
          bar: JSON.stringify(record.bar),
          now: record.now,
          id: record.sessionId,
          profile_id: LOCAL_PROFILE_ID,
        });
    });
    tx();
  }

  /**
   * Atomically discard a draft's preview: delete its round(s) (cascading to the
   * question) and reset the frozen bar and phase. Returns whether anything was
   * cleared. Callers must ensure no answers/reviews exist first.
   */
  clearPreview(sessionId: string, now: string): boolean {
    const tx = this.db.transaction(() => {
      const deleted = this.db
        .prepare('DELETE FROM interview_rounds WHERE session_id = ?')
        .run(sessionId);
      this.db
        .prepare(
          `UPDATE interview_sessions
              SET bar_snapshot_json = NULL, phase = NULL, updated_at = ?
            WHERE id = ? AND profile_id = ?`,
        )
        .run(now, sessionId, LOCAL_PROFILE_ID);
      return deleted.changes > 0;
    });
    return tx();
  }

  // --- deep-loop review/coaching/reassessment (stage 007.2) -----------------

  /**
   * Resolve the round, question kind and answer-presence for a question within
   * a session (and the local profile). Returns null for cross-session or
   * unknown questions. Used to validate an answer submission precisely.
   */
  resolveQuestionRound(
    sessionId: string,
    questionId: string,
  ): {
    roundId: string;
    kind: QuestionKind;
    hasAnswer: boolean;
  } | null {
    const row = this.db
      .prepare(
        `SELECT r.id AS round_id, q.kind AS kind,
                (a.id IS NOT NULL) AS has_answer
           FROM interview_questions q
           JOIN interview_rounds r ON r.id = q.round_id
           JOIN interview_sessions s ON s.id = r.session_id
           LEFT JOIN interview_answers a ON a.question_id = q.id
          WHERE q.id = ? AND r.session_id = ? AND s.profile_id = ?`,
      )
      .get(questionId, sessionId, LOCAL_PROFILE_ID) as
      | { round_id: string; kind: string; has_answer: number }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      roundId: row.round_id,
      kind: toQuestionKind(row.kind),
      hasAnswer: row.has_answer === 1,
    };
  }

  /**
   * Load a deep-loop round scoped to a session (and the local profile): its
   * primary question plus the submitted answer, if any. Returns null when the
   * round does not exist for this session (mapped to NOT_FOUND by the service),
   * which also guards against cross-session access.
   */
  getDeepLoopRound(
    sessionId: string,
    roundId: string,
  ): DeepLoopRoundRecord | null {
    const row = this.db
      .prepare(
        `SELECT r.id AS round_id, r.ordinal AS ordinal, r.status AS status,
                r.reassessment_of_round_id AS reassessment_of_round_id,
                q.id AS question_id, q.question_text AS question_text,
                q.competency AS competency, q.rubric_json AS rubric_json,
                a.id AS answer_id, a.answer_text AS answer_text,
                a.created_at AS answer_created_at
           FROM interview_rounds r
           JOIN interview_sessions s ON s.id = r.session_id
           JOIN interview_questions q
             ON q.round_id = r.id AND q.kind = 'primary'
           LEFT JOIN interview_answers a ON a.question_id = q.id
          WHERE r.id = ? AND r.session_id = ? AND s.profile_id = ?`,
      )
      .get(roundId, sessionId, LOCAL_PROFILE_ID) as
      | {
          round_id: string;
          ordinal: number;
          status: string;
          reassessment_of_round_id: string | null;
          question_id: string;
          question_text: string;
          competency: string | null;
          rubric_json: string | null;
          answer_id: string | null;
          answer_text: string | null;
          answer_created_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      roundId: row.round_id,
      ordinal: row.ordinal,
      status: toRoundStatus(row.status),
      reassessmentOfRoundId: row.reassessment_of_round_id,
      questionId: row.question_id,
      questionText: row.question_text,
      competency: row.competency,
      rubricJson: row.rubric_json,
      answerId: row.answer_id,
      answerText: row.answer_text,
      answerCreatedAt: row.answer_created_at,
    };
  }

  /**
   * Atomically persist one answer and advance state: the answer is committed
   * (unique per question), the round moves to `awaiting_review`, and a `draft`
   * session is promoted to `active`/`deep_loop` with a `started_at`. The unique
   * `interview_answers.question_id` constraint rejects a duplicate submission,
   * so a double click cannot overwrite history or create a second answer.
   */
  submitAnswer(record: AnswerSubmitRecord): AnswerSubmitResult {
    const tx = this.db.transaction((): AnswerSubmitResult => {
      const round = this.db
        .prepare(
          `SELECT r.id AS round_id, r.session_id AS session_id,
                  s.status AS status, s.phase AS phase,
                  s.started_at AS started_at
             FROM interview_questions q
             JOIN interview_rounds r ON r.id = q.round_id
             JOIN interview_sessions s ON s.id = r.session_id
            WHERE q.id = ? AND s.profile_id = ?`,
        )
        .get(record.questionId, LOCAL_PROFILE_ID) as
        | {
            round_id: string;
            session_id: string;
            status: string;
            phase: string | null;
            started_at: string | null;
          }
        | undefined;
      if (!round || round.session_id !== record.sessionId) {
        throw new Error('missing question');
      }
      if (
        (round.status !== 'active' && round.status !== 'draft') ||
        round.phase?.startsWith('paused')
      )
        throw new Error('Interview is not accepting answers');

      this.createAnswer({
        id: record.answerId,
        questionId: record.questionId,
        answerText: record.answerText,
        now: record.now,
      });

      this.db
        .prepare(
          `UPDATE interview_rounds
              SET status = 'awaiting_review'
            WHERE id = ? AND status <> 'completed'`,
        )
        .run(round.round_id);

      this.linkAnswerAudio({
        sessionId: record.sessionId,
        questionId: record.questionId,
        answerId: record.answerId,
        audio: record.audio,
        now: record.now,
      });

      let sessionStatus = toInterviewStatus(round.status);
      let phase = round.phase;
      if (round.status === 'draft') {
        sessionStatus = 'active';
        phase = 'deep_loop';
        this.db
          .prepare(
            `UPDATE interview_sessions
                SET status = 'active', phase = 'deep_loop',
                    started_at = COALESCE(started_at, @now), updated_at = @now
              WHERE id = @id AND profile_id = @profile_id`,
          )
          .run({
            now: record.now,
            id: record.sessionId,
            profile_id: LOCAL_PROFILE_ID,
          });
      }
      return {
        answerId: record.answerId,
        roundId: round.round_id,
        sessionStatus,
        phase,
      };
    });
    return tx();
  }

  /** The committed review for a round, or null. */
  getReviewByRound(roundId: string): ReviewRow | null {
    const row = this.db
      .prepare(
        `SELECT id, round_id, decision, score, feedback_json,
                rubric_snapshot_json, created_at
           FROM interview_reviews WHERE round_id = ?`,
      )
      .get(roundId) as
      | {
          id: string;
          round_id: string;
          decision: string;
          score: number | null;
          feedback_json: string;
          rubric_snapshot_json: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      roundId: row.round_id,
      decision: toReviewDecision(row.decision),
      score: row.score,
      feedbackJson: row.feedback_json,
      rubricSnapshotJson: row.rubric_snapshot_json,
      createdAt: row.created_at,
    };
  }

  /**
   * Persist a review and mark the round completed in one transaction. The
   * unique `interview_reviews.round_id` key means a replay/retry cannot create
   * a second review for the same round.
   */
  insertReview(record: ReviewRecord): void {
    const tx = this.db.transaction(() => {
      const session = this.db
        .prepare(`SELECT s.status, s.method FROM interview_sessions s
        JOIN interview_rounds r ON r.session_id = s.id
        WHERE r.id = ? AND s.profile_id = ?`)
        .get(record.roundId, LOCAL_PROFILE_ID) as
        | { status: string; method: string }
        | undefined;
      if (
        !session ||
        (session.method === 'quick_fire' && session.status !== 'active')
      )
        throw new Error('Session no longer accepts reviews');
      this.assertGeneration(
        this.roundSessionId(record.roundId)!,
        record.expectedEpoch,
      );
      this.createReview(record);
      this.db
        .prepare(
          `UPDATE interview_rounds SET status = 'completed', completed_at = ?
            WHERE id = ?`,
        )
        .run(record.now, record.roundId);
    });
    tx();
  }

  /** The committed coaching for a round, or null. */
  getCoachingByRound(roundId: string): CoachingRow | null {
    const row = this.db
      .prepare(
        `SELECT id, round_id, content_json, created_at
           FROM interview_coaching WHERE round_id = ?`,
      )
      .get(roundId) as
      | {
          id: string;
          round_id: string;
          content_json: string;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      roundId: row.round_id,
      contentJson: row.content_json,
      createdAt: row.created_at,
    };
  }

  /** Persist a coaching record (unique per round). */
  insertCoaching(record: CoachingInsertRecord): void {
    this.db.transaction(() => {
      const sessionId = this.roundSessionId(record.roundId);
      if (!sessionId) throw new Error('Interview round not found');
      this.assertGeneration(sessionId, record.expectedEpoch);
      this.db
        .prepare(
          `INSERT INTO interview_coaching
           (id, round_id, content_json, created_at)
         VALUES (@id, @round_id, @content_json, @created_at)`,
        )
        .run({
          id: record.id,
          round_id: record.roundId,
          content_json: JSON.stringify(record.content ?? {}),
          created_at: record.now,
        });
    })();
  }

  /**
   * Number of reassessment links between a round and the original question
   * (root has depth 0, its first reassessment depth 1, and so on). Walks the
   * `reassessment_of_round_id` chain and stops if a cycle is detected.
   */
  reassessmentDepth(roundId: string): number {
    let depth = 0;
    const seen = new Set<string>();
    let current: string | null = roundId;
    while (current !== null) {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
      const parent = this.parentRoundId(current);
      if (parent === null) {
        break;
      }
      depth += 1;
      current = parent;
    }
    return depth;
  }

  /** The highest round ordinal in a session, or 0 when none exist. */
  maxRoundOrdinal(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), 0) AS ordinal
           FROM interview_rounds WHERE session_id = ?`,
      )
      .get(sessionId) as { ordinal: number };
    return row.ordinal;
  }

  /** The stored primary question texts for a session (for dedupe checks). */
  listPrimaryQuestionTexts(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT q.question_text AS text
           FROM interview_questions q
           JOIN interview_rounds r ON r.id = q.round_id
          WHERE r.session_id = ? AND q.kind = 'primary'`,
      )
      .all(sessionId) as Array<{ text: string }>;
    return rows.map((r) => r.text);
  }

  /**
   * Atomically persist a reassessment: a new round linked to the failed round
   * via `reassessment_of_round_id`, plus its new primary question. The
   * `UNIQUE(session_id, ordinal)` and the partial unique primary index reject a
   * concurrent duplicate.
   */
  insertReassessment(record: ReassessmentInsertRecord): void {
    const tx = this.db.transaction(() => {
      this.assertGeneration(record.sessionId, record.expectedEpoch);
      const parent = this.db
        .prepare(`SELECT 1 FROM interview_rounds r
        JOIN interview_reviews v ON v.round_id = r.id AND v.decision = 'fail'
        JOIN interview_coaching c ON c.round_id = r.id
        WHERE r.id = ? AND r.session_id = ?`)
        .get(record.failedRoundId, record.sessionId);
      if (
        !parent ||
        this.db
          .prepare(`SELECT 1 FROM interview_rounds
        WHERE reassessment_of_round_id = ?`)
          .get(record.failedRoundId)
      )
        throw new Error('Reassessment is no longer available');

      this.insertRoundWithPrimary(record, {
        ordinal: this.maxRoundOrdinal(record.sessionId) + 1,
        reassessmentOfRoundId: record.failedRoundId,
        status: 'in_progress',
      });
    });
    tx();
  }

  // --- interactive session runner (stage 007.3) -----------------------------

  /** Freeze the session bar once (no-op if already frozen) and set a phase. */
  freezeBarAndPhase(
    sessionId: string,
    bar: unknown,
    phase: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE interview_sessions
            SET bar_snapshot_json = COALESCE(bar_snapshot_json, @bar),
                phase = @phase,
                updated_at = @now
          WHERE id = @id AND profile_id = @profile_id`,
      )
      .run({
        bar: JSON.stringify(bar),
        phase,
        now,
        id: sessionId,
        profile_id: LOCAL_PROFILE_ID,
      });
  }

  /** Set the durable phase on a session. */
  setPhase(
    sessionId: string,
    phase: string,
    now: string,
    expectedEpoch?: number,
  ): void {
    this.db
      .prepare(
        `UPDATE interview_sessions SET phase = @phase, updated_at = @now
           WHERE id = @id AND profile_id = @profile AND status = 'active'
             AND phase NOT LIKE 'paused%'
             AND (@epoch IS NULL OR generation_epoch = @epoch)`,
      )
      .run({
        phase,
        now,
        id: sessionId,
        profile: LOCAL_PROFILE_ID,
        epoch: expectedEpoch ?? null,
      });
  }

  /**
   * Transition a session's status/phase. Promotes `started_at` on first
   * activation and records `completed_at` for terminal statuses. Idempotent and
   * never erases submitted answers.
   */
  markSessionStatus(
    sessionId: string,
    status: InterviewStatus,
    phase: string,
    now: string,
  ): void {
    const terminal = status === 'completed' || status === 'abandoned';
    this.db
      .prepare(
        `UPDATE interview_sessions
            SET status = @status,
                phase = @phase,
                started_at = CASE WHEN @status = 'active'
                                  THEN COALESCE(started_at, @now)
                                  ELSE started_at END,
                completed_at = CASE WHEN @terminal = 1
                                    THEN COALESCE(completed_at, @now)
                                    ELSE completed_at END,
                updated_at = @now
           WHERE id = @id AND profile_id = @profile_id
             AND status NOT IN ('completed', 'abandoned')`,
      )
      .run({
        status,
        phase,
        now,
        terminal: terminal ? 1 : 0,
        id: sessionId,
        profile_id: LOCAL_PROFILE_ID,
      });
  }

  /**
   * Atomically insert one primary round at a fixed ordinal with its primary
   * question. The `UNIQUE(session_id, ordinal)` key and the partial unique
   * primary index make a racing duplicate a no-op the caller treats as success.
   */
  insertPrimaryRound(record: PrimaryRoundInsertRecord): void {
    const tx = this.db.transaction(() => {
      this.assertGeneration(record.sessionId, record.expectedEpoch);
      const session = this.findSessionRow(record.sessionId);
      if (
        !session ||
        session.status !== 'active' ||
        (session.method === 'quick_fire' &&
          record.ordinal > (session.question_count ?? 0))
      )
        throw new Error('Session no longer accepts questions');

      this.insertRoundWithPrimary(record, {
        ordinal: record.ordinal,
        status: 'pending',
      });
    });
    tx();
  }

  /** Insert one follow-up question in a round (ordinal is next free slot). */
  insertFollowUp(record: FollowUpInsertRecord): void {
    this.db.transaction(() => {
      const sessionId = this.roundSessionId(record.roundId);
      if (!sessionId) throw new Error('Interview round not found');
      this.assertGeneration(sessionId, record.expectedEpoch);
      if (
        this.countFollowUps(record.roundId) >= 1 ||
        this.getReviewByRound(record.roundId)
      )
        throw new Error('Follow-up is no longer available');
      this.createQuestion({
        id: record.questionId,
        roundId: record.roundId,
        ordinal: record.ordinal,
        kind: 'follow_up',
        questionText: record.questionText,
        competency: record.competency,
        rubric: record.rubric,
        source: record.source,
        now: record.now,
      });
    })();
  }

  /** The next free question ordinal within a round (>= 2 for follow-ups). */
  nextQuestionOrdinal(roundId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), 0) AS ordinal
           FROM interview_questions WHERE round_id = ?`,
      )
      .get(roundId) as { ordinal: number };
    return row.ordinal + 1;
  }

  /** Count the follow-up questions in a round. */
  countFollowUps(roundId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM interview_questions
          WHERE round_id = ? AND kind = 'follow_up'`,
      )
      .get(roundId) as { n: number };
    return row.n;
  }

  /**
   * Commit one answer to any question (primary or follow-up) without lifecycle
   * promotion. The unique `interview_answers.question_id` key rejects a
   * duplicate, so a double submit cannot create a second answer.
   */
  commitAnswer(record: AnswerCommitRecord): void {
    const tx = this.db.transaction(() => {
      const session = this.findSessionRow(record.sessionId);
      if (
        !session ||
        session.status !== 'active' ||
        session.phase?.startsWith('paused')
      )
        throw new Error('Interview is not accepting answers');
      this.createAnswer({
        id: record.answerId,
        questionId: record.questionId,
        answerText: record.answerText,
        now: record.now,
      });
      if (record.roundStatus) {
        this.db
          .prepare(
            `UPDATE interview_rounds SET status = ?
              WHERE id = ? AND status <> 'completed'`,
          )
          .run(record.roundStatus, record.roundId);
      }
      this.linkAnswerAudio({
        sessionId: record.sessionId,
        questionId: record.questionId,
        answerId: record.answerId,
        audio: record.audio,
        now: record.now,
      });
    });
    tx();
  }

  /**
   * Within an open answer-commit transaction: persist the optional immutable
   * audio association for the new answer and discard any pending voice draft for
   * the question. The caller has already validated recording/transcript
   * ownership via the Audio façade; the `interview_answer_audio.answer_id`
   * UNIQUE key makes a retried/double submit idempotent (never two links).
   */
  private linkAnswerAudio(input: {
    sessionId: string;
    questionId: string;
    answerId: string;
    audio?: AnswerAudioLink;
    now: string;
  }): void {
    if (input.audio) {
      this.db
        .prepare(
          `INSERT INTO interview_answer_audio
             (id, answer_id, session_id, question_id, recording_id,
              transcript_id, created_at)
           VALUES (@id, @answer_id, @session_id, @question_id, @recording_id,
                   @transcript_id, @created_at)`,
        )
        .run({
          id: input.audio.id,
          answer_id: input.answerId,
          session_id: input.sessionId,
          question_id: input.questionId,
          recording_id: input.audio.recordingId,
          transcript_id: input.audio.transcriptId,
          created_at: input.now,
        });
    }
    // The pending draft is consumed by the commit regardless of audio presence;
    // the underlying recording (if any) is retained independently.
    this.db
      .prepare(
        `DELETE FROM interview_answer_drafts
          WHERE session_id = ? AND question_id = ?`,
      )
      .run(input.sessionId, input.questionId);
  }

  // --- voice drafts + committed audio links (stage 008.3) -------------------

  /** The persisted voice draft for a (session, question), or null. */
  getAnswerDraft(sessionId: string, questionId: string): AnswerDraftRow | null {
    const row = this.db
      .prepare(
        `SELECT d.session_id AS session_id, d.question_id AS question_id,
                d.recording_id AS recording_id, d.draft_text AS draft_text,
                d.updated_at AS updated_at
           FROM interview_answer_drafts d
           JOIN interview_sessions s ON s.id = d.session_id
          WHERE d.session_id = ? AND d.question_id = ? AND s.profile_id = ?`,
      )
      .get(sessionId, questionId, LOCAL_PROFILE_ID) as
      | {
          session_id: string;
          question_id: string;
          recording_id: string | null;
          draft_text: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      sessionId: row.session_id,
      questionId: row.question_id,
      recordingId: row.recording_id,
      draftText: row.draft_text,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Upsert the voice draft for a (session, question). The caller validates that
   * the question belongs to the session and that any `recordingId` is a genuine
   * ready recording before persisting, so a forged id never reaches this row.
   */
  saveAnswerDraft(record: {
    sessionId: string;
    questionId: string;
    recordingId: string | null;
    draftText: string | null;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO interview_answer_drafts
           (session_id, question_id, recording_id, draft_text, updated_at)
         VALUES (@session_id, @question_id, @recording_id, @draft_text, @now)
         ON CONFLICT(session_id, question_id) DO UPDATE SET
           recording_id = excluded.recording_id,
           draft_text = excluded.draft_text,
           updated_at = excluded.updated_at`,
      )
      .run({
        session_id: record.sessionId,
        question_id: record.questionId,
        recording_id: record.recordingId,
        draft_text: record.draftText,
        now: record.now,
      });
  }

  /** Discard a pending voice draft; the retained recording is untouched. */
  clearAnswerDraft(sessionId: string, questionId: string): void {
    this.db
      .prepare(
        `DELETE FROM interview_answer_drafts
          WHERE session_id = ? AND question_id = ?`,
      )
      .run(sessionId, questionId);
  }

  /** The committed immutable audio link for a (session, question), or null. */
  getAnswerAudio(sessionId: string, questionId: string): AnswerAudioRow | null {
    const row = this.db
      .prepare(
        `SELECT aa.answer_id AS answer_id, aa.recording_id AS recording_id,
                aa.transcript_id AS transcript_id, aa.created_at AS created_at
           FROM interview_answer_audio aa
           JOIN interview_sessions s ON s.id = aa.session_id
          WHERE aa.session_id = ? AND aa.question_id = ? AND s.profile_id = ?`,
      )
      .get(sessionId, questionId, LOCAL_PROFILE_ID) as
      | {
          answer_id: string;
          recording_id: string;
          transcript_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      answerId: row.answer_id,
      recordingId: row.recording_id,
      transcriptId: row.transcript_id,
      createdAt: row.created_at,
    };
  }

  /** A per-round roll-up (ordered by ordinal) powering the runner and summary. */
  listSessionRounds(sessionId: string): SessionRoundRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.id AS round_id, r.ordinal AS ordinal, r.status AS status,
                r.reassessment_of_round_id AS reassessment_of,
                pq.id AS primary_question_id,
                pq.question_text AS primary_question_text,
                pq.competency AS competency,
                (SELECT COUNT(*) FROM interview_answers a
                   JOIN interview_questions q2 ON q2.id = a.question_id
                  WHERE q2.round_id = r.id AND q2.kind = 'primary')
                  AS primary_answered,
                (SELECT COUNT(*) FROM interview_questions q3
                  WHERE q3.round_id = r.id AND q3.kind = 'follow_up')
                  AS follow_up_total,
                (SELECT COUNT(*) FROM interview_answers a2
                   JOIN interview_questions q4 ON q4.id = a2.question_id
                  WHERE q4.round_id = r.id AND q4.kind = 'follow_up')
                  AS follow_up_answered,
                rv.decision AS review_decision, rv.score AS review_score,
                (SELECT COUNT(*) FROM interview_coaching c
                  WHERE c.round_id = r.id) AS coaching_count
           FROM interview_rounds r
           JOIN interview_sessions s ON s.id = r.session_id
           JOIN interview_questions pq
             ON pq.round_id = r.id AND pq.kind = 'primary'
           LEFT JOIN interview_reviews rv ON rv.round_id = r.id
          WHERE r.session_id = ? AND s.profile_id = ?
          ORDER BY r.ordinal ASC`,
      )
      .all(sessionId, LOCAL_PROFILE_ID) as Array<{
      round_id: string;
      ordinal: number;
      status: string;
      reassessment_of: string | null;
      primary_question_id: string;
      primary_question_text: string;
      competency: string | null;
      primary_answered: number;
      follow_up_total: number;
      follow_up_answered: number;
      review_decision: string | null;
      review_score: number | null;
      coaching_count: number;
    }>;
    return rows.map((row) => ({
      roundId: row.round_id,
      ordinal: row.ordinal,
      status: toRoundStatus(row.status),
      reassessmentOfRoundId: row.reassessment_of,
      primaryQuestionId: row.primary_question_id,
      primaryQuestionText: row.primary_question_text,
      competency: row.competency,
      primaryAnswered: row.primary_answered > 0,
      followUpTotal: row.follow_up_total,
      followUpAnswered: row.follow_up_answered,
      reviewDecision:
        row.review_decision === null
          ? null
          : toReviewDecision(row.review_decision),
      reviewScore: row.review_score,
      hasCoaching: row.coaching_count > 0,
    }));
  }

  /** The first unanswered follow-up question in a round, or null. */
  getUnansweredFollowUp(roundId: string): QuestionDetailRow | null {
    const row = this.db
      .prepare(
        `${QUESTION_DETAIL_SELECT}
           LEFT JOIN interview_answers a ON a.question_id = q.id
          WHERE q.round_id = ? AND q.kind = 'follow_up' AND a.id IS NULL
          ORDER BY q.ordinal ASC LIMIT 1`,
      )
      .get(roundId) as QuestionDetailRaw | undefined;

    return row ? mapQuestionDetail(row) : null;
  }

  /** One question (any kind) scoped to a session, with rubric/provenance. */
  getQuestionDetail(
    sessionId: string,
    questionId: string,
  ): QuestionDetailRow | null {
    const row = this.db
      .prepare(
        `${QUESTION_DETAIL_SELECT}
           ${QUESTION_SESSION_JOINS}
          WHERE q.id = ? AND r.session_id = ? AND s.profile_id = ?`,
      )
      .get(questionId, sessionId, LOCAL_PROFILE_ID) as
      | QuestionDetailRaw
      | undefined;

    return row ? mapQuestionDetail(row) : null;
  }

  /** The primary question detail for a round, scoped to a session. */
  getPrimaryQuestionDetail(
    sessionId: string,
    roundId: string,
  ): QuestionDetailRow | null {
    const row = this.db
      .prepare(
        `${QUESTION_DETAIL_SELECT}
           ${QUESTION_SESSION_JOINS}
          WHERE r.id = ? AND r.session_id = ? AND s.profile_id = ?
            AND q.kind = 'primary'`,
      )
      .get(roundId, sessionId, LOCAL_PROFILE_ID) as
      | QuestionDetailRaw
      | undefined;

    return row ? mapQuestionDetail(row) : null;
  }

  /** All question/answer pairs in a round, ordered, for review context. */
  listRoundQnA(
    roundId: string,
  ): Array<{ kind: QuestionKind; question: string; answer: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT q.kind AS kind, q.question_text AS question_text,
                a.answer_text AS answer_text
           FROM interview_questions q
           LEFT JOIN interview_answers a ON a.question_id = q.id
          WHERE q.round_id = ?
          ORDER BY q.ordinal ASC`,
      )
      .all(roundId) as Array<{
      kind: string;
      question_text: string;
      answer_text: string | null;
    }>;
    return rows.map((r) => ({
      kind: toQuestionKind(r.kind),
      question: r.question_text,
      answer: r.answer_text,
    }));
  }

  // --- internals ------------------------------------------------------------

  /** Insert a round and its primary question (always question ordinal 1). */
  private insertRoundWithPrimary(
    record: PrimaryQuestionInput,
    round: Pick<RoundRecord, 'ordinal' | 'reassessmentOfRoundId' | 'status'>,
  ): void {
    this.createRound({
      id: record.roundId,
      sessionId: record.sessionId,
      ...round,
      now: record.now,
    });

    this.createQuestion({
      id: record.questionId,
      roundId: record.roundId,
      ordinal: 1,
      kind: 'primary',
      questionText: record.questionText,
      competency: record.competency,
      rubric: record.rubric,
      source: record.source,
      now: record.now,
    });
  }

  private findSessionRow(id: string): SessionRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM interview_sessions WHERE id = ? AND profile_id = ?',
      )
      .get(id, LOCAL_PROFILE_ID) as SessionRow | undefined;
  }
}

function has<T extends object>(obj: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

interface QuestionDetailRaw {
  question_id: string;
  round_id: string;
  kind: string;
  question_text: string;
  competency: string | null;
  rubric_json: string | null;
  source_json: string | null;
  created_at: string;
}

function mapQuestionDetail(row: QuestionDetailRaw): QuestionDetailRow {
  return {
    questionId: row.question_id,
    roundId: row.round_id,
    kind: toQuestionKind(row.kind),
    questionText: row.question_text,
    competency: row.competency,
    rubricJson: row.rubric_json,
    sourceJson: row.source_json,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow): InterviewSession {
  return {
    id: row.id,
    method: toInterviewMethod(row.method),
    subject: row.subject,
    careerTargetId: row.career_target_id,
    targetSnapshot: parseSnapshot(row.target_snapshot_json),
    questionCount: row.question_count,
    additionalGuidance: row.additional_guidance,
    status: toInterviewStatus(row.status),
    phase: row.phase,
    barSnapshot: row.bar_snapshot_json
      ? safeSnapshotJson(row.bar_snapshot_json)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapSummary(row: SessionRow): InterviewSessionSummary {
  const snapshot = parseSnapshot(row.target_snapshot_json);
  return {
    id: row.id,
    method: toInterviewMethod(row.method),
    subject: row.subject,
    status: toInterviewStatus(row.status),
    questionCount: row.question_count,
    targetRole: snapshot ? snapshot.role : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- row value parsers -----------------------------------------------------

// Values come from columns guarded by DB CHECK constraints. These parsers only
// narrow the type and pass any unexpected value through unchanged.

function toInterviewMethod(value: string): InterviewMethod {
  return value as InterviewMethod;
}

function toInterviewStatus(value: string): InterviewStatus {
  return value as InterviewStatus;
}

function toRoundStatus(value: string): RoundStatus {
  return value as RoundStatus;
}

function toQuestionKind(value: string): QuestionKind {
  return value as QuestionKind;
}

function toReviewDecision(value: string): ReviewDecisionValue {
  return value as ReviewDecisionValue;
}

// --- JSON helpers -----------------------------------------------------------

/** `null`/`undefined` are stored as SQL NULL; everything else as JSON text. */
function stringifyOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** A validated target snapshot, or null when absent, malformed or invalid. */
function parseSnapshot(json: string | null): InterviewTargetSnapshot | null {
  if (json === null) {
    return null;
  }
  try {
    const parsed = interviewTargetSnapshotSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Any parsed JSON value, or null when the text is malformed. */
function safeSnapshotJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
