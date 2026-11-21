import React, { type ReactNode } from 'react';
import { Check, CloudOff, PencilLine, Send } from 'lucide-react';
import { Button } from '../Button';
import './InterviewAnswerComposer.css';

export type InterviewDraftStatus = 'idle' | 'saving' | 'saved' | 'error';

const draftCopy: Record<Exclude<InterviewDraftStatus, 'idle'>, string> = {
  saving: 'Saving draft…',
  saved: 'Draft saved',
  error: 'Draft not saved',
};

/**
 * The answer card for either runner: an always-available editable text area
 * (typed or transcribed), an optional voice area and Submit. It holds no
 * state; the page controller owns the draft, validation and submission.
 * ⌘/Ctrl + Enter submits when `canSubmit`.
 */
export function InterviewAnswerComposer({
  id,
  value,
  onChange,
  onSubmit,
  canSubmit,
  submitting = false,
  maxLength,
  questionTextId,
  readOnly = false,
  draftStatus = 'idle',
  hint,
  error,
  voice,
  'data-testid': testId = 'interview-composer',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  submitting?: boolean;
  maxLength: number;
  /** The question text element, read as the field's description. */
  questionTextId?: string;
  readOnly?: boolean;
  draftStatus?: InterviewDraftStatus;
  hint?: string;
  error?: string | null;
  /** The voice area (usually `InterviewVoicePanel`). */
  voice?: ReactNode;
  'data-testid'?: string;
}) {
  const length = value.trim().length;
  const overLimit = length > maxLength;
  const errorId = `${id}-error`;
  const countId = `${id}-count`;
  const describedBy = [questionTextId, countId, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      className="interview-composer"
      aria-label="Your answer"
      data-testid={testId}
    >
      <div className="interview-composer-head">
        <label htmlFor={id}>
          <PencilLine size={16} aria-hidden="true" />
          Your answer
        </label>
        {hint && <span className="interview-composer-hint">{hint}</span>}
        {draftStatus !== 'idle' && (
          <span
            className={`interview-composer-draft is-${draftStatus}`}
            data-testid={`${testId}-draft`}
          >
            {draftStatus === 'error' ? (
              <CloudOff size={13} aria-hidden="true" />
            ) : draftStatus === 'saved' ? (
              <Check size={13} aria-hidden="true" />
            ) : null}
            {draftCopy[draftStatus]}
          </span>
        )}
      </div>

      <textarea
        id={id}
        className="interview-composer-input"
        value={value}
        rows={5}
        readOnly={readOnly}
        aria-invalid={overLimit || undefined}
        aria-describedby={describedBy || undefined}
        placeholder="Type your answer, or record it and edit the transcript."
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            canSubmit &&
            !submitting
          ) {
            event.preventDefault();
            onSubmit();
          }
        }}
        data-testid={`${testId}-input`}
      />

      {error && (
        <p id={errorId} className="interview-composer-error" role="alert">
          {error}
        </p>
      )}

      <div className="interview-composer-foot">
        {voice && <div className="interview-composer-voice">{voice}</div>}
        <div className="interview-composer-submit">
          <span
            id={countId}
            className={`interview-composer-count${overLimit ? ' is-over' : ''}`}
          >
            {length.toLocaleString()} / {maxLength.toLocaleString()}
          </span>
          <Button
            leadingIcon={<Send aria-hidden="true" />}
            disabled={!canSubmit || submitting}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onClick={onSubmit}
            data-testid={`${testId}-submit`}
          >
            {submitting ? 'Submitting…' : 'Submit answer'}
          </Button>
        </div>
      </div>
    </section>
  );
}
