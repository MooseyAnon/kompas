import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { cancelDiscoveryRun, getDiscoveryWorkflowState } from '../../../../api';
import { Buddy } from '../../buddy/Buddy';
import { Button } from '../../../components/Button';
import type { DiscoveryWorkflowState } from '../../../../../shared/contracts';
import { progressFor, stoppedShort } from './searchFilterRules';
import './FindingRoles.css';

const POLL_MS = 1500;

/**
 * "Finding your roles": a full-window screen with no way back while the
 * search runs. It follows the run and opens the results when it finishes.
 */
export function FindingRoles({
  runId,
  summary,
  onDone,
  onRetry,
  onFilters,
}: {
  runId: string;
  /** e.g. "Senior Product Designer, Design Lead · London · Hybrid" */
  summary?: string;
  onDone: (state: DiscoveryWorkflowState | null) => void;
  onRetry: () => void;
  onFilters: () => void;
}) {
  const [state, setState] = useState<DiscoveryWorkflowState | null>(null);
  const [failedReads, setFailedReads] = useState(0);
  const [details, setDetails] = useState<{ now: string; before: string }>({
    now: 'Getting started',
    before: '',
  });
  const done = useRef(false);
  const finish = useRef(onDone);
  finish.current = onDone;
  const progress = progressFor(state);
  const problem = stoppedShort(state);
  const failed =
    !!state &&
    (state.status === 'failed' || state.status === 'interrupted') &&
    !state.workActive &&
    progress.found === 0;

  useEffect(() => {
    let live = true;
    let timer: number;
    const poll = async () => {
      try {
        const next = await getDiscoveryWorkflowState(runId);
        if (!live) return;
        setState(next);
        setFailedReads(0);
        const finished = next.status !== 'running' && !next.workActive;
        const empty =
          (next.status === 'failed' || next.status === 'interrupted') &&
          next.counts.admitted === 0;
        if (finished && !empty) {
          if (!done.current) {
            done.current = true;
            window.setTimeout(() => live && finish.current(next), 900);
          }
          return;
        }
        if (finished) return;
      } catch {
        if (!live) return;
        setFailedReads((n) => n + 1);
      }
      timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    setDetails((current) =>
      current.now === progress.detail
        ? current
        : { now: progress.detail, before: current.now },
    );
  }, [progress.detail]);

  async function stop() {
    if (done.current) return;
    done.current = true;
    try {
      await cancelDiscoveryRun(runId);
    } catch {
      /* already finished: show what was found either way */
    }
    finish.current(state);
  }

  return createPortal(
    <div
      className="gnd-finding"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gnd-finding-title"
    >
      <div className="gnd-finding-logo" aria-hidden="true">
        GND
      </div>
      <main className="gnd-finding-body">
        {failed ? (
          <>
            <div className="gnd-finding-titles">
              <p className="gnd-eyebrow">Search stopped</p>
              <h1 id="gnd-finding-title" className="gnd-page-title">
                The search couldn’t finish
              </h1>
              <p className="gnd-muted">{problem}</p>
            </div>
            <div className="gnd-actions-row">
              <Button onClick={onRetry}>Try again</Button>
              <Button variant="outline" onClick={onFilters}>
                Change filters
              </Button>
            </div>
          </>
        ) : (
          <>
            <Buddy
              className="gnd-finding-buddy"
              size={110}
              mood={progress.finished ? 'happy' : 'working'}
              say={
                progress.finished
                  ? 'Found some for you!'
                  : 'Looking through LinkedIn and Indeed…'
              }
            />
            <div className="gnd-finding-titles">
              <p className="gnd-eyebrow">
                {progress.finished ? 'Search finished' : 'Searching'}
              </p>
              <h1 id="gnd-finding-title" className="gnd-page-title">
                {progress.finished ? 'All done' : 'Finding your roles…'}
              </h1>
              {summary && <p className="gnd-muted">{summary}</p>}
            </div>
            <div className="gnd-finding-count" aria-live="polite">
              <span key={progress.found} className="gnd-finding-num">
                {progress.found}
              </span>
              <span className="gnd-muted">
                {progress.found === 1
                  ? 'role found'
                  : progress.finished
                    ? 'roles found'
                    : 'roles found so far'}
              </span>
            </div>
            <div
              className="gnd-finding-bar"
              role="progressbar"
              aria-label="Search progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
            >
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            <ol className="gnd-finding-steps">
              {progress.steps.map((step) => (
                <li key={step.label} className={`is-${step.state}`}>
                  <span className="gnd-finding-knob" aria-hidden="true">
                    {step.state === 'done' && <Check />}
                  </span>
                  <div>
                    <p className="gnd-finding-step">{step.label}</p>
                    {step.state === 'now' ? (
                      <div className="gnd-finding-ticker" aria-hidden="true">
                        <span key={`now-${details.now}`} className="is-in">
                          {details.now}
                        </span>
                        {details.before && (
                          <span
                            key={`before-${details.before}`}
                            className="is-out"
                          >
                            {details.before}
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="gnd-muted gnd-finding-summary">
                        {step.summary}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {failedReads >= 3 && (
              <p className="gnd-muted" role="status">
                Still working… progress isn’t updating right now.
              </p>
            )}
            {!progress.finished && (
              <button
                type="button"
                className="gnd-finding-stop"
                onClick={() => void stop()}
              >
                Stop and see what’s been found
              </button>
            )}
          </>
        )}
      </main>
    </div>,
    document.body,
  );
}
