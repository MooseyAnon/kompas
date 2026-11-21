import React, { type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import './InterviewSessionBar.css';

/**
 * Compact active-session header: method, subject, real progress and the
 * contextual session actions. It lays slots out only; callers decide what
 * progress and which actions exist.
 */
export function InterviewSessionBar({
  icon: Icon,
  method,
  title,
  meta,
  progress,
  actions,
  'data-testid': testId,
}: {
  icon: LucideIcon;
  method: string;
  title: string;
  meta?: string | null;
  progress?: ReactNode;
  actions?: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <header className="interview-session-bar" data-testid={testId}>
      <div className="interview-session-bar-identity">
        <span className="interview-session-bar-method">
          <Icon size={15} aria-hidden="true" />
          {method}
        </span>
        <h2 className="interview-session-bar-title">{title}</h2>
        {meta && <span className="interview-session-bar-meta">{meta}</span>}
      </div>
      {progress && (
        <div className="interview-session-bar-progress">{progress}</div>
      )}
      {actions && (
        <div className="interview-session-bar-actions">{actions}</div>
      )}
    </header>
  );
}
