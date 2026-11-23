import React from 'react';
import type { Navigate } from '../../GndPage';
import {
  MockInterviewArt,
  QuestionsArt,
  ScoreCvArt,
  SkillsArt,
} from './QuickActionArt';
import './QuickActions.css';

type Action = {
  id: string;
  label: string;
  Art: () => React.JSX.Element;
  /** Missing when the back end can't do it yet: shown as coming soon. */
  go?: (navigate: Navigate) => void;
};

export const quickActions: readonly Action[] = [
  {
    id: 'mock-interview',
    label: 'Practise a mock interview',
    Art: MockInterviewArt,
    go: (navigate) =>
      navigate('interviews', { practice: { method: 'deep_loop' } }),
  },
  {
    id: 'practise-questions',
    label: 'Practise interview questions',
    Art: QuestionsArt,
    go: (navigate) =>
      navigate('interviews', { practice: { method: 'quick_fire' } }),
  },
  {
    id: 'add-skills',
    label: 'Add skills to boost your matches',
    Art: SkillsArt,
    go: (navigate) => navigate('profile', { profileTab: 'skills' }),
  },
  { id: 'score-cv', label: 'Score your CV', Art: ScoreCvArt },
];

export function QuickActions({ onNavigate }: { onNavigate: Navigate }) {
  return (
    <section className="gnd-quick" aria-labelledby="quick-actions-title">
      <h2 id="quick-actions-title" className="gnd-section-title">
        Quick actions
      </h2>
      <ul className="gnd-quick-row">
        {quickActions.map(({ id, label, Art, go }) => (
          <li key={id}>
            {go ? (
              <button
                type="button"
                className="gnd-quick-card"
                data-testid={`quick-${id}`}
                onClick={() => go(onNavigate)}
              >
                <Art />
                <span className="gnd-quick-label">{label}</span>
              </button>
            ) : (
              <div
                className="gnd-quick-card is-soon"
                data-testid={`quick-${id}`}
              >
                <span className="gnd-badge gnd-quick-soon">Coming soon</span>
                <Art />
                <span className="gnd-quick-label">{label}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
