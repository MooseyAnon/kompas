import React from 'react';
import { Lightbulb } from 'lucide-react';
import type { InterviewCoachingView } from '../../../../shared/contracts';
import { Disclosure } from '../Disclosure';
import { FeedbackList } from './InterviewReviewCard';
import './InterviewFeedback.css';

/** Coaching after a failed Deep Loop review, shown only when it exists. */
export function InterviewCoachingCard({
  coaching,
  'data-testid': testId = 'interview-coaching',
}: {
  coaching: InterviewCoachingView;
  'data-testid'?: string;
}) {
  const titleId = `${testId}-title`;

  return (
    <section
      className="interview-feedback is-coaching"
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <span className="interview-feedback-avatar" aria-hidden="true">
        <Lightbulb size={20} />
      </span>
      <div className="interview-feedback-body">
        <header className="interview-feedback-header">
          <h3 id={titleId}>Coaching</h3>
        </header>
        <p>{coaching.diagnosis}</p>
        <FeedbackList title="Try this" items={coaching.advice} />
        <p className="interview-feedback-focus">
          <strong>Focus for your next attempt: </strong>
          {coaching.reassessmentFocus}
        </p>
        {coaching.workedExample && (
          <Disclosure
            label="Worked example"
            className="interview-feedback-more"
          >
            <p className="interview-feedback-example">
              {coaching.workedExample}
            </p>
          </Disclosure>
        )}
      </div>
    </section>
  );
}
