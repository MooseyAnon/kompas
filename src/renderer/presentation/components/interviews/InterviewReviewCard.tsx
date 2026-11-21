import React from 'react';
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  ClipboardCheck,
  type LucideIcon,
} from 'lucide-react';
import type {
  InterviewReviewDecision,
  InterviewReviewView,
} from '../../../../shared/contracts';
import { Disclosure } from '../Disclosure';
import {
  InterviewPhaseBadge,
  type InterviewPhaseTone,
} from './InterviewPhaseBadge';
import './InterviewFeedback.css';

/** Shared wording for a released review decision; text carries the meaning. */
export const reviewDecisionBadges: Record<
  InterviewReviewDecision,
  { label: string; tone: InterviewPhaseTone; icon: LucideIcon }
> = {
  pass: { label: 'Meets the bar', tone: 'success', icon: CircleCheck },
  fail: { label: 'Below the bar', tone: 'warning', icon: CircleAlert },
  unscored: { label: 'Unscored', tone: 'neutral', icon: CircleHelp },
};

export const barKindLabels = {
  target_hiring_bar: 'Target hiring bar',
  practice_benchmark: 'Practice benchmark',
} as const;

/**
 * A committed review. Render it only where the contract releases it: Deep
 * Loop round feedback, or Quick-fire after publication. A null score is shown
 * as unscored, never as zero.
 */
export function InterviewReviewCard({
  review,
  'data-testid': testId = 'interview-review',
}: {
  review: InterviewReviewView;
  'data-testid'?: string;
}) {
  const decision = reviewDecisionBadges[review.decision];
  const titleId = `${testId}-title`;

  return (
    <section
      className="interview-feedback is-review"
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <span className="interview-feedback-avatar" aria-hidden="true">
        <ClipboardCheck size={20} />
      </span>
      <div className="interview-feedback-body">
        <header className="interview-feedback-header">
          <h3 id={titleId}>Review</h3>
          <InterviewPhaseBadge
            icon={decision.icon}
            label={decision.label}
            tone={decision.tone}
            data-testid={`${testId}-decision`}
          />
          <span
            className="interview-feedback-score"
            data-testid={`${testId}-score`}
          >
            {review.score === null
              ? 'No score'
              : `Score ${Math.round(review.score)} / 100`}
            {review.passThreshold !== null &&
              ` · pass mark ${review.passThreshold}`}
          </span>
          <span className="interview-feedback-meta">
            Provisional
            {review.barKind && ` · ${barKindLabels[review.barKind]}`}
          </span>
        </header>

        {review.unscoredReason && (
          <p className="interview-feedback-note">{review.unscoredReason}</p>
        )}
        {review.needsMoreEvidence && (
          <p className="interview-feedback-note">
            The reviewer needed more evidence to judge some criteria.
          </p>
        )}

        <div className="interview-feedback-columns">
          {review.strengths.length > 0 && (
            <FeedbackList title="Strengths" items={review.strengths} />
          )}
          {review.gaps.length > 0 && (
            <FeedbackList title="To strengthen" items={review.gaps} />
          )}
        </div>

        {review.criteria.length > 0 && (
          <Disclosure
            label="Criteria breakdown"
            className="interview-feedback-more"
          >
            <ul className="interview-feedback-criteria">
              {review.criteria.map((criterion) => (
                <li key={criterion.id}>
                  <span className="interview-criterion-head">
                    <strong>{criterion.label}</strong>
                    <span>
                      {criterion.score === null
                        ? 'Unscored'
                        : `${Math.round(criterion.score)} / 100`}
                      {` · weight ${Math.round(criterion.weight * 100)}%`}
                    </span>
                  </span>
                  {criterion.evidence && <p>{criterion.evidence}</p>}
                  {criterion.rationale && <p>{criterion.rationale}</p>}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </section>
  );
}

export function FeedbackList({
  title,
  items,
}: {
  title: string;
  items: readonly string[];
}) {
  return (
    <div className="interview-feedback-list">
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
