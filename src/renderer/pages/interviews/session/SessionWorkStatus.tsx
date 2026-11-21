import React, { type ReactNode } from 'react';
import { InterviewStatusBubble } from '../../../presentation/components/interviews/InterviewStatusBubble';
import { statusCopy } from './statusCopy';
import type { WorkStatus } from './workStatus';

/**
 * The status bubble for running backend work, sized by `selectWorkStatus`:
 * large for the first question and results, inline for waits the user is
 * part of, a chip for background work that must not block answering.
 */
export function SessionWorkStatus({
  status,
  children,
  'data-testid': testId = 'session-work-status',
}: {
  status: WorkStatus;
  children?: ReactNode;
  'data-testid'?: string;
}) {
  if (status.kind !== 'running') return null;
  const copy = statusCopy[status.category];

  return (
    <InterviewStatusBubble
      variant={status.presentation}
      icon={copy.icon}
      label={copy.label}
      phrases={copy.phrases}
      data-testid={testId}
    >
      {children}
    </InterviewStatusBubble>
  );
}
