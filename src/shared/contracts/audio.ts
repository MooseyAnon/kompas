import { z } from 'zod';

/** Public API major version for the shared `audio` module. */
export const AUDIO_API_VERSION = 1;

export const AUDIO_MODULE_ID = 'audio';

/**
 * Canonical capture/storage format for Stage 008.1: 16 kHz, mono, signed 16-bit
 * little-endian PCM wrapped in a RIFF/WAVE container. This is directly accepted
 * by the pinned `whisper-cli` (ADR-008-02) so no later transcoding seam is
 * required. The renderer downsamples its microphone stream to this format and
 * uploads raw PCM16 frames; the main process wraps the committed bytes in a WAV
 * header on finalization.
 */
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_BITS_PER_SAMPLE = 16;
export const AUDIO_MEDIA_TYPE = 'audio/wav';
export const AUDIO_CODEC = 'pcm_s16le';

/**
 * Bytes of raw PCM accepted per upload frame (base64 of this stays < 64 KiB).
 */
export const AUDIO_MAX_CHUNK_BYTES = 32 * 1024;

/** Hard ceiling on a single recording's duration and raw PCM byte count. */
export const AUDIO_MAX_DURATION_MS = 5 * 60 * 1000;
export const AUDIO_MAX_RECORDING_BYTES =
  (AUDIO_SAMPLE_RATE *
    AUDIO_CHANNELS *
    (AUDIO_BITS_PER_SAMPLE / 8) *
    AUDIO_MAX_DURATION_MS) /
  1000;

/** Bytes of stored audio returned per playback read frame. */
export const AUDIO_PLAYBACK_MAX_READ_BYTES = 32 * 1024;

/** Base64 string bound: a little above base64(AUDIO_MAX_CHUNK_BYTES). */
const MAX_BASE64_LENGTH = Math.ceil((AUDIO_MAX_CHUNK_BYTES / 3) * 4) + 8;

const base64Schema = z
  .string()
  .max(MAX_BASE64_LENGTH)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u, 'Expected base64-encoded bytes.');

const captureIdSchema = z.string().uuid();
const tokenSchema = z.string().min(16).max(128);
const labelSchema = z.string().trim().min(1).max(200);

export const AUDIO_RECORDING_STATES = [
  'finalizing',
  'ready',
  'failed',
] as const;
export const audioRecordingStateSchema = z.enum(AUDIO_RECORDING_STATES);
export type AudioRecordingState = (typeof AUDIO_RECORDING_STATES)[number];

/**
 * Safe public projection of an `audio_recordings` row. Only committed (`ready`)
 * recordings are ever projected to the renderer. The internal `relative_path`
 * and any absolute filesystem path are deliberately never exposed; recordings
 * are addressed by opaque id only.
 */
