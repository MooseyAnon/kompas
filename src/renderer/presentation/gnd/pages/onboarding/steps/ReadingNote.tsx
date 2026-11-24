import React from 'react';
import type { CvImport } from '../../../../../../shared/contracts';

/**
 * A small note while the CV is read in the background: a turning page while
 * reading, a tick when done, and what went wrong if it failed.
 */
export function ReadingNote({
  cvImport,
  failure,
  onRetry,
}: {
  cvImport: CvImport | null;
  failure: string | null;
  onRetry: () => void;
}) {
  if (!cvImport) return null;
  const status = cvImport.status;
  const state =
    status === 'processing'
      ? 'reading'
      : status === 'failed'
        ? 'failed'
        : 'done';
  return (
    <div
      className={`gnd-reading-note is-${state}`}
      role={state === 'failed' ? 'alert' : 'status'}
      data-testid="gnd-reading-note"
    >
      <span className="gnd-reading-page" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        {state === 'reading' &&
          'Reading your CV in the background. Suggestions will appear here.'}
        {state === 'done' && 'Your CV is read. We’ve added roles from it.'}
        {state === 'failed' && failure}
      </span>
      {state === 'failed' && (
        <button type="button" className="gnd-text-link" onClick={onRetry}>
          Try another file
        </button>
      )}
    </div>
  );
}
