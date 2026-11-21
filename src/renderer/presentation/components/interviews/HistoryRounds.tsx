import React from 'react';
import type { InsightsDetail } from '../../../../shared/contracts';
import { Disclosure } from '../Disclosure';
import { InterviewReviewCard } from './InterviewReviewCard';
import { InterviewCoachingCard } from './InterviewCoachingCard';

export function HistoryRounds({
  rounds,
  showReviews,
}: {
  rounds: InsightsDetail['rounds'];
  showReviews: boolean;
}) {
  if (rounds.length === 0) return <p>No questions have been saved yet.</p>;
  return (
    <section aria-label="Saved questions and answers">
      <h3>Questions & answers</h3>
      <ol className="history-rounds">
        {rounds.map((round) => (
          <li key={round.id}>
            <Disclosure
              label={`Round ${round.ordinal}${round.reassessmentOfRoundId ? ' · reassessment' : ''}`}
            >
              {round.questions.map((question) => (
                <div key={question.id} className="history-turn">
                  <strong>
                    {question.kind === 'follow_up' ? 'Follow-up' : 'Question'}
                    {question.competency ? ` · ${question.competency}` : ''}
                  </strong>
                  <p>{question.question}</p>
                  {question.answer !== null && (
                    <>
                      <strong>Your answer</strong>
                      <p>{question.answer}</p>
                    </>
                  )}
                </div>
              ))}
              {showReviews && round.review && (
                <InterviewReviewCard review={round.review} />
              )}
              {showReviews && round.coaching && (
                <InterviewCoachingCard coaching={round.coaching} />
              )}
            </Disclosure>
          </li>
        ))}
      </ol>
    </section>
  );
}