export const audioRecordingSchema = z.object({
  id: z.string().min(1),
  mediaType: z.string().min(1),
  codec: z.string().min(1),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  label: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type AudioRecording = z.infer<typeof audioRecordingSchema>;

// --- audio.capture.begin ----------------------------------------------------

export const audioCaptureBeginInputSchema = z
  .object({ label: labelSchema.optional() })
  .strict();
export type AudioCaptureBeginInput = z.infer<
  typeof audioCaptureBeginInputSchema
>;

export const audioCaptureBeginOutputSchema = z.object({
  captureId: z.string().uuid(),
  token: z.string().min(16),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  bitsPerSample: z.number().int().positive(),
  maxChunkBytes: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
});
export type AudioCaptureBeginOutput = z.infer<
  typeof audioCaptureBeginOutputSchema
>;

// --- audio.capture.append ---------------------------------------------------

export const audioCaptureAppendInputSchema = z
  .object({
    captureId: captureIdSchema,
    token: tokenSchema,
    sequence: z.number().int().nonnegative(),
    chunk: base64Schema,
  })
  .strict();
export type AudioCaptureAppendInput = z.infer<
  typeof audioCaptureAppendInputSchema
>;

export const audioCaptureAppendOutputSchema = z.object({
  sequence: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
});
export type AudioCaptureAppendOutput = z.infer<
  typeof audioCaptureAppendOutputSchema
>;

// --- audio.capture.complete -------------------------------------------------

export const audioCaptureCompleteInputSchema = z
  .object({ captureId: captureIdSchema, token: tokenSchema })
  .strict();
export type AudioCaptureCompleteInput = z.infer<
  typeof audioCaptureCompleteInputSchema
>;

export const audioCaptureCompleteOutputSchema = z.object({
  recording: audioRecordingSchema,
});
export type AudioCaptureCompleteOutput = z.infer<
  typeof audioCaptureCompleteOutputSchema
>;

// --- audio.capture.cancel ---------------------------------------------------

export const audioCaptureCancelInputSchema = z
  .object({ captureId: captureIdSchema, token: tokenSchema })
  .strict();
export type AudioCaptureCancelInput = z.infer<
  typeof audioCaptureCancelInputSchema
>;

export const audioCaptureCancelOutputSchema = z.object({
  cancelled: z.literal(true),
});
export type AudioCaptureCancelOutput = z.infer<
  typeof audioCaptureCancelOutputSchema
>;

// --- audio.list -------------------------------------------------------------

export const audioListInputSchema = z.object({}).strict();

export const audioListOutputSchema = z.object({
  items: z.array(audioRecordingSchema),
});
export type AudioListOutput = z.infer<typeof audioListOutputSchema>;

// --- audio.get --------------------------------------------------------------

export const audioGetInputSchema = z.object({ id: z.string().uuid() }).strict();
export type AudioGetInput = z.infer<typeof audioGetInputSchema>;

export const audioGetOutputSchema = z.object({
  recording: audioRecordingSchema,
});
export type AudioGetOutput = z.infer<typeof audioGetOutputSchema>;

// --- audio.playback.open ----------------------------------------------------

export const audioPlaybackOpenInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export type AudioPlaybackOpenInput = z.infer<
  typeof audioPlaybackOpenInputSchema
>;

export const audioPlaybackOpenOutputSchema = z.object({
  token: z.string().min(16),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  maxReadBytes: z.number().int().positive(),
});
export type AudioPlaybackOpenOutput = z.infer<
  typeof audioPlaybackOpenOutputSchema
>;

// --- audio.playback.read ----------------------------------------------------

export const audioPlaybackReadInputSchema = z
  .object({
    id: z.string().uuid(),
    token: tokenSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive().max(AUDIO_PLAYBACK_MAX_READ_BYTES),
  })
  .strict();
export type AudioPlaybackReadInput = z.infer<
  typeof audioPlaybackReadInputSchema
>;

export const audioPlaybackReadOutputSchema = z.object({
  chunk: z.string(),
  bytesRead: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  eof: z.boolean(),
});
export type AudioPlaybackReadOutput = z.infer<
  typeof audioPlaybackReadOutputSchema
>;

// --- audio.playback.close ---------------------------------------------------

export const audioPlaybackCloseInputSchema = z
  .object({ id: z.string().uuid(), token: tokenSchema })
  .strict();
export type AudioPlaybackCloseInput = z.infer<
  typeof audioPlaybackCloseInputSchema
>;

export const audioPlaybackCloseOutputSchema = z.object({
  closed: z.literal(true),
});
export type AudioPlaybackCloseOutput = z.infer<
  typeof audioPlaybackCloseOutputSchema
>;

// ===========================================================================
// Stage 008.2 — offline speech-to-text (additive to the `audio` API major v1)
// ===========================================================================
//
// These contracts are deliberately provider-neutral: no `whisper`-specific
// field, model path, executable path or command-line switch is ever exposed to
// the renderer. The renderer addresses a recording by opaque id and receives
// durable, safe job/transcript metadata. Provider-specific execution lives
// entirely in main-process adapters (ADR-008-02).

/**
 * Stable, safe speech-to-text failure/availability codes. These are *domain*
 * codes stored on jobs and reported by provider probes; they are distinct from
 * the IPC transport {@link ErrorCode} set. They never carry stderr, paths or
 * recognised text.
 */
export const STT_FAILURE_CODES = [
  'provider_unavailable',
  'executable_missing',
  'model_missing',
  'model_corrupt',
  'unsupported_platform',
  'invalid_audio',
  'process_crashed',
  'timed_out',
  'cancelled',
  'invalid_output',
  'disk_write_failed',
  'engine_failed',
] as const;
export const sttFailureCodeSchema = z.enum(STT_FAILURE_CODES);
export type SttFailureCode = (typeof STT_FAILURE_CODES)[number];

/** Short spoken-language hint: `auto` (detect) or a 2-letter ISO-639-1 code. */
export const sttLanguageHintSchema = z
  .string()
  .regex(/^(auto|[a-z]{2})$/u, 'Expected "auto" or a 2-letter language code.');

// --- provider capability ----------------------------------------------------

export const STT_PROVIDER_STATES = ['ready', 'unavailable'] as const;
export const sttProviderStateSchema = z.enum(STT_PROVIDER_STATES);
export type SttProviderState = (typeof STT_PROVIDER_STATES)[number];

/**
 * Safe, provider-neutral description of a single installed model behind an STT
 * provider. Measured `bytes` reflects the real on-disk size when known.
 */
export const sttModelInfoSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  variant: z.string().min(1),
  multilingual: z.boolean(),
  bytes: z.number().int().nonnegative().nullable(),
});
export type SttModelInfo = z.infer<typeof sttModelInfoSchema>;

