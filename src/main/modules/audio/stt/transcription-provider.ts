import type {
  SttFailureCode,
  SttModelInfo,
} from '../../../../shared/contracts';

/**
 * A recording resolved and validated by the Audio domain into a concrete,
 * on-disk source a provider may read. The absolute path is produced and owned
 * by the Audio domain (never supplied by the renderer); it always points at a
 * genuine canonical 16 kHz mono PCM16 WAV committed by Stage 008.1.
 */
export interface RecordingSource {
  recordingId: string;
  absolutePath: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sizeBytes: number;
}

/**
 * Read-only seam the TranscriptionService uses to turn an opaque recording id
 * into a validated {@link RecordingSource}. Implemented by RecordingService so
 * the transcription orchestrator never touches the filesystem, the recordings
 * table or a renderer-supplied path directly.
 */
export interface RecordingSourceReader {
  /**
   * Resolve a finalized recording to a validated source descriptor. Throws an
   * {@link AppError} (`NOT_FOUND` for unknown/non-ready ids, `IO_ERROR` for a
   * missing/corrupt managed file) so a foreign or invalid id is rejected.
   */
  resolveRecordingSource(recordingId: string): RecordingSource;
}

/** Bounded options a provider accepts for a single transcription. */
export interface TranscriptionOptions {
  /** `auto` to detect, or a 2-letter language code. */
  languageHint: string;
  /** Hard wall-clock ceiling for the operation. */
  timeoutMs: number;
}

/** One timed segment of recognised text (millisecond offsets). */
export interface ProviderSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Normalised provider outcome. A provider NEVER writes database rows or logs;
 * it only transforms a bounded request into one of these typed results. Empty
 * recognised text is a *completed* outcome (`text === ''`), not a failure, so
 * the service can record a truthful empty transcript and still allow retry.
 */
export type TranscriptionOutcome =
  | {
      status: 'completed';
      text: string;
      segments: ProviderSegment[] | null;
      languageDetected: string | null;
      engineVersion: string;
      modelId: string;
      durationMs: number;
    }
  | { status: 'failed'; code: SttFailureCode }
  | { status: 'cancelled' };

/** Capability/readiness snapshot for a provider (safe for the Local AI UI). */
export interface ProviderProbe {
  providerId: string;
  engine: string;
  available: boolean;
  offline: boolean;
  engineVersion: string | null;
  model: SttModelInfo | null;
  /** Populated only when `available` is false. */
  reason: SttFailureCode | null;
  locales: string[];
}

/**
 * Provider-neutral speech-to-text contract (ADR-008-02). Only an adapter knows
 * how to execute its engine; the service treats every provider identically.
 * The interface is deliberately NOT Whisper-shaped — a second fake provider in
 * the tests satisfies the same contract to prove replaceability before the
 * macOS native adapter (008.4).
 */
export interface TranscriptionProvider {
  readonly id: string;
  /** Live capability probe (installed/ready/missing/corrupt). */
  probe(): Promise<ProviderProbe>;
  /**
   * Optional deeper verification (e.g. full content hash). Defaults to `probe`
   * when a provider has nothing extra to check.
   */
  verify?(): Promise<ProviderProbe>;
  /** Transcribe a validated recording source; honour the abort signal. */
  transcribe(
    source: RecordingSource,
    options: TranscriptionOptions,
    signal: AbortSignal,
  ): Promise<TranscriptionOutcome>;
}
