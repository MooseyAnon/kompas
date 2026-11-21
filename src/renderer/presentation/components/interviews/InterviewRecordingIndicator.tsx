import React from 'react';
import { Mic, Square, X } from 'lucide-react';
import { Button } from '../Button';
import './InterviewRecordingIndicator.css';

export function formatClock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Unmistakable live-recording state: a microphone badge, the word
 * `Recording`, the measured elapsed time and Stop/Cancel. `levels` are real
 * input levels (0–1) from the stream being recorded; without them the badge
 * only pulses decoratively and nothing pretends to measure the voice.
 */
export function InterviewRecordingIndicator({
  elapsedMs,
  maxDurationMs,
  levels,
  stopping = false,
  onStop,
  onCancel,
  'data-testid': testId = 'interview-recording',
}: {
  elapsedMs: number | null;
  maxDurationMs?: number;
  levels: readonly number[] | null;
  stopping?: boolean;
  onStop: () => void;
  onCancel: () => void;
  'data-testid'?: string;
}) {
  return (
    <div
      className={`interview-recording${stopping ? ' is-stopping' : ''}`}
      data-testid={testId}
    >
      <span className="interview-recording-badge" aria-hidden="true">
        <span className="interview-recording-ring" />
        <Mic size={18} strokeWidth={2.2} />
      </span>

      <div className="interview-recording-copy">
        <span className="interview-recording-label">
          {stopping ? 'Saving recording…' : 'Recording'}
        </span>
        {elapsedMs !== null && (
          <span
            className="interview-recording-time"
            role="timer"
            aria-label={`Recording time ${formatClock(elapsedMs)}`}
            data-testid={`${testId}-time`}
          >
            {formatClock(elapsedMs)}
            {maxDurationMs ? ` / ${formatClock(maxDurationMs)}` : ''}
          </span>
        )}
      </div>

      {levels && levels.length > 0 && (
        <span
          className="interview-recording-levels"
          aria-hidden="true"
          data-testid={`${testId}-levels`}
        >
          {levels.map((level, index) => (
            <span
              key={index}
              // A square-root curve keeps quiet speech visible.
              style={{ height: `${Math.round(12 + Math.sqrt(level) * 88)}%` }}
            />
          ))}
        </span>
      )}

      <div className="interview-recording-actions">
        <Button
          variant="primary"
          leadingIcon={<Square aria-hidden="true" />}
          disabled={stopping}
          onClick={onStop}
          data-testid={`${testId}-stop`}
        >
          Stop
        </Button>
        <Button
          variant="ghost"
          leadingIcon={<X aria-hidden="true" />}
          disabled={stopping}
          onClick={onCancel}
          data-testid={`${testId}-cancel`}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
