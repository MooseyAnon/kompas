import React from 'react';
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Info,
  Trophy,
} from 'lucide-react';
import { MeadowCardCorner } from '../../meadow/decorations/MeadowCardCorner';
import { InterviewPhaseBadge } from './InterviewPhaseBadge';
import { FeedbackList } from './InterviewReviewCard';
import './InterviewResultSummary.css';

export interface InterviewResultNarrative {
  strengths: readonly string[];
  gaps: readonly string[];
  recommendations: readonly string[];
}

function formatScore(score: number) {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/**
 * The published session result: the app-computed average score (or an
 * explicit "Unscored" when nothing could be scored, never zero), decision
 * counts, and the optional written narrative. When the narrative is
 * unavailable it says so instead of showing empty recommendations.
 */
export function InterviewResultSummary({
  title,
  averageScore,
  passCount,
  failCount,
  unscoredCount,
  benchmark,
  recommendation,
  narrative,
  narrativeUnavailable,
  'data-testid': testId = 'interview-result-summary',
}: {
  title: string;
  averageScore: number | null;
  passCount: number;
  failCount: number;
  unscoredCount: number;
  /** For example `Pass mark 70 · Practice benchmark`. */
  benchmark?: string | null;
  recommendation: string | null;
  narrative: InterviewResultNarrative | null;
  narrativeUnavailable: boolean;
  'data-testid'?: string;
}) {
  const titleId = `${testId}-title`;
  const hasNarrative =
    narrative !== null &&
    narrative.strengths.length +
      narrative.gaps.length +
      narrative.recommendations.length >
      0;

  return (
    <section
      className="interview-result-summary"
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <div className="interview-result-score">
        <span className="interview-result-score-icon" aria-hidden="true">
          <Trophy size={22} />
        </span>
        <div className="interview-result-score-copy">
          <h2 id={titleId}>{title}</h2>
          <p
            className="interview-result-score-value"
            data-testid={`${testId}-score`}
          >
            {averageScore === null ? (
              'Unscored'
            ) : (
              <>
                {formatScore(averageScore)}
                <span> / 100 average</span>
              </>
            )}
          </p>
          {averageScore === null && (
            <p className="interview-result-note">
              None of your answers could be scored, so there is no average.
            </p>
          )}
          {benchmark && <p className="interview-result-note">{benchmark}</p>}
        </div>
      </div>

      <ul className="interview-result-counts" aria-label="Answer outcomes">
        {passCount > 0 && (
          <li>
            <InterviewPhaseBadge
              icon={CircleCheck}
              tone="success"
              label={`${passCount} met the bar`}
            />
          </li>
        )}
        {failCount > 0 && (
          <li>
            <InterviewPhaseBadge
              icon={CircleAlert}
              tone="warning"
              label={`${failCount} below the bar`}
            />
          </li>
        )}
        {unscoredCount > 0 && (
          <li>
            <InterviewPhaseBadge
              icon={CircleHelp}
              tone="neutral"
              label={`${unscoredCount} unscored`}
            />
          </li>
        )}
      </ul>

      {hasNarrative && (
        <div
          className="interview-result-narrative"
          data-testid={`${testId}-narrative`}
        >
          {narrative.strengths.length > 0 && (
            <FeedbackList title="Strengths" items={narrative.strengths} />
          )}
          {narrative.gaps.length > 0 && (
            <FeedbackList title="To strengthen" items={narrative.gaps} />
          )}
          {narrative.recommendations.length > 0 && (
            <FeedbackList title="Try next" items={narrative.recommendations} />
          )}
        </div>
      )}
      {!hasNarrative && narrativeUnavailable && (
        <p
          className="interview-result-unavailable"
          data-testid={`${testId}-narrative-unavailable`}
        >
          <Info size={15} aria-hidden="true" />A written summary couldn’t be
          prepared this time. Your score and the question-by-question reviews
          below come straight from your saved answers.
        </p>
      )}
      {recommendation && (
        <p className="interview-result-note">{recommendation}</p>
      )}

      <MeadowCardCorner variant="floral" />
    </section>
  );
}