/**
 * Read-only capability projection for an STT provider, suitable for the Local
 * AI "Speech-to-text" section. `engine`/`engineVersion` are safe identifiers,
 * never an executable path. `reason` is populated only when unavailable.
 */
export const sttProviderSchema = z.object({
  providerId: z.string().min(1),
  engine: z.string().min(1),
  state: sttProviderStateSchema,
  ready: z.boolean(),
  offline: z.boolean(),
  engineVersion: z.string().min(1).nullable(),
  model: sttModelInfoSchema.nullable(),
  reason: sttFailureCodeSchema.nullable(),
  locales: z.array(z.string().min(1)),
});
export type SttProvider = z.infer<typeof sttProviderSchema>;

// --- job + transcript -------------------------------------------------------

export const STT_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const sttJobStatusSchema = z.enum(STT_JOB_STATUSES);
export type SttJobStatus = (typeof STT_JOB_STATUSES)[number];

/**
 * Durable transcription job. One recording may have many independent attempts
 * (each retry is a new, attributable job). `transcriptId` is set only on a
 * successful, non-empty or empty-but-completed attempt. No path, prompt,
 * command line or recognised text ever appears here.
 */
export const sttJobSchema = z.object({
  id: z.string().min(1),
  recordingId: z.string().min(1),
  providerId: z.string().min(1),
  engineVersion: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  locale: z.string().min(1).nullable(),
  status: sttJobStatusSchema,
  errorCode: sttFailureCodeSchema.nullable(),
  transcriptId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SttJob = z.infer<typeof sttJobSchema>;

/** One timed segment of recognised text (offsets in milliseconds). */
export const sttSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
});
export type SttSegment = z.infer<typeof sttSegmentSchema>;

/**
 * Immutable original engine output for a recording attempt. `text` is the raw
 * recognised transcript (possibly empty when no speech was detected). This is
 * the user's private speech content and is only ever returned through this
 * explicit, id-scoped read — never logged or placed in telemetry.
 */
export const sttTranscriptSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  recordingId: z.string().min(1),
  providerId: z.string().min(1),
  engineVersion: z.string().min(1),
  modelId: z.string().min(1),
  locale: z.string().min(1).nullable(),
  text: z.string(),
  empty: z.boolean(),
  segments: z.array(sttSegmentSchema).nullable(),
  createdAt: z.string().min(1),
});
export type SttTranscript = z.infer<typeof sttTranscriptSchema>;

const sttJobIdSchema = z.string().uuid();
const sttRecordingIdSchema = z.string().uuid();
const sttTranscriptIdSchema = z.string().uuid();
const sttProviderIdSchema = z.string().min(1).max(64);

// --- audio.stt.providers.list -----------------------------------------------

