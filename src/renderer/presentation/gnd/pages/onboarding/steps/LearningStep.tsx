import React, { useEffect, useState } from 'react';
import { getCvImport } from '../../../../../api';
import type { CvImport } from '../../../../../../shared/contracts';
import { Buddy } from '../../../buddy/Buddy';
import { Button } from '../../../../components/Button';
import { StepHeading } from '../OnboardingFrame';

const POLL_MS = 800;

/**
 * Waits for the CV import to settle while a stylised CV is "read" line by
 * line. A partial read still continues: the person can add roles by hand.
 */
export function LearningStep({
  cvImport,
  onRead,
  onRetry,
  onSetupAi,
  onSkip,
}: {
  cvImport: CvImport;
  onRead: (settled: CvImport) => void;
  onRetry: () => void;
  onSetupAi: () => void;
  onSkip: () => void;
}) {
  const [failed, setFailed] = useState<'file' | 'model' | null>(null);

  useEffect(() => {
    let active = true;
    let timer = 0;
    // Keep the reading moment visible briefly even when parsing is instant.
    const shownUntil = Date.now() + 2400;

    async function poll(current: CvImport) {
      if (!active) return;
      if (current.status === 'processing') {
        timer = window.setTimeout(async () => {
          try {
            void poll(await getCvImport(current.id));
          } catch {
            if (active) setFailed('file');
          }
        }, POLL_MS);
        return;
      }
      if (current.status === 'failed' || current.status === 'cancelled') {
        setFailed(
          current.diagnostics.errorCode === 'MODEL_UNAVAILABLE'
            ? 'model'
            : 'file',
        );
        return;
      }
      timer = window.setTimeout(
        () => active && onRead(current),
        Math.max(0, shownUntil - Date.now()),
      );
    }

    void poll(cvImport);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [cvImport.id]);

  return (
    <div className="gnd-stack gnd-learning">
      <StepHeading title="Learning about you" />
      <div className="gnd-cv-stage">
        <div
          className={`gnd-cv-sheet${failed ? ' is-paused' : ''}`}
          aria-hidden="true"
        >
          <div className="gnd-cv-head">
            <span className="gnd-cv-name" />
            <span className="gnd-cv-mark">CV</span>
            <span className="gnd-cv-sub" />
          </div>
          {[0, 1, 2].map((section) => (
            <div key={section} className="gnd-cv-section">
              <span className="gnd-cv-label" />
              <span className="gnd-cv-line" />
              <span className="gnd-cv-line" />
              <span className="gnd-cv-line is-short" />
            </div>
          ))}
        </div>
        <Buddy
          className="gnd-cv-buddy"
          size={92}
          mood={failed ? 'thinking' : 'working'}
        />
      </div>
      {failed ? (
        <div className="gnd-stack gnd-stack-tight" role="alert">
          <p className="gnd-lead">
            {failed === 'model'
              ? 'Reading your CV needs local AI, and it isn’t ready yet. Set it up, or carry on and add your roles yourself.'
              : 'We couldn’t read that file. Try another PDF or DOCX, or carry on and add your roles yourself.'}
          </p>
          <div className="gnd-actions gnd-actions-row">
            <Button
              size="hero"
              onClick={failed === 'model' ? onSetupAi : onRetry}
            >
              {failed === 'model' ? 'Set up local AI' : 'Try another file'}
            </Button>
            <button type="button" className="gnd-text-link" onClick={onSkip}>
              Continue without it
            </button>
          </div>
        </div>
      ) : (
        <p className="gnd-footnote" role="status">
          This should only take a few minutes
        </p>
      )}
    </div>
  );
}
