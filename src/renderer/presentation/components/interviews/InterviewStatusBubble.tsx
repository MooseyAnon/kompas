import React, { useEffect, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import whiteFlower from '../../meadow/assets/single-white-flower.png';
import yellowFlowers from '../../meadow/assets/two-yello-flower.png';
import grass from '../../meadow/assets/grass-tuft-2-v1.png';
import { MeadowCardCorner } from '../../meadow/decorations/MeadowCardCorner';
import './InterviewStatusBubble.css';

/**
 * `large`: central illustrated status (first question, final results).
 * `inline`: a compact row beside content (review, next question, STT).
 * `chip`: a small non-blocking background indicator.
 */
export type InterviewStatusBubbleVariant = 'large' | 'inline' | 'chip';

/** `transcription` gives Audio STT its own look, apart from model work. */
export type InterviewStatusBubbleTone = 'model' | 'transcription';

export const STATUS_PHRASE_INTERVAL_MS = 4000;

/**
 * Meadow-branded status for interview work. Every variant takes the same
 * props. `label` is the precise status and is announced politely once per
 * change; `phrases` are decorative copy that rotate slowly only while
 * `active`, are never announced and restart from the first phrase when the
 * label changes. No fetching or lifecycle policy here.
 */
export function InterviewStatusBubble({
  variant,
  tone = 'model',
  icon: Icon,
  label,
  phrases = [],
  active = true,
  intervalMs = STATUS_PHRASE_INTERVAL_MS,
  children,
  'data-testid': testId,
}: {
  variant: InterviewStatusBubbleVariant;
  tone?: InterviewStatusBubbleTone;
  icon: LucideIcon;
  label: string;
  phrases?: readonly string[];
  active?: boolean;
  intervalMs?: number;
  children?: ReactNode;
  'data-testid'?: string;
}) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const phraseCount = phrases.length;
  // A stable key so callers may pass a fresh array without resetting rotation.
  const phraseKey = phrases.join('\n');

  useEffect(() => {
    setPhraseIndex(0);
    if (!active || phraseCount < 2) return;

    const timer = window.setInterval(
      () => setPhraseIndex((index) => (index + 1) % phraseCount),
      intervalMs,
    );
    return () => window.clearInterval(timer);
  }, [active, intervalMs, label, phraseCount, phraseKey]);

  const phrase = phrases[phraseIndex];
  const large = variant === 'large';
  const LabelTag = large ? 'h2' : 'p';

  return (
    <div
      className={`interview-status interview-status-${variant} is-${tone}${active ? ' is-active' : ''}`}
      data-testid={testId}
      data-variant={variant}
      data-tone={tone}
    >
      <div className="interview-status-art" aria-hidden="true">
        <span className="interview-status-halo" />
        <span className="interview-status-bubble">
          <Icon
            size={large ? 34 : variant === 'inline' ? 20 : 14}
            strokeWidth={1.9}
          />
        </span>
        {large && (
          <>
            <img className="interview-status-grass" src={grass} alt="" />
            <img className="interview-status-white" src={whiteFlower} alt="" />
            <img
              className="interview-status-yellow"
              src={yellowFlowers}
              alt=""
            />
          </>
        )}
      </div>

      <div className="interview-status-copy">
        <div role="status" aria-live="polite">
          <LabelTag className="interview-status-label">{label}</LabelTag>
        </div>
        {phrase && (
          <p
            key={phrase}
            className="interview-status-phrase"
            aria-hidden="true"
            data-testid={testId ? `${testId}-phrase` : undefined}
          >
            {phrase}
          </p>
        )}
        {children}
      </div>

      {large && <MeadowCardCorner variant="floral" />}
      {variant === 'inline' && (
        <img
          className="interview-status-sprig"
          src={whiteFlower}
          alt=""
          aria-hidden="true"
        />
      )}
    </div>
  );
}
