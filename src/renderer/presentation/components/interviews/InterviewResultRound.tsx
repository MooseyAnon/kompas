import React, { type ReactNode } from 'react';
import { CircleDashed, Tag } from 'lucide-react';
import type { InterviewReviewDecision } from '../../../../shared/contracts';
import { Disclosure } from '../Disclosure';
import { InterviewPhaseBadge } from './InterviewPhaseBadge';
import { reviewDecisionBadges } from './InterviewReviewCard';
import './InterviewResultRound.css';

/**
 * One question in a published result: position, question (when loaded),
 * competency, decision and score. A null score reads "Unscored", never zero.
 * `details` (answer and review) sits in a disclosure so the list stays short.
 */
export function InterviewResultRound({
  position,
  question,
  competency,
  decision,
  score,
  details,
  'data-testid': testId,
}: {
  position: number;
  question?: string | null;
  competency: string | null;
  decision: InterviewReviewDecision | null;
  score: number | null;
  details?: ReactNode;
  'data-testid'?: string;
}) {
  const badge = decision
    ? reviewDecisionBadges[decision]
    : { label: 'Not reviewed', tone: 'neutral' as const, icon: CircleDashed };

  return (
    <li className="interview-result-round" data-testid={testId}>
      <span className="interview-result-round-number" aria-hidden="true">
        {position}
      </span>
      <div className="interview-result-round-body">
        <div className="interview-result-round-head">
          <span className="interview-result-round-label">
            Question {position}
          </span>
          {competency && (
            <span className="interview-result-round-competency">
              <Tag size={12} aria-hidden="true" />
              {competency}
            </span>
          )}
          <InterviewPhaseBadge
            icon={badge.icon}
            label={badge.label}
            tone={badge.tone}
          />
          <span
            className="interview-result-round-score"
            data-testid={testId ? `${testId}-score` : undefined}
          >
            {score === null ? 'Unscored' : `${Math.round(score)} / 100`}
          </span>
        </div>
        {question && (
          <p className="interview-result-round-question">{question}</p>
        )}
        {details && (
          <Disclosure
            label="Your answer and review"
            className="interview-result-round-details"
          >
            {details}
          </Disclosure>
        )}
      </div>
    </li>
  );
}
