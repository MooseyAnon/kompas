import {
  QUICK_FIRE_DEFAULT_COUNT,
  type InterviewSession,
  type InterviewSessionSummary,
  type InterviewSessionPatch,
  type InterviewSessionsCreateInput,
  type InterviewTargetSnapshot,
  type Target,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { TelemetryService } from '../telemetry/telemetry.service';
import {
  isQuickFireCountValid,
  reassessmentChainHasCycle,
} from './interviews.workflow';
import type {
  AnswerRecord,
  InterviewsRepository,
  QuestionRecord,
  ReviewRecord,
  RoundRecord,
  SessionUpdateChanges,
} from './interviews.repository';
import {
  newId,
  now,
  recordTelemetry,
  sessionNotFound,
  type TelemetryDetail,
} from './interviews.shared';

/**
 * Typed read-only interface the interviews domain uses to resolve an approved
 * career target from the identity module. Injected via core wiring — the
 * interviews module never queries identity-owned tables directly or calls back
 * through renderer IPC.
 */
export interface IdentityTargetReader {
  getTarget(id: string): Target | null;
}

export interface InterviewsServiceDeps {
  repository: InterviewsRepository;
  targets: IdentityTargetReader;
  telemetry?: TelemetryService;
}

/**
 * In-process `interviews` domain service. Validates draft-session operations,
 * snapshots approved career-target context at creation (stable thereafter),
 * enforces draft-only mutation and deletion, and records privacy-safe
 * telemetry. No AI, scoring, question generation or coaching is performed in
 * stage 005; the round/question/answer/review writers exist only for tests and
 * a future engine and are not exposed over IPC.
 */
export class InterviewsService {
  private readonly repository: InterviewsRepository;
  private readonly targets: IdentityTargetReader;
  private readonly telemetry?: TelemetryService;

  constructor(deps: InterviewsServiceDeps) {
    this.repository = deps.repository;
    this.targets = deps.targets;
    this.telemetry = deps.telemetry;
  }

  /** Summaries of every interview session. */
  listSessions(): InterviewSessionSummary[] {
    return this.repository.listSummaries();
  }

  /**
   * Read one session. An unpublished quick-fire session hides its bar
   * snapshot.
   */
  getSession(id: string): InterviewSession {
    const session = this.repository.getSession(id);

    if (!session) {
      throw sessionNotFound();
    }

    const hidesBar =
      session.method === 'quick_fire' && !this.repository.getPublication(id);

    return hidesBar ? { ...session, barSnapshot: null } : session;
  }

  /** Create a draft session, snapshotting the approved target if given. */
  createSession(input: InterviewSessionsCreateInput): InterviewSession {
    const startedAt = now();
    const questionCount = resolveCount(input.method, input.questionCount);
    const { careerTargetId, targetSnapshot } = this.resolveTarget(
      input.careerTargetId,
    );

    const session = this.repository.createSession({
      id: newId(),
      careerTargetId,
      targetSnapshot,
      method: input.method,
      subject: input.subject,
      questionCount,
      additionalGuidance: normaliseGuidance(input.additionalGuidance),
      now: startedAt,
    });

    this.record('sessions.create', startedAt, {
      method: session.method,
      hasTarget: careerTargetId !== null,
      questionCount: session.questionCount,
    });

    return this.getSession(session.id);
  }

  /** Apply a patch to an unstarted draft session. */
  updateSession(id: string, patch: InterviewSessionPatch): InterviewSession {
    const startedAt = now();
    const existing = this.requireDraft(id);

    this.assertPreviewNotStale(id, patch);

    const changes = this.buildSessionChanges(existing, patch);
    const session = this.repository.updateSession(id, changes, now());

    this.record('sessions.update', startedAt, {
      method: session.method,
      hasTarget: session.careerTargetId !== null,
      questionCount: session.questionCount,
    });

    return this.getSession(session.id);
  }

  /** Delete an unstarted draft session. */
  deleteSession(id: string): void {
    const startedAt = now();
    const existing = this.requireDraft(id);

    this.repository.deleteSession(id);
    this.record('sessions.delete', startedAt, { method: existing.method });
  }

  // --- internal fixtures (tests / future engine; never an IPC command) ------

  addRound(record: RoundRecord): void {
    if (record.reassessmentOfRoundId) {
      this.assertValidReassessment(
        record.sessionId,
        record.reassessmentOfRoundId,
      );
    }

    this.repository.createRound(record);
  }

  addQuestion(record: QuestionRecord): void {
    this.repository.createQuestion(record);
  }

  addAnswer(record: AnswerRecord): void {
    this.repository.createAnswer(record);
  }

  addReview(record: ReviewRecord): void {
    this.repository.createReview(record);
  }

  // --- internals ------------------------------------------------------------

  private requireDraft(id: string): InterviewSession {
    const session = this.repository.getSession(id);

    if (!session) {
      throw sessionNotFound();
    }

    if (session.status !== 'draft') {
      throw new AppError(
        'CONFLICT',
        'Only unstarted draft interviews can be changed.',
      );
    }

    return session;
  }

  /**
   * A frozen preview reflects the subject/target/guidance at generation time.
   * Block edits that would make it stale rather than silently showing old
   * context; the user must explicitly clear the preview first.
   */
  private assertPreviewNotStale(
    id: string,
    patch: InterviewSessionPatch,
  ): void {
    const changesContext =
      has(patch, 'subject') ||
      has(patch, 'careerTargetId') ||
      has(patch, 'additionalGuidance');

    if (changesContext && this.repository.getPreview(id) !== null) {
      throw new AppError(
        'CONFLICT',
        'Clear the generated question preview before changing the subject, ' +
          'target or guidance.',
      );
    }
  }

  private buildSessionChanges(
    existing: InterviewSession,
    patch: InterviewSessionPatch,
  ): SessionUpdateChanges {
    const changes: SessionUpdateChanges = {};

    if (has(patch, 'subject')) {
      changes.subject = patch.subject;
    }

    if (has(patch, 'questionCount')) {
      changes.questionCount = resolveCount(
        existing.method,
        patch.questionCount,
      );
    }

    if (has(patch, 'careerTargetId')) {
      const resolved = this.resolveTarget(patch.careerTargetId);
      changes.careerTargetId = resolved.careerTargetId;
      changes.targetSnapshot = resolved.targetSnapshot;
    }

    if (has(patch, 'additionalGuidance')) {
      changes.additionalGuidance = normaliseGuidance(patch.additionalGuidance);
    }

    return changes;
  }

  private assertValidReassessment(
    sessionId: string,
    reassessmentOfRoundId: string,
  ): void {
    const targetSession = this.repository.roundSessionId(reassessmentOfRoundId);

    if (targetSession === null) {
      throw new AppError(
        'INVALID_INPUT',
        'The reassessment target round does not exist.',
      );
    }

    if (targetSession !== sessionId) {
      throw new AppError(
        'INVALID_INPUT',
        'A reassessment must stay within the same interview.',
      );
    }

    const formsCycle = reassessmentChainHasCycle(
      reassessmentOfRoundId,
      (roundId) => this.repository.parentRoundId(roundId),
    );

    if (formsCycle) {
      throw new AppError(
        'INVALID_INPUT',
        'That reassessment link would form a cycle.',
      );
    }
  }

  private resolveTarget(careerTargetId: string | null | undefined): {
    careerTargetId: string | null;
    targetSnapshot: InterviewTargetSnapshot | null;
  } {
    if (careerTargetId === undefined || careerTargetId === null) {
      return { careerTargetId: null, targetSnapshot: null };
    }

    const target = this.targets.getTarget(careerTargetId);

    if (!target) {
      throw new AppError(
        'INVALID_INPUT',
        'The selected career target could not be found.',
      );
    }

    return {
      careerTargetId: target.id,
      targetSnapshot: {
        role: target.roleTitle,
        level: target.targetLevel,
        sector: target.sector,
      },
    };
  }

  /** This service only records successful operations. */
  private record(
    operation: string,
    startedAt: string,
    detail: TelemetryDetail,
  ): void {
    recordTelemetry(this.telemetry, operation, startedAt, 'success', detail);
  }
}

function resolveCount(
  method: InterviewSessionsCreateInput['method'],
  requested: number | null | undefined,
): number | null {
  if (method === 'quick_fire') {
    const count = requested ?? QUICK_FIRE_DEFAULT_COUNT;

    if (!isQuickFireCountValid(count)) {
      throw new AppError(
        'INVALID_INPUT',
        'Quick-fire interviews need between 5 and 10 questions.',
      );
    }

    return count;
  }

  if (requested !== null && requested !== undefined) {
    throw new AppError(
      'INVALID_INPUT',
      'Deep-loop interviews do not take a fixed question count.',
    );
  }

  return null;
}

/** Already trimmed by the contract; an empty value means "no guidance". */
function normaliseGuidance(value: string | null | undefined): string | null {
  return value ? value : null;
}

function has<T extends object>(obj: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
