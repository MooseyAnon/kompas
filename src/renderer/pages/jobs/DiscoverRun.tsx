import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import { Disclosure } from '../../presentation/components/Disclosure';
import { BriefcaseBusiness, Check, ChevronDown, X } from 'lucide-react';
import { MeadowCardCorner } from '../../presentation/meadow/decorations/MeadowCardCorner';
import type { Destination } from '../../app/destinations';
import type {
  DiscoveryCandidate,
  DiscoveryMatch,
  DiscoveryRun,
  DiscoveryWorkflowState,
} from '../../../shared/contracts/job-discovery';
import {
  ApiError,
  cancelDiscoveryRun,
  getDiscoveryRun,
  getDiscoveryWorkflowState,
  listDiscoveryCandidates,
  listDiscoveryMatches,
} from '../../api';
import { CandidateCard } from './CandidateCard';
import { reasonText } from './discoveryCopy';

const errorText = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : 'Could not refresh discovery. Try again.';

type StageState = 'done' | 'current' | 'pending';

/** Derives stepper progress from persisted counts only; no stage is inferred. */
function stageProgress(
  state: DiscoveryWorkflowState | null,
  running: boolean,
): { label: string; state: StageState }[] {
  const counts = state?.counts;
  const reached = [
    !!(state?.discovery.submitted || state?.discovery.settled),
    !!counts?.admitted,
    !!counts?.verified,
    !!counts?.jdReady,
    !!counts?.matched,
  ];
  const labels = ['searched', 'discovered', 'resolved', 'extracted', 'matched'];
  const current = running ? reached.indexOf(false) : -1;
  return labels.map((label, index) => ({
    label,
    state: reached[index] ? 'done' : index === current ? 'current' : 'pending',
  }));
}

const stageText: Record<StageState, string> = {
  done: 'reached',
  current: 'in progress',
  pending: 'not reached',
};

