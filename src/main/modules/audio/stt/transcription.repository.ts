import type { SqliteDatabase } from '../../../core/db/connection';
import type {
  SttFailureCode,
  SttJob,
  SttJobStatus,
  SttSegment,
  SttTranscript,
} from '../../../../shared/contracts';

interface SttJobRow {
  id: string;
  recording_id: string;
  provider_id: string;
  engine_version: string | null;
  model_id: string | null;
  locale: string | null;
  status: SttJobStatus;
  error_code: SttFailureCode | null;
  transcript_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface SttTranscriptRow {
  id: string;
  job_id: string;
  recording_id: string;
  provider_id: string;
  engine_version: string;
  model_id: string;
  locale: string | null;
  text: string;
  is_empty: number;
  segments_json: string | null;
  created_at: string;
}

export interface InsertJobInput {
  id: string;
  recordingId: string;
  providerId: string;
  engineVersion: string | null;
  modelId: string | null;
  locale: string | null;
  status: SttJobStatus;
  createdAt: string;
  startedAt: string | null;
}

export interface InsertTranscriptInput {
  id: string;
  jobId: string;
  recordingId: string;
  providerId: string;
  engineVersion: string;
  modelId: string;
  locale: string | null;
  text: string;
  empty: boolean;
  segments: SttSegment[] | null;
  createdAt: string;
}

/**
 * Audio-owned repository for the Stage 008.2 speech-to-text tables
 * (`audio_transcription_jobs`, `audio_transcripts`). It owns all SQL for those
 * tables. Transcripts are insert-only (immutable); jobs advance through
 * idempotent, status-guarded transitions.
 */
export class TranscriptionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertJob(input: InsertJobInput): void {
    this.db
      .prepare(
        `INSERT INTO audio_transcription_jobs
           (id, recording_id, provider_id, engine_version, model_id, locale,
            status, error_code, transcript_id, created_at, updated_at,
            started_at, finished_at)
         VALUES
           (@id, @recordingId, @providerId, @engineVersion, @modelId, @locale,
            @status, NULL, NULL, @createdAt, @createdAt, @startedAt, NULL)`,
      )
      .run(input);
  }

  /** Mark a job running; only valid from a non-terminal state. */
  markRunning(id: string, startedAt: string): void {
    this.db
      .prepare(
        `UPDATE audio_transcription_jobs
           SET status = 'running', started_at = COALESCE(started_at, @startedAt),
               updated_at = @startedAt
         WHERE id = @id AND status IN ('queued','running')`,
      )
      .run({ id, startedAt });
  }

  /**
   * Atomically write the immutable transcript and flip the job to `succeeded`.
   * Idempotent: only a still-running/queued job is promoted, so a double
   * completion cannot create two transcripts for one attempt.
   */
  completeWithTranscript(
    transcript: InsertTranscriptInput,
    finishedAt: string,
  ): boolean {
    const tx = this.db.transaction((t: InsertTranscriptInput) => {
      // Promote the job first (guarded), without the transcript link yet, so a
      // double completion cannot create two transcripts for one attempt.
      const promote = this.db
        .prepare(
          `UPDATE audio_transcription_jobs
             SET status = 'succeeded', error_code = NULL,
                 engine_version = @engineVersion, model_id = @modelId,
                 locale = @locale, updated_at = @finishedAt,
                 finished_at = @finishedAt
           WHERE id = @jobId AND status IN ('queued','running')`,
        )
        .run({
          jobId: t.jobId,
          engineVersion: t.engineVersion,
          modelId: t.modelId,
          locale: t.locale,
          finishedAt,
        });
      if (promote.changes !== 1) {
        return false;
      }
      // Insert the immutable transcript (its job now exists), then link it. The
      // insert-before-link order avoids the jobs↔transcripts circular FK.
      this.db
        .prepare(
          `INSERT INTO audio_transcripts
             (id, job_id, recording_id, provider_id, engine_version, model_id,
              locale, text, is_empty, segments_json, created_at)
           VALUES
             (@id, @jobId, @recordingId, @providerId, @engineVersion, @modelId,
              @locale, @text, @isEmpty, @segmentsJson, @createdAt)`,
        )
        .run({
          id: t.id,
          jobId: t.jobId,
          recordingId: t.recordingId,
          providerId: t.providerId,
          engineVersion: t.engineVersion,
          modelId: t.modelId,
          locale: t.locale,
          text: t.text,
          isEmpty: t.empty ? 1 : 0,
          segmentsJson: t.segments ? JSON.stringify(t.segments) : null,
          createdAt: t.createdAt,
        });
      this.db
        .prepare(
          `UPDATE audio_transcription_jobs
             SET transcript_id = @transcriptId
           WHERE id = @jobId`,
        )
        .run({ transcriptId: t.id, jobId: t.jobId });
      return true;
    });
    return tx(transcript) as boolean;
  }

  /** Flip a non-terminal job to a terminal failure/cancel with a safe code. */
  markTerminal(
    id: string,
    status: 'failed' | 'cancelled',
    errorCode: SttFailureCode | null,
    finishedAt: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE audio_transcription_jobs
           SET status = @status, error_code = @errorCode,
               updated_at = @finishedAt, finished_at = @finishedAt
         WHERE id = @id AND status IN ('queued','running')`,
      )
      .run({ id, status, errorCode, finishedAt });
    return result.changes === 1;
  }

  /**
   * Reconcile jobs left `running`/`queued` by an unclean exit to the retryable
   * `interrupted` state. Returns the number reconciled.
   */
  reconcileInterrupted(now: string): number {
    const result = this.db
      .prepare(
        `UPDATE audio_transcription_jobs
           SET status = 'interrupted', error_code = 'process_crashed',
               updated_at = @now, finished_at = @now
         WHERE status IN ('queued','running')`,
      )
      .run({ now });
    return result.changes;
  }

  getJob(id: string): SttJob | undefined {
    const row = this.db
      .prepare('SELECT * FROM audio_transcription_jobs WHERE id = ?')
      .get(id) as SttJobRow | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  listJobs(recordingId?: string): SttJob[] {
    const where = recordingId ? 'WHERE recording_id = ?' : '';
    const params = recordingId ? [recordingId] : [];
    const rows = this.db
      .prepare(
        `SELECT * FROM audio_transcription_jobs
         ${where}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...params) as SttJobRow[];
    return rows.map(jobFromRow);
  }

  getTranscript(id: string): SttTranscript | undefined {
    const row = this.db
      .prepare('SELECT * FROM audio_transcripts WHERE id = ?')
      .get(id) as SttTranscriptRow | undefined;
    return row ? transcriptFromRow(row) : undefined;
  }
}

function jobFromRow(row: SttJobRow): SttJob {
  return {
    id: row.id,
    recordingId: row.recording_id,
    providerId: row.provider_id,
    engineVersion: row.engine_version,
    modelId: row.model_id,
    locale: row.locale,
    status: row.status,
    errorCode: row.error_code,
    transcriptId: row.transcript_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function transcriptFromRow(row: SttTranscriptRow): SttTranscript {
  let segments: SttSegment[] | null = null;
  if (row.segments_json) {
    try {
      const parsed = JSON.parse(row.segments_json) as SttSegment[];
      segments = Array.isArray(parsed) ? parsed : null;
    } catch {
      segments = null;
    }
  }
  return {
    id: row.id,
    jobId: row.job_id,
    recordingId: row.recording_id,
    providerId: row.provider_id,
    engineVersion: row.engine_version,
    modelId: row.model_id,
    locale: row.locale,
    text: row.text,
    empty: row.is_empty === 1,
    segments,
    createdAt: row.created_at,
  };
}
