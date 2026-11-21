import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUDIO_MAX_DURATION_MS,
  type AudioRecording,
  type InterviewAnswerAudioLink,
  type SttJob,
} from '../../../../shared/contracts';
import {
  audioSttJobsCancel,
  audioSttJobsGet,
  audioSttJobsList,
  audioSttJobsRetry,
  audioSttJobsStart,
  audioSttTranscriptsGet,
} from '../../../api';
import {
  MicrophoneRecorder,
  type RecorderHandlers,
} from '../../../audio/capture';
import { fetchRecordingBlob } from '../../../audio/playback';
import type { InterviewVoiceReplay } from '../../../presentation/components/interviews/InterviewVoicePanel';
import {
  LEVEL_HISTORY,
  STT_POLL_MS,
  captureErrorMessage,
  isVoiceBusy,
  latestJob,
  selectVoiceView,
  sttFailure,
  sttStartErrorMessage,
  voiceRecording,
  type RecordingRef,
  type VoiceState,
} from './voiceAnswer';

/** The capture seam; `MicrophoneRecorder` in the app, a fake in tests. */
export interface VoiceRecorder {
  start(label?: string): Promise<void>;
  stop(): Promise<AudioRecording>;
  cancel(): Promise<void>;
  dispose(): void;
}
export type CreateVoiceRecorder = (handlers: RecorderHandlers) => VoiceRecorder;

const createMicrophoneRecorder: CreateVoiceRecorder = (handlers) =>
  new MicrophoneRecorder(handlers);

/** Elapsed-time refresh while recording; the value is measured, not estimated. */
const CLOCK_TICK_MS = 250;

/**
 * Audio capture + STT adapter for one answer (mount one per question). It
 * uses only the Audio commands, never interview model commands, so stopping
 * a recording or a transcription never cancels interview work. A finished
 * transcript is handed to `onTranscript` for editing; nothing is submitted.
 *
 * Leaving the view releases the microphone and cancels an unfinished capture,
 * but leaves a running STT job alone: `rehydrate` resumes it on return.
 */
