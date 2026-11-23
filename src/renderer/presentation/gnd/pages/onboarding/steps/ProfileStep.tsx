import React from 'react';
import { Buddy } from '../../../buddy/Buddy';
import { Button } from '../../../../components/Button';
import { StepHeading } from '../OnboardingFrame';
import type { ProfileCard } from '../onboardingPlan';

/**
 * The profile card doubles as the CV approval: nothing read from the CV is
 * saved to the profile until the person presses "Looks right".
 */
export function ProfileStep({
  card,
  busy,
  error,
  onConfirm,
  onBack,
}: {
  card: ProfileCard;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className="gnd-stack gnd-profile-step">
      <span className="gnd-float gnd-float-a" aria-hidden="true" />
      <span className="gnd-float gnd-float-b" aria-hidden="true" />
      <span className="gnd-float gnd-float-c" aria-hidden="true" />
      <StepHeading
        eyebrow="Made around you"
        title="Your profile, taking shape"
      />
      <article className="gnd-profile-card" aria-label="Your profile">
        <Buddy className="gnd-profile-buddy" size={78} mood="happy" />
        <h2>{card.name}</h2>
        {card.details.length > 0 && (
          <p className="gnd-profile-details">
            {card.details.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
        )}
        {card.lookingFor && (
          <dl>
            <dt>Looking for</dt>
            <dd>{card.lookingFor}</dd>
            {card.arrangement && (
              <>
                <dt>Work arrangement</dt>
                <dd>{card.arrangement}</dd>
              </>
            )}
          </dl>
        )}
      </article>
      {error && (
        <p className="gnd-message" role="alert">
          {error}
        </p>
      )}
      <div className="gnd-actions gnd-actions-row">
        <Button size="hero" disabled={busy} onClick={onConfirm}>
          {busy ? 'Setting up…' : 'Looks right'}
        </Button>
        <button
          type="button"
          className="gnd-text-link"
          disabled={busy}
          onClick={onBack}
        >
          Go back
        </button>
      </div>
      <p className="gnd-footnote">You can edit anything later in Profile.</p>
    </div>
  );
}
