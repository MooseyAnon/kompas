import React from 'react';
import { RotateCw } from 'lucide-react';
import type {
  InsightsDetail,
  InterviewSessionSummaryResult,
} from '../../../../shared/contracts';
import { Button } from '../../../presentation/components/Button';
import { InterviewResultRound } from '../../../presentation/components/interviews/InterviewResultRound';
import { InterviewResultSummary } from '../../../presentation/components/interviews/InterviewResultSummary';
import {
  InterviewReviewCard,
  barKindLabels,
} from '../../../presentation/components/interviews/InterviewReviewCard';
import { useQuickFireBreakdown } from './useQuickFireBreakdown';
import './QuickFire.css';

type DetailRound = InsightsDetail['rounds'][number];

function benchmarkLabel(bar: InsightsDetail['bar'] | null) {
  if (!bar) return null;
  return `Pass mark ${bar.passThreshold} · ${barKindLabels[bar.kind]} (provisional)`;
}

/**
 * The published Quick-fire result. The roll-up comes from the durable
 * `state.result`; the question-by-question answers and reviews are read once
 * from the released Insights detail.
 */
export function QuickFireResults({
  sessionId,
  result,
}: {
  sessionId: string;
  result: InterviewSessionSummaryResult;
}) {
  const { load, reload } = useQuickFireBreakdown(sessionId);
  const detailRounds =
    load.status === 'ready'
      ? new Map(load.detail.rounds.map((round) => [round.id, round]))
      : null;
  const rounds = [...result.rounds].sort((a, b) => a.ordinal - b.ordinal);

  return (
    <div className="quick-fire-results" data-testid="quick-fire-results">
      <InterviewResultSummary
        title="Your Quick-fire results"
        averageScore={result.averageScore}
        passCount={result.passCount}
        failCount={result.failCount}
        unscoredCount={result.unscoredCount}
        benchmark={
          load.status === 'ready' ? benchmarkLabel(load.detail.bar) : null
        }
        recommendation={result.recommendation}
        narrative={result.narrative ?? null}
        narrativeUnavailable={result.narrativeUnavailable ?? false}
      />

      <section
        className="quick-fire-breakdown"
        aria-labelledby="quick-fire-breakdown-title"
      >
        <h3 id="quick-fire-breakdown-title">Question by question</h3>
        {load.status === 'loading' && (
          <p className="session-quiet" role="status">
            Loading your answers…
          </p>
        )}
        {load.status === 'error' && (
          <div className="quick-fire-inline-alert" role="alert">
            <span>{load.message}</span>
            <Button
              variant="secondary"
              leadingIcon={<RotateCw aria-hidden="true" />}
              onClick={() => void reload()}
            >
              Try again
            </Button>
          </div>
        )}
        <ol className="quick-fire-breakdown-list">
          {rounds.map((round, index) => {
            const detail = detailRounds?.get(round.roundId);
            return (
              <InterviewResultRound
                key={round.roundId}
                position={index + 1}
                question={primaryQuestion(detail)?.question}
                competency={round.competency}
                decision={round.decision}
                score={round.score}
                details={detail ? <RoundDetails round={detail} /> : null}
                data-testid={`quick-fire-result-round-${index + 1}`}
              />
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function primaryQuestion(round: DetailRound | undefined) {
  return round?.questions.find((question) => question.kind === 'primary');
}

function RoundDetails({ round }: { round: DetailRound }) {
  const answer = primaryQuestion(round)?.answer;
  return (
    <div className="quick-fire-round-details">
      {answer && (
        <div className="quick-fire-round-answer">
          <h4>Your answer</h4>
          <p>{answer}</p>
        </div>
      )}
      {round.review && (
        <InterviewReviewCard
          review={round.review}
          data-testid={`quick-fire-review-${round.ordinal}`}
        />
      )}
    </div>
  );
}
