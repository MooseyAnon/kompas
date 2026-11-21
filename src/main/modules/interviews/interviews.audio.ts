import { AppError } from '../../ipc/errors';

/**
 * Narrow, read-only port into the shared Audio domain that the Interviews
 * module is allowed to use. Interviews only ever learns a stable recording id,
 * a transcript's owning recording id and whether a recording is a committed,
 * ready asset. No filesystem path, provider/engine detail, Whisper/Swift/OS
 * knowledge, model id or spoken text crosses this seam — ADR-008-01 keeps Audio
 * free of any dependency on Interviews, and Interviews free of STT internals.
 *
 * Implementations return `null` for a missing/foreign/non-ready id rather than
 * throwing, so the coordinator can map absence to a stable domain error.
 */
export interface InterviewAudioPort {
  /**
   * The id of a committed, playable recording, or null if not ready/foreign.
   */
  getReadyRecordingId(recordingId: string): string | null;
  /**
   * The owning recording id of a transcript, or null if the transcript is
   * unknown. `undefined` means transcription is not wired in this build.
   */
  getTranscriptRecordingId?(transcriptId: string): string | null;
}

/**
 * Thin interview-domain coordinator over the Audio façade. It validates that a
 * recording/transcript referenced by a renderer-supplied answer link is a real,
 * owned asset before Interviews persists any association — a forged, stale or
 * cross-session id fails closed here, before the answer transaction. It never
 * starts recordings, runs models or reads bytes.
 */
export class InterviewAudioCoordinator {
  constructor(private readonly port: InterviewAudioPort) {}

  /** True when the build can validate transcript ownership. */
  get supportsTranscripts(): boolean {
    return typeof this.port.getTranscriptRecordingId === 'function';
  }

  /**
   * Assert the recording is a committed, ready asset and return its id.
   * Rejects a foreign/unknown/non-ready id with NOT_FOUND so an answer can
   * never be linked to an arbitrary or fabricated recording.
   */
  assertReadyRecording(recordingId: string): string {
    const id = this.port.getReadyRecordingId(recordingId);

    if (!id) {
      throw new AppError(
        'NOT_FOUND',
        'That recording could not be found for this answer.',
      );
    }

    return id;
  }

  /**
   * Assert a transcript exists and belongs to the given recording. This binds
   * the edited answer's source transcript to its recording so a client cannot
   * attach a transcript captured from a different recording or session.
   */
  assertTranscriptForRecording(
    transcriptId: string,
    recordingId: string,
  ): void {
    if (!this.port.getTranscriptRecordingId) {
      throw new AppError(
        'INVALID_INPUT',
        'Speech-to-text is not available in this build.',
      );
    }

    const owner = this.port.getTranscriptRecordingId(transcriptId);

    if (!owner) {
      throw new AppError(
        'NOT_FOUND',
        'That transcript could not be found for this answer.',
      );
    }

    if (owner !== recordingId) {
      throw new AppError(
        'INVALID_INPUT',
        'That transcript does not belong to the selected recording.',
      );
    }
  }
}