export function useVoiceAnswer({
  onRecordingChange,
  onTranscript,
  createRecorder = createMicrophoneRecorder,
}: {
  onRecordingChange: (recordingId: string | null) => void;
  onTranscript: (text: string) => void;
  createRecorder?: CreateVoiceRecorder;
}) {
  const [state, setStateValue] = useState<VoiceState>({ kind: 'idle' });
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [replay, setReplay] = useState<
    InterviewVoiceReplay & { recordingId: string | null }
  >({ url: null, loading: false, recordingId: null });

  const stateRef = useRef(state);
  const mounted = useRef(true);
  const recorder = useRef<VoiceRecorder | null>(null);
  // Bumped by every user transition and on unmount; async work started under
  // an older epoch must not change state.
  const epoch = useRef(0);
  const callbacks = useRef({ onRecordingChange, onTranscript });
  callbacks.current = { onRecordingChange, onTranscript };

  const setState = useCallback((next: VoiceState) => {
    stateRef.current = next;
    if (mounted.current) setStateValue(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      recorder.current?.dispose();
      recorder.current = null;
    };
  }, []);

  // --- transcription --------------------------------------------------------

  const settleJob = useCallback(
    async (job: SttJob, recording: RecordingRef, token: number) => {
      const current = { ...recording, jobId: job.id };
      if (job.status === 'queued' || job.status === 'running') {
        setState({
          kind: 'transcribing',
          recording: current,
          jobId: job.id,
          queued: job.status === 'queued',
        });
        return;
      }
      if (job.status === 'cancelled') {
        setState({ kind: 'recorded', recording: current, transcript: 'none' });
        return;
      }
      if (job.status !== 'succeeded') {
        const failure = sttFailure(job);
        setState({
          kind: 'error',
          message: failure.message,
          retry: failure.retryable ? 'transcribe' : null,
          recording: current,
        });
        return;
      }

      const transcript = job.transcriptId
        ? await audioSttTranscriptsGet(job.transcriptId)
        : null;
      if (token !== epoch.current) return;
      if (!transcript || transcript.empty || !transcript.text.trim()) {
        setState({ kind: 'recorded', recording: current, transcript: 'empty' });
        return;
      }
      callbacks.current.onTranscript(transcript.text);
      setState({
        kind: 'recorded',
        recording: { ...current, transcriptId: transcript.id },
        transcript: 'ready',
      });
    },
    [setState],
  );

  const transcribe = useCallback(
    async (recording: RecordingRef, retryJobId: string | null = null) => {
      const token = ++epoch.current;
      setState({ kind: 'transcribing', recording, jobId: null, queued: true });
      try {
        const job = retryJobId
          ? await audioSttJobsRetry(retryJobId)
          : await audioSttJobsStart(recording.id);
        if (token !== epoch.current) {
          // Stopped by the user before the job id was known.
          if (mounted.current) void audioSttJobsCancel(job.id).catch(() => {});
          return;
        }
        await settleJob(job, recording, token);
      } catch (error) {
        if (token !== epoch.current) return;
        setState({
          kind: 'error',
          message: sttStartErrorMessage(error),
          retry: 'transcribe',
          recording,
        });
      }
    },
    [setState, settleJob],
  );

  // Passive job polling while queued/running; cleared on any state change.
  useEffect(() => {
    if (state.kind !== 'transcribing' || state.jobId === null) return;
    const { jobId, recording } = state;
    const token = epoch.current;
    const timer = window.setTimeout(async () => {
      try {
        const job = await audioSttJobsGet(jobId);
        if (token === epoch.current) await settleJob(job, recording, token);
      } catch {
        if (token !== epoch.current) return;
        setState({
          kind: 'error',
          message:
            'Transcription progress couldn’t be read. Try again or type your answer.',
          retry: 'transcribe',
          recording,
        });
      }
    }, STT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [setState, settleJob, state]);

  // --- capture --------------------------------------------------------------

  const stop = useCallback(async () => {
    const current = stateRef.current;
    const active = recorder.current;
    if (current.kind !== 'recording' || current.stopping || !active) return;

    const token = epoch.current;
    // Detached first: unmount must not cancel a capture that is finalizing.
    recorder.current = null;
    setState({ ...current, stopping: true });
    try {
      const recording = await active.stop();
      // Keep the draft link even if the view was left while saving.
      if (!mounted.current || token === epoch.current)
        callbacks.current.onRecordingChange(recording.id);
      if (token !== epoch.current) return;
      await transcribe({
        id: recording.id,
        durationMs: recording.durationMs,
        transcriptId: null,
        jobId: null,
      });
    } catch (error) {
      if (token !== epoch.current) return;
      setState({
        kind: 'error',
        message: captureErrorMessage(error),
        retry: 'record',
        recording: null,
      });
    }
  }, [setState, transcribe]);

  const start = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== 'idle' && current.kind !== 'error') return;
    if (voiceRecording(current)) callbacks.current.onRecordingChange(null);

    const token = ++epoch.current;
    setState({ kind: 'starting' });
    setLevels([]);
    setElapsedMs(null);

    const next = createRecorder({
      onError: () => {
        // An upload failed mid-recording; stop now rather than at Stop.
        if (token !== epoch.current || recorder.current !== next) return;
        epoch.current += 1;
        recorder.current = null;
        void next.cancel().catch(() => {});
        setState({
          kind: 'error',
          message: captureErrorMessage(new Error('upload')),
          retry: 'record',
          recording: null,
        });
      },
      onLevel: (level) => {
        if (token !== epoch.current || !mounted.current) return;
        setLevels((previous) => [...previous, level].slice(-LEVEL_HISTORY));
      },
    });
    recorder.current = next;

    try {
      await next.start('Interview answer');
    } catch (error) {
      if (recorder.current === next) recorder.current = null;
      if (token !== epoch.current) return;
      setState({
        kind: 'error',
        message: captureErrorMessage(error),
        retry: 'record',
        recording: null,
      });
      return;
    }
    if (token !== epoch.current) {
      next.dispose();
      return;
    }
    setElapsedMs(0);
    setState({ kind: 'recording', startedAt: Date.now(), stopping: false });
  }, [createRecorder, setState]);

  // Measured elapsed time, and a stop at the Audio duration limit.
  useEffect(() => {
    if (state.kind !== 'recording' || state.stopping) return;
    const { startedAt } = state;
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= AUDIO_MAX_DURATION_MS) void stop();
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [state, stop]);

  const cancelRecording = useCallback(async () => {
    const current = stateRef.current;
    const active = recorder.current;
    if (current.kind !== 'recording' || current.stopping) return;
    epoch.current += 1;
    recorder.current = null;
    setState({ kind: 'idle' });
    await active?.cancel().catch(() => {});
  }, [setState]);

  // --- recording follow-ups -------------------------------------------------

  const cancelTranscription = useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== 'transcribing') return;
    epoch.current += 1;
    setState({
      kind: 'recorded',
      recording: current.recording,
      transcript: 'none',
    });
    if (current.jobId) void audioSttJobsCancel(current.jobId).catch(() => {});
  }, [setState]);

  const transcribeAgain = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === 'recorded') void transcribe(current.recording);
  }, [transcribe]);

  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== 'error' || !current.retry) return;
    if (current.retry === 'record') {
      void start();
      return;
    }
    if (current.recording)
      void transcribe(current.recording, current.recording.jobId);
  }, [start, transcribe]);

  const discard = useCallback(() => {
    const current = stateRef.current;
    if (!voiceRecording(current) || current.kind === 'transcribing') return;
    epoch.current += 1;
    setState({ kind: 'idle' });
    callbacks.current.onRecordingChange(null);
  }, [setState]);

  const dismissError = useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== 'error') return;
    epoch.current += 1;
    setState(
      current.recording
        ? { kind: 'recorded', recording: current.recording, transcript: 'none' }
        : { kind: 'idle' },
    );
  }, [setState]);

  /**
   * Restore a saved draft's recording and its newest STT job. Returns false
   * (and does nothing) unless the voice area is idle, so a draft read that
   * lands late can never replace a live capture. A transcript that finished
   * after the draft was last saved was never seen, so it is delivered now.
   */
  const rehydrate = useCallback(
    (recordingId: string, draftUpdatedAt: string) => {
      if (stateRef.current.kind !== 'idle') return false;

      const token = ++epoch.current;
      const recording: RecordingRef = {
        id: recordingId,
        durationMs: null,
        transcriptId: null,
        jobId: null,
      };
      setState({ kind: 'recorded', recording, transcript: 'none' });

      void (async () => {
        try {
          const job = latestJob(await audioSttJobsList(recordingId));
          if (token !== epoch.current || !job) return;
          // Delivering a transcript saves the draft, so an older draft
          // means this result was never shown.
          const seen =
            job.status === 'succeeded' &&
            job.transcriptId !== null &&
            job.updatedAt <= draftUpdatedAt;
          if (seen) {
            setState({
              kind: 'recorded',
              recording: {
                ...recording,
                jobId: job.id,
                transcriptId: job.transcriptId,
              },
              transcript: 'ready',
            });
            return;
          }
          if (job.status !== 'failed' && job.status !== 'cancelled')
            await settleJob(job, recording, token);
        } catch {
          // The recording link is still valid; transcription can be redone.
        }
      })();
      return true;
    },
    [setState, settleJob],
  );

  // --- replay ---------------------------------------------------------------

  const recordingId = voiceRecording(state)?.id ?? null;

  const loadReplay = useCallback(async () => {
    const id = voiceRecording(stateRef.current)?.id;
    if (!id) return;
    setReplay({ url: null, loading: true, recordingId: id });
    try {
      const url = URL.createObjectURL(await fetchRecordingBlob(id));
      if (!mounted.current || voiceRecording(stateRef.current)?.id !== id) {
        URL.revokeObjectURL(url);
        return;
      }
      setReplay({ url, loading: false, recordingId: id });
    } catch {
      if (mounted.current)
        setReplay({ url: null, loading: false, recordingId: null });
    }
  }, []);

  // A replay belongs to one recording; release it when that changes or on unmount.
  useEffect(() => {
    if (replay.url && replay.recordingId !== recordingId) {
      setReplay({ url: null, loading: false, recordingId: null });
    }
  }, [recordingId, replay]);
  useEffect(() => {
    const url = replay.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [replay.url]);

  // --- outputs --------------------------------------------------------------

  const view = useMemo(
    () =>
      selectVoiceView(state, {
        elapsedMs,
        levels,
        maxDurationMs: AUDIO_MAX_DURATION_MS,
      }),
    [elapsedMs, levels, state],
  );

  const settled = state.kind === 'recorded' || state.kind === 'error';
  const recording = voiceRecording(state);
  const link: InterviewAnswerAudioLink | undefined =
    settled && recording
      ? {
          recordingId: recording.id,
          ...(recording.transcriptId
            ? { transcriptId: recording.transcriptId }
            : {}),
        }
      : undefined;

  return {
    state,
    view,
    replay: { url: replay.url, loading: replay.loading },
    busy: isVoiceBusy(state),
    link,
    rehydrate,
    actions: {
      start,
      stop,
      cancelRecording,
      transcribe: transcribeAgain,
      cancelTranscription,
      retry,
      discard,
      loadReplay,
      dismissError,
    },
  };
}
