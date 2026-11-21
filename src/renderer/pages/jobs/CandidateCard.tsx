import React, { useEffect, useRef, useState } from 'react';
import {
  BriefcaseBusiness,
  CircleCheck,
  CircleDashed,
  FileText,
  MapPin,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import { Disclosure } from '../../presentation/components/Disclosure';
import type { Destination } from '../../app/destinations';
import type {
  DiscoveryCandidate,
  DiscoveryMatch,
  DiscoveryWorkflowState,
  JdExtraction,
  ResolutionDiagnostics,
} from '../../../shared/contracts/job-discovery';
import {
  ApiError,
  getResolutionDiagnostics,
  listCandidateExtractions,
  retryCandidateExtraction,
  retryCandidateResolution,
} from '../../api';
import { reasonText, resolutionCopy } from './discoveryCopy';

type Progress = DiscoveryWorkflowState['candidates'][number];
const message = (error: unknown) =>
  error instanceof ApiError
    ? `${error.code}: ${error.message}`
    : 'Action failed. Please try again.';
const providerName = (provider: string) =>
  provider === 'linkedin'
    ? 'LinkedIn'
    : provider === 'indeed'
      ? 'Indeed'
      : provider;
const dispositionText: Record<string, string> = {
  seen: 'Returned; not yet opened',
  reading: 'Page read in progress',
  not_opened: 'Not opened',
  read_failed: 'Page read failed',
  rejected: 'Read and checked; rejected',
  accepted: 'Read and checked; accepted',
  interrupted: 'Interrupted before a final decision',
};

const dispositionTone: Record<string, string> = {
  accepted: 'jobs-tone-ready',
  rejected: 'jobs-tone-attention',
  read_failed: 'jobs-tone-attention',
  reading: 'jobs-tone-busy',
};

const stepTone: Record<string, string> = {
  succeeded: 'jobs-tone-ready',
  active: 'jobs-tone-busy',
  failed: 'jobs-tone-attention',
};

function StepPill({ status, label }: { status?: string; label?: string }) {
  return (
    <span
      className={`jobs-detail-pill ${(status && stepTone[status]) ?? 'jobs-tone-neutral'}`}
    >
      {label ?? (status ? statusText[status] : 'unknown')}
    </span>
  );
}

type Chip = {
  label: string;
  tone: 'ready' | 'busy' | 'attention' | 'neutral';
  icon: typeof FileText;
};

const statusText: Record<string, string> = {
  pending: 'queued',
  active: 'in progress',
  succeeded: 'complete',
  failed: 'failed',
  skipped: 'skipped',
};

export function CandidateCard({
  runId,
  candidate,
  progress,
  match,
  runActive,
  onRefresh,
  onNavigate,
}: {
  runId: string;
  candidate: DiscoveryCandidate;
  progress?: Progress;
  match?: DiscoveryMatch;
  runActive: boolean;
  onRefresh: () => Promise<void>;
  onNavigate?: (next: Destination) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [history, setHistory] = useState<ResolutionDiagnostics | null>(null);
  const [extractions, setExtractions] = useState<JdExtraction[]>([]);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const action = useRef(false);
  const mounted = useRef(true);
  const readSequence = useRef(0);
  const evidence = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readSequence.current++;
    };
  }, []);

  async function readDetails() {
    const sequence = ++readSequence.current;
    setCopyStatus(null);
    const results = await Promise.allSettled([
      getResolutionDiagnostics(runId, candidate.sourceId),
      listCandidateExtractions(runId, candidate.sourceId),
    ] as const);
    if (!mounted.current || sequence !== readSequence.current) return;
    if (results[0].status === 'fulfilled') setHistory(results[0].value);
    if (results[1].status === 'fulfilled') setExtractions(results[1].value);
    const failed = results.find((result) => result.status === 'rejected');
    setDetailsError(failed ? message(failed.reason) : null);
  }

  async function retry(kind: 'resolution' | 'extraction') {
    if (action.current || runActive) return;
    action.current = true;
    setPending(true);
    setActionError(null);
    try {
      if (kind === 'resolution')
        await retryCandidateResolution(runId, candidate.sourceId);
      else await retryCandidateExtraction(runId, candidate.sourceId);
      if (mounted.current) {
        await onRefresh();
        if (detailsOpen) await readDetails();
        queueMicrotask(() =>
          evidence.current?.querySelector('summary')?.focus(),
        );
      }
    } catch (error) {
      if (mounted.current) {
        setActionError(message(error));
        await onRefresh();
        if (detailsOpen) await readDetails();
      }
    } finally {
      action.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function copy() {
    if (!history) return;
    try {
      await navigator.clipboard.writeText(resolutionCopy(history));
      if (mounted.current) setCopyStatus('Diagnostics copied.');
    } catch {
      if (mounted.current)
        setCopyStatus('Copy unavailable. Select the evidence text below.');
    }
  }

  const verified =
    progress?.resolution.status === 'succeeded' && !!candidate.canonicalUrl;
  const ready = progress?.extraction.status === 'succeeded';
  // Workflow attests currentness; an older successful extraction is not the current JD.
  const coverage =
    ready &&
    progress?.match.status === 'succeeded' &&
    match?.status === 'scored'
      ? match.coverage
      : null;
  const currentExtraction =
    progress?.match.status === 'succeeded'
      ? extractions.find(
          (entry) =>
            entry.id === match?.extractionId && entry.status === 'extracted',
        )
      : null;
  const modelProblem =
    progress?.extraction.reason === 'MODEL_UNAVAILABLE' ||
    progress?.extraction.reason === 'MODEL_FAILED';
  const failure =
    progress?.resolution.status === 'failed'
      ? progress.resolution.reason
      : progress?.extraction.status === 'failed'
        ? progress.extraction.reason
        : null;
  const chips: Chip[] = [];
  if (failure !== null && failure !== undefined) {
    chips.push({
      label: 'Needs attention',
      tone: 'attention',
      icon: TriangleAlert,
    });
  } else if (!progress) {
    chips.push({ label: 'Discovered', tone: 'neutral', icon: CircleDashed });
  } else if (progress.resolution.status !== 'succeeded') {
    chips.push({
      label: `Resolving · ${statusText[progress.resolution.status]}`,
      tone: 'busy',
      icon: RefreshCw,
    });
  } else if (!ready) {
    chips.push({
      label: `Extracting · ${statusText[progress.extraction.status]}`,
      tone: 'busy',
      icon: RefreshCw,
    });
  } else {
    chips.push({ label: 'JD ready', tone: 'ready', icon: FileText });
    if (progress.match.status === 'succeeded')
      chips.push({
        label:
          coverage !== null
            ? `Matched · ${Math.round(coverage * 100)}%`
            : 'Matched (unscored)',
        tone: coverage !== null ? 'ready' : 'neutral',
        icon: coverage !== null ? CircleCheck : CircleDashed,
      });
  }
  return (
    <Card
      padding="compact"
      className="jobs-candidate"
      data-testid={`jobs-candidate-${candidate.sourceId}`}
    >
      <div className="jobs-candidate-row">
        <BriefcaseBusiness
          size={20}
          aria-hidden="true"
          className="jobs-candidate-icon"
        />
        <h4>
          {candidate.title}
          {candidate.company && (
            <span className="jobs-candidate-company">
              {' '}
              · {candidate.company}
            </span>
          )}
        </h4>
        <span className="jobs-candidate-location">
          {candidate.location && (
            <>
              <MapPin size={15} aria-hidden="true" />
              {candidate.location}
            </>
          )}
        </span>
        <span className="jobs-candidate-chips">
          {chips.map(({ label, tone, icon: Icon }) => (
            <span key={label} className={`jobs-status-chip jobs-tone-${tone}`}>
              <Icon size={14} aria-hidden="true" />
              {label}
            </span>
          ))}
          {failure && (
            <span className="jobs-candidate-reason">{reasonText(failure)}</span>
          )}
        </span>
        <div className="jobs-candidate-actions">
          {progress?.resolution.retryAvailable && (
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw size={15} />}
              disabled={pending || runActive}
              onClick={() => void retry('resolution')}
            >
              Retry resolution
            </Button>
          )}
          {progress?.extraction.retryAvailable && (
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw size={15} />}
              disabled={pending || runActive}
              onClick={() => void retry('extraction')}
            >
              Retry extraction
            </Button>
          )}
        </div>
        <div ref={evidence} className="jobs-candidate-more">
          <Disclosure
            label="Details"
            className="jobs-evidence"
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setDetailsOpen(open);
              if (open) void readDetails();
            }}
          >
            <div className="jobs-detail">
              <section className="jobs-detail-section">
                <h5>Progress</h5>
                <ul
                  className="jobs-detail-steps"
                  aria-label="Candidate progress"
                >
                  <li data-step="listing">
                    <span className="jobs-detail-label">Listing</span>
                    <span className="jobs-detail-pill jobs-tone-ready">
                      Discovered
                    </span>
                  </li>
                  <li data-step="canonical">
                    <span className="jobs-detail-label">Canonical page</span>
                    <StepPill status={progress?.resolution.status} />
                    {progress?.resolution.reason &&
                      progress.resolution.status !== 'succeeded' && (
                        <span className="jobs-detail-reason">
                          {reasonText(progress.resolution.reason)}{' '}
                          <code>{progress.resolution.reason}</code>
                        </span>
                      )}
                  </li>
                  <li data-step="jd">
                    <span className="jobs-detail-label">Job description</span>
                    <StepPill
                      status={progress?.extraction.status}
                      label={ready ? 'Ready' : undefined}
                    />
                    {progress?.extraction.reason &&
                      progress.extraction.status !== 'pending' &&
                      progress.extraction.status !== 'succeeded' && (
                        <span className="jobs-detail-reason">
                          {reasonText(progress.extraction.reason)}
                        </span>
                      )}
                  </li>
                  <li data-step="skills">
                    <span className="jobs-detail-label">Skill match</span>
                    {coverage !== null ? (
                      <span className="jobs-detail-pill jobs-tone-ready">
                        {Math.round(coverage * 100)}% required-skill coverage
                      </span>
                    ) : ready &&
                      match?.status === 'unscored' &&
                      progress?.match.status === 'succeeded' ? (
                      <>
                        <span className="jobs-detail-pill jobs-tone-neutral">
                          Unscored
                        </span>
                        <span className="jobs-detail-reason">
                          {reasonText(match.reason)}
                        </span>
                      </>
                    ) : (
                      <StepPill status={progress?.match.status} />
                    )}
                  </li>
                </ul>
                {ready && progress.extraction.omittedFields.length > 0 && (
                  <p className="jobs-detail-note">
                    Omitted fields:{' '}
                    {progress.extraction.omittedFields.join(', ')}
                  </p>
                )}
                {progress?.match.freshness && (
                  <p className="jobs-detail-note">
                    Skill freshness:{' '}
                    {progress.match.freshness === 'unknown_skills'
                      ? 'unknown until refreshed'
                      : 'match refers to an older extraction'}
                  </p>
                )}
              </section>

              {currentExtraction?.jd && ready && (
                <section className="jobs-detail-section">
                  <h5>Job description</h5>
                  <p className="jobs-detail-title">
                    {currentExtraction.jd.title?.text ?? candidate.title}
                  </p>
                  {currentExtraction.jd.requiredSkills.length > 0 && (
                    <>
                      <span className="jobs-detail-label">Required skills</span>
                      <ul className="jobs-detail-skills">
                        {currentExtraction.jd.requiredSkills.map(
                          (field, index) => (
                            <li key={index}>{field.text}</li>
                          ),
                        )}
                      </ul>
                    </>
                  )}
                </section>
              )}

              <section className="jobs-detail-section">
                <h5>Source</h5>
                <dl className="jobs-detail-facts">
                  <div>
                    <dt>Provider</dt>
                    <dd>
                      {[
                        providerName(candidate.provider),
                        candidate.company,
                        candidate.location,
                        candidate.postingAge,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </dd>
                  </div>
                  <div>
                    <dt>Original listing</dt>
                    <dd className="jobs-url">{candidate.discoveredUrl}</dd>
                  </div>
                  <div>
                    <dt>Verified canonical</dt>
                    <dd className="jobs-url">
                      {verified ? candidate.canonicalUrl : 'Not verified'}
                    </dd>
                  </div>
                  <div>
                    <dt>Resolution attempts</dt>
                    <dd>
                      {progress?.resolution.attempts ??
                        candidate.resolutionAttempts}{' '}
                      · retry{' '}
                      {progress?.resolution.retryAvailable && !runActive
                        ? 'available'
                        : 'not available now'}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="jobs-detail-section">
                <div className="jobs-detail-header">
                  <h5>Resolution history</h5>
                  {history && (
                    <div className="jobs-detail-tools">
                      {copyStatus && <span role="status">{copyStatus}</span>}
                      <Button
                        variant="ghost"
                        onClick={() => void readDetails()}
                      >
                        Refresh details
                      </Button>
                      <Button variant="secondary" onClick={() => void copy()}>
                        Copy diagnostics
                      </Button>
                    </div>
                  )}
                </div>
                {detailsError && (
                  <p role="alert" className="jobs-error">
                    Details unavailable: {detailsError}{' '}
                    <Button
                      variant="secondary"
                      onClick={() => void readDetails()}
                    >
                      Retry details
                    </Button>
                  </p>
                )}
                {!history && !detailsError && (
                  <p className="jobs-detail-note">
                    Loading resolution history…
                  </p>
                )}
                {history && history.totalAttempts > history.attempts.length && (
                  <p className="jobs-detail-note">
                    Detailed history not recorded for{' '}
                    {history.totalAttempts - history.attempts.length} earlier
                    attempt(s).
                  </p>
                )}
                {history &&
                  history.attempts.length === 0 &&
                  history.totalAttempts === 0 && (
                    <p className="jobs-detail-note">
                      No resolution attempts recorded yet.
                    </p>
                  )}
                {history?.attempts.map((attempt) => (
                  <article className="jobs-attempt" key={attempt.id}>
                    <header className="jobs-attempt-header">
                      <h6>Attempt {attempt.sequence}</h6>
                      <span className="jobs-detail-pill jobs-tone-neutral">
                        {attempt.status}
                      </span>
                      <span className="jobs-detail-reason">
                        {attempt.reason ? (
                          <>
                            {reasonText(attempt.reason)}{' '}
                            <code>{attempt.reason}</code>
                          </>
                        ) : (
                          'Final reason not recorded yet'
                        )}
                      </span>
                    </header>
                    <p className="jobs-detail-note jobs-url">
                      {providerName(attempt.provider)} · {attempt.discoveredUrl}
                    </p>
                    {attempt.searches.length === 0 && (
                      <p className="jobs-detail-note">
                        No targeted queries recorded for this attempt.
                      </p>
                    )}
                    {attempt.searches.map((search) => (
                      <div
                        key={search.ordinal}
                        className="jobs-search-evidence"
                      >
                        <div className="jobs-search-header">
                          <span className="jobs-detail-label">
                            Query {search.ordinal}
                          </span>
                          <span
                            className={`jobs-detail-pill ${search.status === 'failed' ? 'jobs-tone-attention' : 'jobs-tone-neutral'}`}
                          >
                            {search.status}
                          </span>
                          {search.errorCode && <code>{search.errorCode}</code>}
                        </div>
                        <p
                          className="jobs-query jobs-evidence-value"
                          title={search.query}
                        >
                          {search.query}
                        </p>
                        {search.results.length === 0 ? (
                          <p className="jobs-detail-note">
                            No returned URLs recorded.
                          </p>
                        ) : (
                          <ol className="jobs-results">
                            {search.results.map((result) => (
                              <li key={result.ordinal}>
                                <span
                                  className={`jobs-detail-pill ${dispositionTone[result.disposition] ?? 'jobs-tone-neutral'}`}
                                >
                                  {dispositionText[result.disposition]}
                                </span>
                                <span
                                  className="jobs-evidence-value jobs-result-url"
                                  title={result.url}
                                >
                                  {result.url}
                                </span>
                                {result.reason && (
                                  <code className="jobs-result-reason">
                                    {result.reason}
                                  </code>
                                )}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    ))}
                  </article>
                ))}
              </section>
            </div>
          </Disclosure>
        </div>
      </div>
      {(pending ||
        (!runActive &&
          progress?.resolution.status === 'failed' &&
          !progress.resolution.retryAvailable)) && (
        <p className="jobs-meta jobs-candidate-note">
          {pending ? (
            <span role="status">Retry in progress…</span>
          ) : (
            'Resolution attempts exhausted or unavailable.'
          )}
        </p>
      )}
      {modelProblem && onNavigate && (
        <Button variant="secondary" onClick={() => onNavigate('settings')}>
          Open Local AI settings
        </Button>
      )}
      {actionError && (
        <p role="alert" className="jobs-error">
          {actionError}
        </p>
      )}
    </Card>
  );
}
