import React, { useLayoutEffect, useRef } from 'react';
import { UserRound } from 'lucide-react';
import type {
  InsightsDetail,
  InterviewQuestionView,
} from '../../../../shared/contracts';
import { InterviewQuestionCard } from './InterviewQuestionCard';
import { InterviewReviewCard } from './InterviewReviewCard';
import { InterviewCoachingCard } from './InterviewCoachingCard';
import './DeepLoopConversation.css';

/** Only persisted detail and the backend's current question are rendered. */
export function DeepLoopConversation({
  detail,
  currentQuestion,
  currentIsReassessment,
  role,
}: {
  detail: InsightsDetail | null;
  currentQuestion: InterviewQuestionView | null;
  currentIsReassessment: boolean;
  role: string | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousQuestion = useRef(currentQuestion?.id);
  const rounds = detail?.rounds ?? [];
  const currentInDetail = rounds.some((round) =>
    round.questions.some((question) => question.id === currentQuestion?.id),
  );
  const lastContent =
    rounds
      .map(
        (round) =>
          `${round.id}:${round.questions.map((q) => `${q.id}:${q.answer !== null}`).join(',')}:${round.review?.id}:${round.coaching?.id}`,
      )
      .join('|') + currentQuestion?.id;

  useLayoutEffect(() => {
    const node = track.current;
    if (node) {
      // Sticky controls can overlap the track in a short outlet. Reserve that
      // area inside its scroll range so the latest saved turn stays readable.
      const controls = node.parentElement?.querySelector(
        '.deep-loop-composer, .deep-loop-actions',
      );
      const overlap = controls
        ? node.getBoundingClientRect().bottom -
          controls.getBoundingClientRect().top
        : 0;
      node.style.paddingBottom = `${Math.max(12, overlap + 12)}px`;
    }
    const newQuestion =
      currentQuestion !== null &&
      previousQuestion.current !== currentQuestion.id;
    previousQuestion.current = currentQuestion?.id;
    if (
      rounds.length === 1 &&
      rounds[0].questions.length === 1 &&
      rounds[0].questions[0].answer === null
    ) {
      if (node) node.scrollTop = 0;
      return;
    }
    if (node && (stickToBottom.current || newQuestion)) {
      node.scrollTop = node.scrollHeight;
      stickToBottom.current = true;
    }
  }, [lastContent]);

  return (
    <div
      ref={track}
      className="deep-loop-conversation"
      aria-label="Saved interview conversation"
      data-testid="deep-loop-conversation"
      onScroll={(event) => {
        const node = event.currentTarget;
        stickToBottom.current =
          node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      }}
    >
      {rounds.map((round) => (
        <section
          key={round.id}
          className="deep-loop-round"
          aria-label={`Round ${round.ordinal}`}
        >
          <p className="deep-loop-round-label">
            {round.reassessmentOfRoundId ? 'Reassessment' : 'Round'}{' '}
            {round.ordinal}
            {round.reassessmentOfRoundId && ' · linked to an earlier round'}
          </p>
          {round.questions.map((question) => (
            <React.Fragment key={question.id}>
              <InterviewQuestionCard
                question={question.question}
                competency={question.competency}
                kind={
                  round.reassessmentOfRoundId ? 'reassessment' : question.kind
                }
                role={role}
                textId={
                  question.id === currentQuestion?.id
                    ? 'deep-loop-question-text'
                    : undefined
                }
                data-testid={
                  question.id === currentQuestion?.id
                    ? 'session-question'
                    : undefined
                }
              />
              {question.answer !== null && (
                <div
                  className="deep-loop-answer"
                  data-testid="deep-loop-saved-answer"
                >
                  <span className="deep-loop-answer-label">
                    <UserRound size={15} aria-hidden="true" /> You
                  </span>
                  <p>{question.answer}</p>
                </div>
              )}
            </React.Fragment>
          ))}
          {round.review && <InterviewReviewCard review={round.review} />}
          {round.coaching && (
            <InterviewCoachingCard coaching={round.coaching} />
          )}
        </section>
      ))}
      {currentQuestion && !currentInDetail && (
        <InterviewQuestionCard
          question={currentQuestion.question}
          competency={currentQuestion.competency}
          kind={currentIsReassessment ? 'reassessment' : 'primary'}
          role={role}
          textId="deep-loop-question-text"
          data-testid="session-question"
        />
      )}
    </div>
  );
}
