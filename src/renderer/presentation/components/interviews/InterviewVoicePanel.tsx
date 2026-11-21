import React from 'react';
import {
  AlertTriangle,
  AudioLines,
  Headphones,
  Keyboard,
  Mic,
  RotateCw,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../Button';
import {
  InterviewRecordingIndicator,
  formatClock,
} from './InterviewRecordingIndicator';
import { InterviewStatusBubble } from './InterviewStatusBubble';
import './InterviewVoicePanel.css';

/** What the voice area shows; built by the page-level voice controller. */
export type InterviewVoiceView =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | {
      kind: 'recording';
      elapsedMs: number | null;
      maxDurationMs: number;
      levels: readonly number[] | null;
      stopping: boolean;
    }
  | {
      kind: 'recorded';
      /** Null when unknown, for example for a restored draft. */
      durationMs: number | null;
      transcript: 'none' | 'ready' | 'empty';
    }
  | {
      kind: 'transcribing';
      label: string;
      phrases: readonly string[];
      icon: LucideIcon;
    }
  | {
      kind: 'error';
      message: string;
      /** Which step a retry repeats, if any. */
      retry: 'record' | 'transcribe' | null;
      /** A saved recording is still attached and can be replayed. */
      hasRecording: boolean;
    };

export interface InterviewVoiceReplay {
  url: string | null;
  loading: boolean;
}

export interface InterviewVoiceActions {
  onRecord: () => void;
  onStop: () => void;
  onCancelRecording: () => void;
  onTranscribe: () => void;
  onCancelTranscription: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  onLoadReplay: () => void;
  onTypeInstead: () => void;
}

/**
 * Record → replay → transcribe for an answer. The transcript lands in the
 * composer's editable text; nothing here submits. Every failure keeps typing
 * available.
 */
export function InterviewVoicePanel({
  view,
  replay,
  actions,
  disabled = false,
  'data-testid': testId = 'interview-voice',
}: {
  view: InterviewVoiceView;
  replay: InterviewVoiceReplay;
  actions: InterviewVoiceActions;
  disabled?: boolean;
  'data-testid'?: string;
}) {
  const hasRecording =
    view.kind === 'recorded' ||
    view.kind === 'transcribing' ||
    (view.kind === 'error' && view.hasRecording);

  return (
    <div className={`interview-voice is-${view.kind}`} data-testid={testId}>
      {view.kind === 'idle' && (
        <Button
          variant="secondary"
          leadingIcon={<Mic aria-hidden="true" />}
          disabled={disabled}
          onClick={actions.onRecord}
          data-testid={`${testId}-record`}
        >
          Record answer
        </Button>
      )}

      {view.kind === 'starting' && (
        <p className="interview-voice-note" role="status">
          <Mic size={16} aria-hidden="true" /> Waiting for the microphone…
        </p>
      )}

      {view.kind === 'recording' && (
        <InterviewRecordingIndicator
          elapsedMs={view.elapsedMs}
          maxDurationMs={view.maxDurationMs}
          levels={view.levels}
          stopping={view.stopping}
          onStop={actions.onStop}
          onCancel={actions.onCancelRecording}
        />
      )}

      {view.kind === 'transcribing' && (
        <InterviewStatusBubble
          variant="inline"
          tone="transcription"
          icon={view.icon}
          label={view.label}
          phrases={view.phrases}
          data-testid={`${testId}-transcribing`}
        />
      )}

      {view.kind === 'recorded' && (
        <p
          className="interview-voice-note"
          role="status"
          data-testid={`${testId}-saved`}
        >
          <AudioLines size={16} aria-hidden="true" />
          {view.transcript === 'ready'
            ? 'Transcript added to your answer. Check and edit it before submitting.'
            : view.transcript === 'empty'
              ? 'No speech was detected in this recording. Try again or type your answer.'
              : view.durationMs === null
                ? 'Recording saved.'
                : `Recording saved (${formatClock(view.durationMs)}).`}
        </p>
      )}

      {view.kind === 'error' && (
        <div
          className="interview-voice-error"
          role="alert"
          data-testid={`${testId}-error`}
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{view.message}</span>
        </div>
      )}

      {(hasRecording || view.kind === 'error') && (
        <div className="interview-voice-actions">
          {view.kind === 'transcribing' && (
            <Button
              variant="secondary"
              leadingIcon={<X aria-hidden="true" />}
              onClick={actions.onCancelTranscription}
              data-testid={`${testId}-cancel-transcription`}
            >
              Stop transcribing
            </Button>
          )}
          {view.kind === 'recorded' && (
            <Button
              variant={view.transcript === 'ready' ? 'secondary' : 'primary'}
              leadingIcon={<AudioLines aria-hidden="true" />}
              disabled={disabled}
              onClick={actions.onTranscribe}
              data-testid={`${testId}-transcribe`}
            >
              {view.transcript === 'none' ? 'Transcribe' : 'Transcribe again'}
            </Button>
          )}
          {view.kind === 'error' && view.retry && (
            <Button
              variant="secondary"
              leadingIcon={<RotateCw aria-hidden="true" />}
              disabled={disabled}
              onClick={actions.onRetry}
              data-testid={`${testId}-retry`}
            >
              {view.retry === 'record'
                ? 'Try recording again'
                : 'Try transcribing again'}
            </Button>
          )}
          {view.kind === 'error' && (
            <Button
              variant="ghost"
              leadingIcon={<Keyboard aria-hidden="true" />}
              onClick={actions.onTypeInstead}
              data-testid={`${testId}-type-instead`}
            >
              Type instead
            </Button>
          )}
          {hasRecording && !replay.url && (
            <Button
              variant="ghost"
              leadingIcon={<Headphones aria-hidden="true" />}
              disabled={replay.loading}
              onClick={actions.onLoadReplay}
              data-testid={`${testId}-listen`}
            >
              {replay.loading ? 'Loading…' : 'Listen back'}
            </Button>
          )}
          {hasRecording && view.kind !== 'transcribing' && (
            <Button
              variant="ghost"
              leadingIcon={<Trash2 aria-hidden="true" />}
              disabled={disabled}
              onClick={actions.onDiscard}
              data-testid={`${testId}-discard`}
            >
              Remove recording
            </Button>
          )}
        </div>
      )}

      {hasRecording && replay.url && (
        // The user asked to listen, so starting playback is expected.
        <audio
          className="interview-voice-player"
          src={replay.url}
          controls
          autoPlay
          aria-label="Your recorded answer"
          data-testid={`${testId}-player`}
        />
      )}
    </div>
  );
}
