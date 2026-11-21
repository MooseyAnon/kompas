import type { SqliteDatabase } from '../../core/db/connection';
import {
  AUDIO_CODEC,
  AUDIO_MEDIA_TYPE,
  type AudioRecording,
  type AudioRecordingState,
} from '../../../shared/contracts';

/**
 * Full internal recording record, including the managed-store-relative path.
 * The `relativePath` stays inside the main process: it is used to resolve,
 * read and remove the managed file and is never returned to the renderer.
 */
export interface AudioRecordingRecord {
  id: string;
  profileId: string;
  state: AudioRecordingState;
  mediaType: string;
  codec: string;
  sampleRate: number;
  channels: number;
  sizeBytes: number;
  durationMs: number;
  relativePath: string;
  sha256: string | null;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AudioRecordingRow {
  id: string;
  profile_id: string;
  state: AudioRecordingState;
  media_type: string;
  codec: string;
  sample_rate: number;
  channels: number;
  size_bytes: number;
  duration_ms: number;
  relative_path: string;
  sha256: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
}

/** Row written when a capture begins finalizing (before the file is committed). */
export interface InsertFinalizingInput {
  id: string;
  profileId: string;
  sampleRate: number;
  channels: number;
  sizeBytes: number;
  durationMs: number;
  relativePath: string;
  label: string | null;
  createdAt: string;
}

/**
 * Audio-owned repository for the `audio_recordings` table. Owns all SQL for that
 * table; the internal `relative_path` is only ever returned to trusted
 * main-process callers via {@link AudioRecordingRecord}, and the public
 * {@link AudioRecording} projection used at the IPC boundary omits it entirely.
 */
export class AudioRepository {
  constructor(private readonly db: SqliteDatabase) {}

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM audio_recordings')
      .get() as { count: number };
    return row.count;
  }

  /** Insert a row in the `finalizing` state; promoted to `ready` once committed. */
  insertFinalizing(input: InsertFinalizingInput): void {
    this.db
      .prepare(
        `INSERT INTO audio_recordings
           (id, profile_id, state, media_type, codec, sample_rate, channels,
            size_bytes, duration_ms, relative_path, sha256, label,
            created_at, updated_at)
         VALUES
           (@id, @profileId, 'finalizing', @mediaType, @codec, @sampleRate,
            @channels, @sizeBytes, @durationMs, @relativePath, NULL, @label,
            @createdAt, @createdAt)`,
      )
      .run({
        ...input,
        mediaType: AUDIO_MEDIA_TYPE,
        codec: AUDIO_CODEC,
      });
  }

  /** Atomically promote a finalizing row to a committed, playable recording. */
  markReady(
    id: string,
    sha256: string,
    sizeBytes: number,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE audio_recordings
           SET state = 'ready', sha256 = @sha256, size_bytes = @sizeBytes,
               updated_at = @updatedAt
         WHERE id = @id AND state = 'finalizing'`,
      )
      .run({ id, sha256, sizeBytes, updatedAt });
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM audio_recordings WHERE id = ?').run(id);
  }

  /** Public listing of committed recordings (newest first); never includes paths. */
  listReady(): AudioRecording[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audio_recordings
         WHERE state = 'ready'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as AudioRecordingRow[];
    return rows.map((row) => toPublicRecording(fromRow(row)));
  }

  /** Internal lookup used to resolve, read or finalize the managed file. */
  get(id: string): AudioRecordingRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM audio_recordings WHERE id = ?')
      .get(id) as AudioRecordingRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** All rows not in the committed `ready` state (used by boot reconciliation). */
  listNotReady(): AudioRecordingRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM audio_recordings WHERE state <> 'ready'`)
      .all() as AudioRecordingRow[];
    return rows.map(fromRow);
  }

  /** Every managed relative path currently referenced by a row. */
  allRelativePaths(): Set<string> {
    const rows = this.db
      .prepare('SELECT relative_path FROM audio_recordings')
      .all() as Array<{ relative_path: string }>;
    return new Set(rows.map((row) => row.relative_path));
  }
}

function fromRow(row: AudioRecordingRow): AudioRecordingRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    state: row.state,
    mediaType: row.media_type,
    codec: row.codec,
    sampleRate: row.sample_rate,
    channels: row.channels,
    sizeBytes: row.size_bytes,
    durationMs: row.duration_ms,
    relativePath: row.relative_path,
    sha256: row.sha256,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map an internal record to the safe public projection (drops the path). */
export function toPublicRecording(
  record: AudioRecordingRecord,
): AudioRecording {
  return {
    id: record.id,
    mediaType: record.mediaType,
    codec: record.codec,
    sampleRate: record.sampleRate,
    channels: record.channels,
    sizeBytes: record.sizeBytes,
    durationMs: record.durationMs,
    label: record.label,
    createdAt: record.createdAt,
  };
}
