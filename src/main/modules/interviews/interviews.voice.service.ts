import type {
  InterviewAnswerAudio,
  InterviewAnswerDraft,
  InterviewAnswersAudioGetOutput,
  InterviewAnswersDraftClearOutput,
  InterviewAnswersDraftGetOutput,
  InterviewAnswersDraftSaveInput,
  InterviewAnswersDraftSaveOutput,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { TelemetryService } from '../telemetry/telemetry.service';
import type { InterviewAudioCoordinator } from './interviews.audio';
import type {
  AnswerAudioRow,
  InterviewsRepository,
} from './interviews.repository';
import {
  now,
  recordTelemetry,
  sessionNotFound,
  type TelemetryDetail,
  type TelemetryOutcome,
} from './interviews.shared';

export interface InterviewVoiceServiceDeps {
  repository: InterviewsRepository;
  audio?: InterviewAudioCoordinator;
  telemetry?: TelemetryService;
}

/**
 * Crash-safe voice draft and committed-audio reads for the interview runner
 * (stage 008.3). This owns only the correlation between a question and a
 * retained recording plus the user's editable answer-in-progress; it never
 * records, transcribes, scores, or mutates a committed answer. The existing
 * `answers.submit` path remains the single writer of immutable answers.
 */
export class InterviewVoiceService {
  private readonly repository: InterviewsRepository;
  private readonly audio?: InterviewAudioCoordinator;
  private readonly telemetry?: TelemetryService;

  constructor(deps: InterviewVoiceServiceDeps) {
    this.repository = deps.repository;
    this.audio = deps.audio;
    this.telemetry = deps.telemetry;
  }

  /** Read the pending voice draft for a question in an in-progress session. */
  getDraft(
    sessionId: string,
    questionId: string,
  ): InterviewAnswersDraftGetOutput {
    this.assertQuestionInSession(sessionId, questionId);

    const row = this.repository.getAnswerDraft(sessionId, questionId);

    return { draft: row ? this.toDraftView(row) : null };
  }

  /**
   * Persist (upsert) a voice draft. A supplied `recordingId` is validated as a
   * genuine, owned, ready recording via the Audio façade before it is stored,
   * so a forged/stale id fails closed here rather than at submit. `null`
   * explicitly detaches the recording or clears the text; omitted fields are
   * treated as explicit nulls for an idempotent, replace-style save.
   */
  saveDraft(
    input: InterviewAnswersDraftSaveInput,
  ): InterviewAnswersDraftSaveOutput {
    const startedAt = now();

    this.assertQuestionInSession(input.sessionId, input.questionId);

    const recordingId = input.recordingId ?? null;

    if (recordingId !== null) {
      this.assertRecordingUsable(recordingId);
    }

    const draftText = input.draftText ?? null;

    this.repository.saveAnswerDraft({
      sessionId: input.sessionId,
      questionId: input.questionId,
      recordingId,
      draftText,
      now: now(),
    });
    this.record('answers.draft.save', startedAt, 'success', {
      hasRecording: recordingId !== null,
      textLength: draftText?.length ?? 0,
    });

    const saved = this.repository.getAnswerDraft(
      input.sessionId,
      input.questionId,
    );

    if (!saved) {
      throw new AppError('INTERNAL', 'The draft could not be saved.');
    }

    return { draft: this.toDraftView(saved) };
  }

  /** Discard a pending voice draft. The retained recording is left untouched. */
  clearDraft(
    sessionId: string,
    questionId: string,
  ): InterviewAnswersDraftClearOutput {
    this.assertQuestionInSession(sessionId, questionId);
    this.repository.clearAnswerDraft(sessionId, questionId);

    return { cleared: true as const };
  }

  /** The committed, immutable audio link for an answered question, or null. */
  getAudio(
    sessionId: string,
    questionId: string,
  ): InterviewAnswersAudioGetOutput {
    this.assertQuestionInSession(sessionId, questionId);

    const row = this.repository.getAnswerAudio(sessionId, questionId);

    return { audio: row ? this.toAudioView(row) : null };
  }

  private assertQuestionInSession(sessionId: string, questionId: string): void {
    const session = this.repository.getSession(sessionId);

    if (!session) {
      throw sessionNotFound();
    }

    const resolved = this.repository.resolveQuestionRound(
      sessionId,
      questionId,
    );

    if (!resolved) {
      throw new AppError('NOT_FOUND', 'That question could not be found.');
    }
  }

  /** A forged or stale recording id fails closed before it is stored. */
  private assertRecordingUsable(recordingId: string): void {
    if (!this.audio) {
      throw new AppError(
        'INVALID_INPUT',
        'Voice answers are not available in this build.',
      );
    }

    this.audio.assertReadyRecording(recordingId);
  }

  private toDraftView(row: {
    sessionId: string;
    questionId: string;
    recordingId: string | null;
    draftText: string | null;
    updatedAt: string;
  }): InterviewAnswerDraft {
    return {
      sessionId: row.sessionId,
      questionId: row.questionId,
      recordingId: row.recordingId,
      draftText: row.draftText,
      updatedAt: row.updatedAt,
    };
  }

  private toAudioView(row: AnswerAudioRow): InterviewAnswerAudio {
    return {
      answerId: row.answerId,
      recordingId: row.recordingId,
      transcriptId: row.transcriptId,
      createdAt: row.createdAt,
    };
  }

  private record(
    operation: string,
    startedAt: string,
    outcome: TelemetryOutcome,
    detail: TelemetryDetail,
  ): void {
    recordTelemetry(this.telemetry, operation, startedAt, outcome, detail);
  }
}
