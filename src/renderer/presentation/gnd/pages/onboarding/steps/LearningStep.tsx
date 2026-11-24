import React, { useEffect, useState } from 'react';
import { getCvImport } from '../../../../../api';
import type { CvImport } from '../../../../../../shared/contracts';
import { Buddy } from '../../../buddy/Buddy';
import { Button } from '../../../../components/Button';
import { StepHeading } from '../OnboardingFrame';

const POLL_MS = 800;

type Failure = { kind: 'file' | 'model'; code: string | null };

/** Plain words for why reading failed, so it's clear what to try next. */
export function failureMessage({ kind, code }: Failure): string {
  if (kind === 'model' || code === 'MODEL_UNAVAILABLE')
    return 'Reading your CV needs local AI, and it isn’t ready yet. Set it up, or carry on and add your roles yourself.';
  switch (code) {
    case 'ENCRYPTED_DOCUMENT':
      return 'That file is password-protected. Save a copy without a password and try again.';
    case 'UNSUPPORTED_FORMAT':
    case 'CORRUPT_DOCUMENT':
      return 'That file couldn’t be opened. Try exporting it again as a PDF or DOCX.';
    case 'EXTRACTION_FAILED':
      return 'We couldn’t find any text in that file. It may be a scan or an image; try a PDF with selectable text.';
    case 'TIMEOUT':
      return 'Local AI took too long to read your CV. Try again, or carry on and add your roles yourself.';
    case 'RESOURCE_LIMIT':
      return 'Your CV is longer than your local AI model can read at once. Try a shorter version, or carry on and add your roles yourself.';
    case 'INVALID_RESPONSE':
    case 'INVALID_EVIDENCE':
    case 'MODEL_FAILED':
      return 'Local AI read your CV but its answer didn’t make sense. Try again, or carry on and add your roles yourself.';
    default:
      return 'We couldn’t read that file. Try another PDF or DOCX, or carry on and add your roles yourself.';
  }
}

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
  const [failed, setFailed] = useState<Failure | null>(null);

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
            if (active) setFailed({ kind: 'file', code: null });
          }
        }, POLL_MS);
        return;
      }
      if (current.status === 'failed' || current.status === 'cancelled') {
        const code = current.diagnostics.errorCode;
        setFailed({
          kind: code === 'MODEL_UNAVAILABLE' ? 'model' : 'file',
          code,
        });
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
          <p className="gnd-lead">{failureMessage(failed)}</p>
          {failed.code && failed.kind !== 'model' && (
            <p className="gnd-help" data-testid="gnd-cv-error-code">
              Error code: {failed.code}
            </p>
          )}
          <div className="gnd-actions gnd-actions-row">
            <Button
              size="hero"
              onClick={failed.kind === 'model' ? onSetupAi : onRetry}
            >
              {failed.kind === 'model' ? 'Set up local AI' : 'Try another file'}
            </Button>
            <button type="button" className="gnd-text-link" onClick={onSkip}>
              Continue without it
            </button>
          </div>
        </div>
      ) : (
        <p className="gnd-footnote" role="status">
          Nearly there. Finishing reading your CV…
        </p>
      )}
    </div>
  );
}