export const audioSttProvidersListInputSchema = z.object({}).strict();

export const audioSttProvidersListOutputSchema = z.object({
  items: z.array(sttProviderSchema),
});
export type AudioSttProvidersListOutput = z.infer<
  typeof audioSttProvidersListOutputSchema
>;

// --- audio.stt.providers.verify ---------------------------------------------

export const audioSttProvidersVerifyInputSchema = z
  .object({ providerId: sttProviderIdSchema })
  .strict();
export type AudioSttProvidersVerifyInput = z.infer<
  typeof audioSttProvidersVerifyInputSchema
>;

export const audioSttProvidersVerifyOutputSchema = z.object({
  provider: sttProviderSchema,
  verified: z.boolean(),
});
export type AudioSttProvidersVerifyOutput = z.infer<
  typeof audioSttProvidersVerifyOutputSchema
>;

// --- audio.stt.jobs.start ---------------------------------------------------

export const audioSttJobsStartInputSchema = z
  .object({
    recordingId: sttRecordingIdSchema,
    providerId: sttProviderIdSchema.optional(),
    languageHint: sttLanguageHintSchema.optional(),
  })
  .strict();
export type AudioSttJobsStartInput = z.infer<
  typeof audioSttJobsStartInputSchema
>;

export const audioSttJobsStartOutputSchema = z.object({ job: sttJobSchema });
export type AudioSttJobsStartOutput = z.infer<
  typeof audioSttJobsStartOutputSchema
>;

// --- audio.stt.jobs.get -----------------------------------------------------

export const audioSttJobsGetInputSchema = z
  .object({ jobId: sttJobIdSchema })
  .strict();
export type AudioSttJobsGetInput = z.infer<typeof audioSttJobsGetInputSchema>;

export const audioSttJobsGetOutputSchema = z.object({ job: sttJobSchema });
export type AudioSttJobsGetOutput = z.infer<typeof audioSttJobsGetOutputSchema>;

// --- audio.stt.jobs.list ----------------------------------------------------

export const audioSttJobsListInputSchema = z
  .object({ recordingId: sttRecordingIdSchema.optional() })
  .strict();
export type AudioSttJobsListInput = z.infer<typeof audioSttJobsListInputSchema>;

export const audioSttJobsListOutputSchema = z.object({
  items: z.array(sttJobSchema),
});
export type AudioSttJobsListOutput = z.infer<
  typeof audioSttJobsListOutputSchema
>;

// --- audio.stt.jobs.cancel --------------------------------------------------

export const audioSttJobsCancelInputSchema = z
  .object({ jobId: sttJobIdSchema })
  .strict();
export type AudioSttJobsCancelInput = z.infer<
  typeof audioSttJobsCancelInputSchema
>;

export const audioSttJobsCancelOutputSchema = z.object({
  cancelled: z.literal(true),
});
export type AudioSttJobsCancelOutput = z.infer<
  typeof audioSttJobsCancelOutputSchema
>;

// --- audio.stt.jobs.retry ---------------------------------------------------

export const audioSttJobsRetryInputSchema = z
  .object({
    jobId: sttJobIdSchema,
    languageHint: sttLanguageHintSchema.optional(),
  })
  .strict();
export type AudioSttJobsRetryInput = z.infer<
  typeof audioSttJobsRetryInputSchema
>;

export const audioSttJobsRetryOutputSchema = z.object({ job: sttJobSchema });
export type AudioSttJobsRetryOutput = z.infer<
  typeof audioSttJobsRetryOutputSchema
>;

// --- audio.stt.transcripts.get ----------------------------------------------

export const audioSttTranscriptsGetInputSchema = z
  .object({ transcriptId: sttTranscriptIdSchema })
  .strict();
export type AudioSttTranscriptsGetInput = z.infer<
  typeof audioSttTranscriptsGetInputSchema
>;

export const audioSttTranscriptsGetOutputSchema = z.object({
  transcript: sttTranscriptSchema,
});
export type AudioSttTranscriptsGetOutput = z.infer<
  typeof audioSttTranscriptsGetOutputSchema
>;
