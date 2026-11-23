import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import logo from '../../brand/gnd-logo@2x.png';
import { useIntroMusic } from '../../audio/useIntroMusic';
import { GlowBackdrop } from '../../backdrop/GlowBackdrop';

/**
 * GND onboarding chrome: logo top-left, a quiet "Skip setup" top-right (where
 * the designs show "Sign in"; this app has no accounts), and one step at a
 * time in the middle. Each step's heading takes focus so screen readers
 * announce the new screen.
 */
export function OnboardingFrame({
  stepKey,
  align = 'center',
  onSkip,
  skipDisabled,
  skipLabel = 'Skip setup',
  leaving = false,
  music = false,
  children,
}: {
  /** Play the intro music (first run only), with a mute button. */
  music?: boolean;
  stepKey: string;
  /** The current step's text is animating out before the next one. */
  leaving?: boolean;
  align?: 'center' | 'top';
  onSkip?: () => void;
  skipDisabled?: boolean;
  skipLabel?: string;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const sound = useIntroMusic(music);
  // The first screen waits for the window and background to arrive.
  const [arriving, setArriving] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setArriving(false), 2200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    content.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [stepKey]);

  return (
    <div
      className={`gnd-onboarding${arriving ? ' is-arriving' : ''}`}
      data-testid="onboarding"
    >
      <GlowBackdrop density="full" />
      <div className="gnd-onboarding-drag" aria-hidden="true" />
      <header className="gnd-onboarding-header">
        <img className="gnd-logo" src={logo} alt="GND" draggable={false} />
        <div className="gnd-onboarding-tools">
          {music && (
            <button
              type="button"
              className="gnd-sound"
              aria-pressed={!sound.muted}
              aria-label={sound.muted ? 'Play music' : 'Mute music'}
              title={sound.muted ? 'Play music' : 'Mute music'}
              onClick={sound.toggle}
            >
              {sound.muted ? (
                <VolumeX aria-hidden="true" />
              ) : (
                <Volume2 aria-hidden="true" />
              )}
            </button>
          )}
          {onSkip && (
            <button
              type="button"
              className="gnd-onboarding-skip"
              disabled={skipDisabled}
              onClick={onSkip}
            >
              {skipLabel}
            </button>
          )}
        </div>
      </header>
      <main
        className={`gnd-onboarding-main gnd-onboarding-main-${align}`}
        aria-live="polite"
      >
        <div
          ref={content}
          key={stepKey}
          className={`gnd-step${leaving ? ' is-leaving' : ''}`}
          data-testid={`onboarding-step-${stepKey}`}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

/** Heading + optional lead, the repeated top of every step. */
export function StepHeading({
  eyebrow,
  title,
  lead,
  hero,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  hero?: boolean;
}) {
  return (
    <div className="gnd-step-heading">
      {eyebrow && <p className="gnd-eyebrow">{eyebrow}</p>}
      <h1 tabIndex={-1} className={hero ? 'gnd-hero-title' : 'gnd-title'}>
        {title}
      </h1>
      {lead && <div className="gnd-lead">{lead}</div>}
    </div>
  );
}
