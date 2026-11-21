import React from 'react';
import {
  BriefcaseBusiness,
  MessageCircleQuestion,
  RefreshCcw,
  Tag,
  UserRound,
} from 'lucide-react';
import { MeadowCardCorner } from '../../meadow/decorations/MeadowCardCorner';
import './InterviewQuestionCard.css';

export type InterviewQuestionKind = 'primary' | 'follow_up' | 'reassessment';

const kindLabels: Record<InterviewQuestionKind, string> = {
  primary: 'Question',
  follow_up: 'Follow-up',
  reassessment: 'Reassessment',
};
const kindIcons = {
  primary: UserRound,
  follow_up: MessageCircleQuestion,
  reassessment: RefreshCcw,
} as const;

/**
 * The prominent question surface for either runner. Pass `textId` so the
 * answer composer can reference the question with `aria-describedby`.
 */
export function InterviewQuestionCard({
  question,
  competency,
  kind = 'primary',
  role,
  position,
  textId,
  'data-testid': testId,
}: {
  question: string;
  competency: string | null;
  kind?: InterviewQuestionKind;
  /** The frozen target role, when the session has one. */
  role?: string | null;
  /** For example `Question 2 of 5`. */
  position?: string;
  textId?: string;
  'data-testid'?: string;
}) {
  const KindIcon = kindIcons[kind];

  return (
    <section
      className={`interview-question-card is-${kind}`}
      aria-label={position ?? kindLabels[kind]}
      data-testid={testId}
    >
      <span className="interview-question-avatar" aria-hidden="true">
        <KindIcon size={22} strokeWidth={1.9} />
      </span>

      <div className="interview-question-body">
        <div className="interview-question-meta">
          <span className="interview-question-kind">
            {position ?? kindLabels[kind]}
          </span>
          {competency && (
            <span className="interview-question-competency">
              <Tag size={12} aria-hidden="true" />
              {competency}
            </span>
          )}
          {role && (
            <span className="interview-question-role">
              <BriefcaseBusiness size={12} aria-hidden="true" />
              {role}
            </span>
          )}
        </div>
        <p
          id={textId}
          className="interview-question-text"
          data-testid={testId ? `${testId}-text` : undefined}
        >
          {question}
        </p>
      </div>

      <MeadowCardCorner variant="subtle" />
    </section>
  );
}