export function DiscoverRun({
  id,
  savedTitle,
  startWarning,
  onNavigate,
  onRunChanged,
}: {
  id: string;
  savedTitle?: string;
  startWarning: string | null;
  onNavigate?: (next: Destination) => void;
  onRunChanged: () => void;
}) {
  const [run, setRun] = useState<DiscoveryRun | null>(null);
  const [state, setState] = useState<DiscoveryWorkflowState | null>(null);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [matches, setMatches] = useState<DiscoveryMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const cancelPending = useRef(false);
  const statusRef = useRef<string | undefined>(undefined);
  const terminalReported = useRef(false);
  const changed = useRef(onRunChanged);
  changed.current = onRunChanged;

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const results = await Promise.allSettled([
      getDiscoveryRun(id),
      getDiscoveryWorkflowState(id),
      listDiscoveryCandidates(id),
      listDiscoveryMatches(id),
    ] as const);
    if (request !== generation.current) return;
    const [runResult, stateResult, candidatesResult, matchesResult] = results;
    if (runResult.status === 'fulfilled') {
      setRun(runResult.value);
      if (runResult.value.status !== 'running' && !terminalReported.current) {
        terminalReported.current = true;
        changed.current();
      }
    }
    if (stateResult.status === 'fulfilled') setState(stateResult.value);
    if (candidatesResult.status === 'fulfilled')
      setCandidates(candidatesResult.value);
    if (matchesResult.status === 'fulfilled') setMatches(matchesResult.value);
    const failures = results.filter((result) => result.status === 'rejected');
    setError(failures.length ? errorText(failures[0].reason) : null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [refresh]);

  const status = run?.status ?? state?.status;
  statusRef.current = status;
  useEffect(() => {
    if (status !== 'running') return;
    let active = true;
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          if (!active || document.hidden) return;
          void refresh().finally(() => {
            if (active && statusRef.current === 'running') schedule();
          });
        },
        error ? 6000 : 3000,
      );
    };
    schedule();
    const onVisible = () => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        void refresh().finally(() => {
          if (active && statusRef.current === 'running') schedule();
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, error, refresh]);

  async function cancel() {
    if (cancelPending.current || status !== 'running') return;
    cancelPending.current = true;
    setCancelling(true);
    setCancelConfirm(false);
    setCancelError(null);
    try {
      const result = await cancelDiscoveryRun(id);
      if (!mounted.current) return;
      setRun(result);
      await refresh();
    } catch (failure) {
      if (mounted.current) setCancelError(errorText(failure));
    } finally {
      cancelPending.current = false;
      if (mounted.current) setCancelling(false);
    }
  }

  const bySource = new Map(
    state?.candidates.map((item) => [item.sourceId, item]) ?? [],
  );
  const byOpportunity = new Map(
    matches.map((item) => [item.opportunityId, item]),
  );
  const counts = state?.counts;
  const search = state?.discovery;
  const stages = stageProgress(state, status === 'running');
  return (
    <div className="jobs-discovery-run">
      <Card
        variant="subtle"
        className={`jobs-run-detail${collapsed ? ' is-collapsed' : ''}`}
        data-testid="jobs-run-detail"
      >
        <MeadowCardCorner variant="floral" />
        <div className="jobs-card-title">
          <h3>
            <BriefcaseBusiness size={24} aria-hidden="true" />
            {savedTitle ?? run?.configSnapshot.name ?? 'Discovery run'}
          </h3>
          <span className="jobs-badge" role="status">
            {cancelling ? 'Cancellation pending' : (status ?? 'Loading')}
          </span>
          <button
            type="button"
            className="jobs-collapse"
            aria-expanded={!collapsed}
            aria-controls={`jobs-run-body-${id}`}
            aria-label={collapsed ? 'Expand run' : 'Collapse run'}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDown size={20} aria-hidden="true" />
          </button>
        </div>
        {loading && <p role="status">Loading run…</p>}
        {startWarning && status === 'running' && !state?.workActive && (
          <p role="alert" className="jobs-error">
            {startWarning}
          </p>
        )}
        {error && (
          <p role="alert" className="jobs-error">
            Refresh failed: {error} Saved results remain visible.
          </p>
        )}
        {cancelError && (
          <p role="alert" className="jobs-error">
            Cancellation not confirmed: {cancelError}
          </p>
        )}
        {status === 'interrupted' && (
          <p>
            This run was interrupted and cannot resume. Start a new run from
            Saved Searches.
          </p>
        )}
        <div
          id={`jobs-run-body-${id}`}
          className="jobs-run-body"
          hidden={collapsed}
        >
          <div className="jobs-run-overview">
            <ol className="jobs-stepper" aria-label="Discovery progress">
              {stages.map((stage) => (
                <li
                  key={stage.label}
                  className={`jobs-step jobs-step-${stage.state}`}
                  aria-label={`${stage.label}: ${stageText[stage.state]}`}
                  aria-current={stage.state === 'current' ? 'step' : undefined}
                >
                  <span className="jobs-step-dot" aria-hidden="true">
                    {stage.state === 'done' && (
                      <Check size={14} strokeWidth={3} />
                    )}
                  </span>
                  <span aria-hidden="true">{stage.label}</span>
                </li>
              ))}
            </ol>
            <div className="jobs-run-summary">
              <p className="jobs-run-state">
                <span
                  className={`jobs-status-dot jobs-status-${status ?? 'loading'}`}
                  aria-hidden="true"
                />
                {status === 'running'
                  ? 'Searching for more roles…'
                  : status
                    ? `Discovery ${status}`
                    : 'Loading discovery…'}
              </p>
              {status === 'running' && (
                <p className="jobs-meta">
                  Only search attempts use the rate-limited queue; page reads
                  and local extraction continue independently, so discovered
                  roles keep resolving, extracting and matching in the
                  background.
                </p>
              )}
              <div className="jobs-actions">
                <Button variant="secondary" onClick={() => void refresh()}>
                  Refresh results
                </Button>
                {status === 'running' &&
                  !cancelling &&
                  (cancelConfirm ? (
                    <>
                      <span>Stop this run? Saved results stay available.</span>
                      <Button onClick={() => void cancel()}>
                        Confirm cancel
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setCancelConfirm(false)}
                      >
                        Keep running
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="secondary"
                      className="jobs-cancel"
                      leadingIcon={<X size={17} />}
                      onClick={() => setCancelConfirm(true)}
                    >
                      Cancel run
                    </Button>
                  ))}
              </div>
            </div>
          </div>
          <Disclosure label="Run details" className="jobs-run-more">
            <p className="jobs-run-id">Run ID: {id}</p>
            {run && (
              <div className="jobs-run-facts">
                <p>Frozen query plan ({run.queryPlan.length}):</p>
                <ol>
                  {run.queryPlan.map((query, index) => (
                    <li key={index}>{query}</li>
                  ))}
                </ol>
                <div className="jobs-activity" aria-label="Run activity">
                  <span>
                    {search?.submitted === null ||
                    search?.submitted === undefined
                      ? state
                        ? 'Submitted searches: unknown after restart'
                        : 'Submitted searches: unavailable'
                      : `${search.submitted} searches submitted`}
                  </span>
                  <span>
                    {search?.settled === null || search?.settled === undefined
                      ? state
                        ? 'Settled searches: unknown after restart'
                        : 'Settled searches: unavailable'
                      : `${search.settled} searches settled`}
                  </span>
                  {counts && (
                    <>
                      <span>{counts.admitted} admitted</span>
                      <span>{counts.verified} verified</span>
                      <span>{counts.jdReady} JD-ready</span>
                      <span>{counts.matched} matched (including unscored)</span>
                      <span>{counts.failed} failed candidates</span>
                    </>
                  )}
                </div>
              </div>
            )}
            {state && (
              <div className="jobs-run-queue">
                <p>
                  Search queue:{' '}
                  {state.discovery.search.operationActive ||
                  state.discovery.search.state !== 'idle'
                    ? `${state.discovery.search.state}${state.discovery.search.position ? ` · position ${state.discovery.search.position}` : ''} · ${state.discovery.search.queueLength} waiting${state.discovery.search.nextEligibleAt ? ` · next eligible ${new Date(state.discovery.search.nextEligibleAt).toLocaleTimeString()}` : ''}`
                    : status === 'running'
                      ? 'No live search information available'
                      : 'Not active'}
                </p>
                {state.activeSteps.length > 0 && (
                  <p>
                    {state.activeSteps.length} candidate operation(s) active
                  </p>
                )}
                {state.diagnostics.length > 0 && (
                  <ul>
                    {state.diagnostics.map((item, index) => (
                      <li key={`${item.at}-${index}`}>
                        {reasonText(item.code)}{' '}
                        <span className="jobs-meta">({item.code})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Disclosure>
        </div>
      </Card>
      <Card className="jobs-roles">
        <h3 className="jobs-history-title">
          Discovered roles ({candidates.length})
        </h3>
        <p className="jobs-meta">
          Roles are processed incrementally as they’re discovered.
        </p>
        {candidates.length === 0 && !loading && !error && (
          <p>
            {status === 'running'
              ? 'No candidates admitted yet.'
              : 'No candidates were admitted in this run.'}
          </p>
        )}
        <div className="jobs-candidates">
          {candidates.map((candidate) => (
            <CandidateCard
              key={candidate.sourceId}
              runId={id}
              candidate={candidate}
              progress={bySource.get(candidate.sourceId)}
              match={byOpportunity.get(candidate.id)}
              runActive={status === 'running' || cancelling}
              onRefresh={refresh}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
