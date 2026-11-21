import type { SttFailureCode, SttJob } from '../../../../shared/contracts';
import { ApiError } from '../../../api';
import { MicrophoneUnavailableError } from '../../../audio/capture';
import type { InterviewVoiceView } from '../../../presentation/components/interviews/InterviewVoicePanel';
import { statusCopy } from '../session/statusCopy';

/** STT job read cadence while a job is queued or running. */
export const STT_POLL_MS = 1000;
/** Real input levels kept for the recording trail. */
export const LEVEL_HISTORY = 24;

export interface RecordingRef {
  id: string;
  durationMs: number | null;
  /** Set once a non-empty transcript was produced for this recording. */
  transcriptId: string | null;
  /** The newest STT job, for retry. */
  jobId: string | null;
}

/**
 * Ephemeral capture/STT presentation state for one answer. Audio owns the
 * recordings and jobs; this only tracks what the user is looking at.
 */
export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; startedAt: number; stopping: boolean }
  | {
      kind: 'recorded';
      recording: RecordingRef;
      transcript: 'none' | 'ready' | 'empty';
    }
  | {
      kind: 'transcribing';
      recording: RecordingRef;
      /** Null until `stt.jobs.start` returns. */
      jobId: string | null;
      queued: boolean;
    }
  | {
      kind: 'error';
      message: string;
      retry: 'record' | 'transcribe' | null;
      recording: RecordingRef | null;
    };

export function voiceRecording(state: VoiceState): RecordingRef | null {
  switch (state.kind) {
    case 'recorded':
    case 'transcribing':
    case 'error':
      return state.recording;
    default:
      return null;
  }
}

/** Capture or transcription in progress; the answer should not be sent yet. */
export function isVoiceBusy(state: VoiceState) {
  return (
    state.kind === 'starting' ||
    state.kind === 'recording' ||
    state.kind === 'transcribing'
  );
}

export function selectVoiceView(
  state: VoiceState,
  live: {
    elapsedMs: number | null;
    levels: readonly number[];
    maxDurationMs: number;
  },
): InterviewVoiceView {
  switch (state.kind) {
    case 'idle':
    case 'starting':
      return { kind: state.kind };
    case 'recording':
      return {
        kind: 'recording',
        elapsedMs: live.elapsedMs,
        maxDurationMs: live.maxDurationMs,
        levels: live.levels.length ? live.levels : null,
        stopping: state.stopping,
      };
    case 'recorded':
      return {
        kind: 'recorded',
        durationMs: state.recording.durationMs,
        transcript: state.transcript,
      };
    case 'transcribing': {
      const copy = statusCopy.transcription;
      return {
        kind: 'transcribing',
        // Precise: the job is either waiting for the engine or running.
        label: state.queued ? 'Waiting to transcribe' : copy.label,
        phrases: copy.phrases,
        icon: copy.icon,
      };
    }
    case 'error':
      return {
        kind: 'error',
        message: state.message,
        retry: state.retry,
        hasRecording: state.recording !== null,
      };
  }
}

const TYPE_FALLBACK = 'You can type your answer instead.';

/** Microphone, permission and capture-storage failures, in plain words. */
export function captureErrorMessage(error: unknown): string {
  if (error instanceof MicrophoneUnavailableError)
    return `Recording isn’t available in this window. ${TYPE_FALLBACK}`;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return `Microphone access was blocked. Allow it in System Settings › Privacy & Security › Microphone, then try again. ${TYPE_FALLBACK}`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return `No microphone was found. Connect one and try again. ${TYPE_FALLBACK}`;
  if (name === 'NotReadableError' || name === 'AbortError')
    return `The microphone is busy or couldn’t start. ${TYPE_FALLBACK}`;
  if (error instanceof ApiError)
    return `The recording couldn’t be saved. ${TYPE_FALLBACK}`;
  return `Recording stopped unexpectedly. ${TYPE_FALLBACK}`;
}

const unavailableCodes = new Set<SttFailureCode>([
  'provider_unavailable',
  'executable_missing',
  'model_missing',
  'model_corrupt',
  'unsupported_platform',
]);

/** A settled STT failure: message and whether trying again can help. */
export function sttFailure(job: Pick<SttJob, 'status' | 'errorCode'>): {
  message: string;
  retryable: boolean;
} {
  const code = job.errorCode;
  if (code && unavailableCodes.has(code))
    return {
      message: `Speech-to-text isn’t set up on this Mac. Check Settings › Audio. ${TYPE_FALLBACK}`,
      retryable: false,
    };
  if (code === 'invalid_audio')
    return {
      message:
        'This recording couldn’t be read. Record again or type your answer.',
      retryable: false,
    };
  if (job.status === 'interrupted')
    return {
      message: 'Transcription was interrupted. Try again or type your answer.',
      retryable: true,
    };
  return {
    message: 'Transcription didn’t finish. Try again or type your answer.',
    retryable: true,
  };
}

export function sttStartErrorMessage(error: unknown): string {
  return error instanceof ApiError
    ? `Transcription couldn’t start: ${error.message} ${TYPE_FALLBACK}`
    : `Transcription couldn’t start. ${TYPE_FALLBACK}`;
}

/**
 * Where a new transcript goes. An empty draft, or one still holding the
 * previous untouched transcript, is replaced; edited text is kept and the
 * transcript is appended as a new paragraph.
 */
export function mergeTranscript(
  draft: string,
  transcript: string,
  previousTranscript: string | null,
): string {
  const text = transcript.trim();
  const current = draft.trim();
  if (!current || current === previousTranscript?.trim()) return text;
  return `${draft.trimEnd()}\n\n${text}`;
}

/** The newest job for a recording (lists are not guaranteed ordered). */
export function latestJob(jobs: readonly SttJob[]): SttJob | null {
  return jobs.reduce<SttJob | null>(
    (latest, job) =>
      !latest || job.createdAt > latest.createdAt ? job : latest,
    null,
  );
}
