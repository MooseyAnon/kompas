import {
  AUDIO_API_VERSION,
  AUDIO_MODULE_ID,
  audioCaptureAppendInputSchema,
  audioCaptureAppendOutputSchema,
  audioCaptureBeginInputSchema,
  audioCaptureBeginOutputSchema,
  audioCaptureCancelInputSchema,
  audioCaptureCancelOutputSchema,
  audioCaptureCompleteInputSchema,
  audioCaptureCompleteOutputSchema,
  audioGetInputSchema,
  audioGetOutputSchema,
  audioListInputSchema,
  audioListOutputSchema,
  audioPlaybackCloseInputSchema,
  audioPlaybackCloseOutputSchema,
  audioPlaybackOpenInputSchema,
  audioPlaybackOpenOutputSchema,
  audioPlaybackReadInputSchema,
  audioPlaybackReadOutputSchema,
  audioSttJobsCancelInputSchema,
  audioSttJobsCancelOutputSchema,
  audioSttJobsGetInputSchema,
  audioSttJobsGetOutputSchema,
  audioSttJobsListInputSchema,
  audioSttJobsListOutputSchema,
  audioSttJobsRetryInputSchema,
  audioSttJobsRetryOutputSchema,
  audioSttJobsStartInputSchema,
  audioSttJobsStartOutputSchema,
  audioSttProvidersListInputSchema,
  audioSttProvidersListOutputSchema,
  audioSttProvidersVerifyInputSchema,
  audioSttProvidersVerifyOutputSchema,
  audioSttTranscriptsGetInputSchema,
  audioSttTranscriptsGetOutputSchema,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import type { RecordingService } from './audio.service';
import type { TranscriptionService } from './stt/transcription.service';

/**
 * Build the statically-registered `audio` module manifest (API major v1). The
 * Stage 008.2 speech-to-text commands are additive and are registered only when
 * a TranscriptionService is wired (it needs the bundled engine resources).
 */
export function createAudioModule(
  service: RecordingService,
  transcription?: TranscriptionService,
): ModuleManifest {
  const commands: ModuleManifest['commands'] = {
    'capture.begin': defineCommand({
      input: audioCaptureBeginInputSchema,
      output: audioCaptureBeginOutputSchema,
      handle: (input) => service.beginCapture(input.label ?? null),
    }),
    'capture.append': defineCommand({
      input: audioCaptureAppendInputSchema,
      output: audioCaptureAppendOutputSchema,
      handle: (input) =>
        service.appendChunk(
          input.captureId,
          input.token,
          input.sequence,
          input.chunk,
        ),
    }),
    'capture.complete': defineCommand({
      input: audioCaptureCompleteInputSchema,
      output: audioCaptureCompleteOutputSchema,
      handle: async (input) => ({
        recording: await service.completeCapture(input.captureId, input.token),
      }),
    }),
    'capture.cancel': defineCommand({
      input: audioCaptureCancelInputSchema,
      output: audioCaptureCancelOutputSchema,
      handle: (input) => service.cancelCapture(input.captureId, input.token),
    }),
    list: defineCommand({
      input: audioListInputSchema,
      output: audioListOutputSchema,
      handle: () => ({ items: service.list() }),
    }),
    get: defineCommand({
      input: audioGetInputSchema,
      output: audioGetOutputSchema,
      handle: (input) => ({ recording: service.get(input.id) }),
    }),
    'playback.open': defineCommand({
      input: audioPlaybackOpenInputSchema,
      output: audioPlaybackOpenOutputSchema,
      handle: (input) => service.openPlayback(input.id),
    }),
    'playback.read': defineCommand({
      input: audioPlaybackReadInputSchema,
      output: audioPlaybackReadOutputSchema,
      handle: (input) =>
        service.readPlayback(input.id, input.token, input.offset, input.length),
    }),
    'playback.close': defineCommand({
      input: audioPlaybackCloseInputSchema,
      output: audioPlaybackCloseOutputSchema,
      handle: (input) => service.closePlayback(input.id, input.token),
    }),
  };

  if (transcription) {
    Object.assign(commands, {
      'stt.providers.list': defineCommand({
        input: audioSttProvidersListInputSchema,
        output: audioSttProvidersListOutputSchema,
        handle: async () => ({ items: await transcription.listProviders() }),
      }),
      'stt.providers.verify': defineCommand({
        input: audioSttProvidersVerifyInputSchema,
        output: audioSttProvidersVerifyOutputSchema,
        handle: (input) => transcription.verifyProvider(input.providerId),
      }),
      'stt.jobs.start': defineCommand({
        input: audioSttJobsStartInputSchema,
        output: audioSttJobsStartOutputSchema,
        handle: async (input) => ({
          job: await transcription.startJob({
            recordingId: input.recordingId,
            providerId: input.providerId,
            languageHint: input.languageHint,
          }),
        }),
      }),
      'stt.jobs.get': defineCommand({
        input: audioSttJobsGetInputSchema,
        output: audioSttJobsGetOutputSchema,
        handle: (input) => ({ job: transcription.getJob(input.jobId) }),
      }),
      'stt.jobs.list': defineCommand({
        input: audioSttJobsListInputSchema,
        output: audioSttJobsListOutputSchema,
        handle: (input) => ({
          items: transcription.listJobs(input.recordingId),
        }),
      }),
      'stt.jobs.cancel': defineCommand({
        input: audioSttJobsCancelInputSchema,
        output: audioSttJobsCancelOutputSchema,
        handle: (input) => transcription.cancelJob(input.jobId),
      }),
      'stt.jobs.retry': defineCommand({
        input: audioSttJobsRetryInputSchema,
        output: audioSttJobsRetryOutputSchema,
        handle: async (input) => ({
          job: await transcription.retryJob(input.jobId, input.languageHint),
        }),
      }),
      'stt.transcripts.get': defineCommand({
        input: audioSttTranscriptsGetInputSchema,
        output: audioSttTranscriptsGetOutputSchema,
        handle: (input) => ({
          transcript: transcription.getTranscript(input.transcriptId),
        }),
      }),
    });
  }

  return { id: AUDIO_MODULE_ID, apiMajor: AUDIO_API_VERSION, commands };
}
