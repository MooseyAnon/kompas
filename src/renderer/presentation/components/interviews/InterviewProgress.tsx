import React from 'react';
import './InterviewProgress.css';

/** Dots are drawn only for small known totals; larger totals keep the text. */
const MAX_DOTS = 12;

/**
 * Honest session progress: a visible label (for example `Question 2 of 5`)
 * plus optional step dots built from real counts. No percentages, estimates
 * or score cues. `current` is 1-based and may be null between questions.
 */
export function InterviewProgress({
  label,
  total,
  completed,
  current = null,
  detail,
  'data-testid': testId,
}: {
  label: string;
  total?: number | null;
  completed?: number;
  current?: number | null;
  detail?: string;
  'data-testid'?: string;
}) {
  const showDots = typeof total === 'number' && total > 0 && total <= MAX_DOTS;
  const done = Math.max(0, Math.min(completed ?? 0, total ?? 0));

  return (
    <div className="interview-progress" data-testid={testId}>
      <span className="interview-progress-label">{label}</span>
      {showDots && (
        <ol className="interview-progress-dots" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => {
            const step = index + 1;
            const state =
              step <= done ? 'done' : step === current ? 'current' : 'todo';
            return <li key={step} className={`is-${state}`} />;
          })}
        </ol>
      )}
      {detail && <span className="interview-progress-detail">{detail}</span>}
    </div>
  );
}
