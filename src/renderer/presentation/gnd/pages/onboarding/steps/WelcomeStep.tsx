import React from 'react';
import { Buddy } from '../../../buddy/Buddy';
import { Button } from '../../../../components/Button';
import { StepHeading } from '../OnboardingFrame';

export function WelcomeStep({
  onBegin,
  busy,
}: {
  onBegin: () => void;
  busy?: boolean;
}) {
  return (
    <div className="gnd-stack gnd-welcome">
      <Buddy
        className="gnd-welcome-buddy"
        size={120}
        say="Hi! I’ll help you find what’s next."
      />
      <StepHeading
        hero
        title={
          <>
            Your CV.
            <br />
            Your next move.
          </>
        }
        lead={<p className="gnd-welcome-lead">Roles that fit, CV for each</p>}
      />
      <Button size="hero" disabled={busy} onClick={onBegin}>
        Begin
      </Button>
    </div>
  );
}
