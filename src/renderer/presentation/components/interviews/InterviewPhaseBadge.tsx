import React from 'react';
import type { LucideIcon } from 'lucide-react';
import './InterviewPhaseBadge.css';

export type InterviewPhaseTone =
  | 'neutral'
  | 'active'
  | 'paused'
  | 'success'
  | 'warning'
  | 'error';

/**
 * A compact phase/method/status pill. The text carries the meaning; tone and
 * icon only reinforce it, so nothing relies on colour alone.
 */
export function InterviewPhaseBadge({
  icon: Icon,
  label,
  tone = 'neutral',
  'data-testid': testId,
}: {
  icon?: LucideIcon;
  label: string;
  tone?: InterviewPhaseTone;
  'data-testid'?: string;
}) {
  return (
    <span
      className={`interview-phase-badge is-${tone}`}
      data-testid={testId}
      data-tone={tone}
    >
      {Icon && <Icon size={13} aria-hidden="true" />}
      {label}
    </span>
  );
}
