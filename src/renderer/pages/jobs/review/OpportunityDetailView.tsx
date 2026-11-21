import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Bookmark,
  Building,
  Building2,
  CalendarDays,
  MapPin,
  CheckCircle2,
  ExternalLink as ExternalLinkIcon,
  Flag,
  Info,
  Link2,
  RotateCcw,
  Sprout,
  FileText,
  TriangleAlert,
  X,
} from 'lucide-react';
import type {
  OpportunityDetail,
  OpportunitySummary,
} from '../../../../shared/contracts/job-discovery';
import {
  ApiError,
  decideReviewOpportunity,
  getReviewOpportunity,
} from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { MeadowCardCorner } from '../../../presentation/meadow/decorations/MeadowCardCorner';
import { ApplyOpportunity } from './ApplyOpportunity';

function message(error: unknown): string {
  if (error instanceof ApiError && error.code === 'NOT_FOUND')
    return 'This opportunity is no longer available. Return to Review.';
  if (error instanceof ApiError && error.code === 'CONFLICT')
    return 'This decision is no longer available. Refresh the detail.';
  return 'Could not read local opportunity data. Try again.';
}

function ExternalLink({ url, label }: { url: string; label: string }) {
  let hostname: string | null = null;
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname)
      hostname = parsed.hostname.replace(/^www\./, '');
  } catch {
    /* The original reference is still useful as plain text. */
  }
  return hostname ? (
    <a
      className="jobs-review-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      aria-label={`${label}: ${url}`}
    >
      <ExternalLinkIcon size={13} aria-hidden="true" />
      {hostname}
    </a>
  ) : (
    <span>
      {label}: {url} (link unavailable)
    </span>
  );
}

const reasonText: Record<string, string> = {
  NO_REQUIRED_SKILLS: 'No supported required skills were extracted.',
  NO_CONFIRMED_SKILLS: 'No user-confirmed skills are recorded.',
  PROFILE_UNAVAILABLE: 'Confirmed profile skills were unavailable.',
  NO_EXTRACTION: 'No current verified job description was extracted.',
};

function JobDescription({ item }: { item: OpportunityDetail }) {
  const extraction = item.extraction;
  const jd =
    extraction?.status === 'extracted' &&
    extraction.captureId === item.verifiedCaptureId
      ? extraction.jd
      : null;
  const sections = jd
    ? ([
        ['Responsibilities', jd.responsibilities],
        ['Required skills', jd.requiredSkills],
        ['Preferred skills', jd.preferredSkills],
        ['Education requirements', jd.educationRequirements],
      ] as const)
    : [];
  return (
    <Card
      padding="compact"
      variant="subtle"
      className="jobs-review-panel jobs-review-jd"
    >
      <h3 className="jobs-review-panel-title">
        <FileText size={22} aria-hidden="true" />
        Job description
      </h3>
      {!item.verifiedCaptureId && (
        <p>
          No verified posting capture is available. The original listing may
          still be reviewed.
        </p>
      )}
      {item.verifiedCaptureId && !jd && (
        <p>
          {item.extractionStatus === 'failed'
            ? 'Extraction failed for this verified posting.'
            : item.extractionStatus === 'running'
              ? 'Extraction is in progress.'
              : 'No current successful extraction is available for this verified posting.'}
        </p>
      )}
      {jd && (
        <>
          {jd.title && <p>Extracted role: {jd.title.text}</p>}
          {jd.company && <p>Extracted employer: {jd.company.text}</p>}
          {jd.location && <p>Extracted location: {jd.location.text}</p>}
          <div className="jobs-review-jd-sections">
            {sections.map(
              ([heading, fields]) =>
                fields.length > 0 && (
                  <section key={heading}>
                    <h4>{heading}</h4>
                    <ul>
                      {fields.map((field, index) => (
                        <li key={index}>{field.text}</li>
                      ))}
                    </ul>
                  </section>
                ),
            )}
          </div>
          {jd.minimumYearsExperience && (
            <p>
              Stated minimum experience: {jd.minimumYearsExperience.value} years
            </p>
          )}
          {jd.employmentType && (
            <p>Stated employment type: {jd.employmentType.text}</p>
          )}
          {jd.workArrangement && (
            <p>Stated work arrangement: {jd.workArrangement.text}</p>
          )}
          {jd.salaryText && <p>Stated compensation: {jd.salaryText.text}</p>}
          {!sections.some(([, fields]) => fields.length) && (
            <p>
              No supported responsibility or requirement fields were found in
              the extraction.
            </p>
          )}
          {extraction?.diagnostics.length ? (
            <p>Omitted evidence fields: {extraction.diagnostics.join(', ')}</p>
          ) : null}
        </>
      )}
      {item.postingText && (
        <details>
          <summary>
            Verified posting text{item.postingTextTruncated ? ' (excerpt)' : ''}
          </summary>
          <p className="jobs-review-posting">{item.postingText}</p>
        </details>
      )}
    </Card>
  );
}

function Assessment({ item }: { item: OpportunityDetail }) {
  const match = item.match;
  const current =
    !!match &&
    !!item.extraction &&
    item.extraction.status === 'extracted' &&
    item.extraction.captureId === item.verifiedCaptureId &&
    match.extractionId === item.extraction.id &&
    (item.matchStatus === 'scored' || item.matchStatus === 'unscored');
  return (
    <Card
      padding="compact"
      variant="subtle"
      className="jobs-review-panel jobs-review-assessment"
    >
      <h3 className="jobs-review-panel-title">
        <BarChart3 size={22} aria-hidden="true" />
        Required-skills assessment
      </h3>
      {!match && <p>No saved assessment is available.</p>}
      {match && !current && (
        <p>
          Saved assessment is out of date with the current verified extraction.
          No current coverage is available.
        </p>
      )}
      {match && current && (
        <>
          {match.status === 'scored' && match.coverage !== null ? (
            <p className="jobs-review-coverage-text">
              <span
                className="jobs-review-ring"
                style={
                  {
                    '--coverage': `${Math.round(match.coverage * 100)}%`,
                  } as React.CSSProperties
                }
                aria-hidden="true"
              >
                <span>{Math.round(match.coverage * 100)}%</span>
              </span>
              Required skills covered: {Math.round(match.coverage * 100)}% (
              {match.matched.length} of {match.requiredCount}). This is not an
              overall fit recommendation.
            </p>
          ) : (
            <p>
              Unscored:{' '}
              {reasonText[match.reason] ?? 'No coverage score is available.'}
            </p>
          )}
          <div className="jobs-review-skill-groups">
            {match.matched.length > 0 && (
              <section className="jobs-review-skill-group jobs-review-skill-matched">
                <h4>
                  <CheckCircle2 size={17} aria-hidden="true" />
                  Matched confirmed skills
                </h4>
                <ul>
                  {match.matched.map((skill, index) => (
                    <li key={index}>{skill}</li>
                  ))}
                </ul>
              </section>
            )}
            {match.unmatched.length > 0 && (
              <section className="jobs-review-skill-group jobs-review-skill-missing">
                <h4>
                  <TriangleAlert size={17} aria-hidden="true" />
                  Required skills not recorded as confirmed
                </h4>
                <ul>
                  {match.unmatched.map((skill, index) => (
                    <li key={index}>{skill}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <p className="jobs-review-footnote">
            Confirmed-skill freshness is unknown; this saved assessment was
            computed {new Date(match.computedAt).toLocaleDateString()}.
          </p>
        </>
      )}
    </Card>
  );
}

export function OpportunityDetailView({
  summary,
  backButton,
  onBack,
  onDecision,
  onOpenApplication,
}: {
  summary: OpportunitySummary;
  backButton: React.RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  onDecision: (item: OpportunitySummary) => void;
  onOpenApplication: (id: string) => void;
}) {
  const [detail, setDetail] = useState<OpportunityDetail | null>(null);
  const [error, setError] = useState('');
  const [decisionError, setDecisionError] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const busy = useRef(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setError('');
    try {
      const result = await getReviewOpportunity(summary.opportunityId);
      if (alive.current && request === sequence.current) setDetail(result);
    } catch (failure) {
      if (alive.current && request === sequence.current)
        setError(message(failure));
    }
  }, [summary.opportunityId]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, [load]);

  async function decide(decision: 'new' | 'saved' | 'dismissed') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setDecisionError('');
    try {
      const confirmed = await decideReviewOpportunity(
        summary.opportunityId,
        decision,
      );
      if (!alive.current) return;
      onDecision(confirmed);
      setDetail((current) =>
        current ? { ...current, ...confirmed } : current,
      );
      setNotice(
        `Decision ${decision === 'new' ? 'restored to New' : `set to ${decision}`}.`,
      );
    } catch (failure) {
      if (alive.current) setDecisionError(message(failure));
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }

  const item = detail;
  const decision = item?.decision ?? summary.decision;
  const tracked =
    !!(item?.applicationId ?? summary.applicationId) || decision === 'applied';
  return (
    <div className="jobs-review-detail" data-testid="review-detail">
      <div className="jobs-review-detail-bar">
        <button
          ref={backButton}
          type="button"
          className="ui-button ui-button-secondary"
          onClick={onBack}
        >
          <ArrowLeft size={17} /> Back to Review
        </button>
        <p className="jobs-review-detail-eyebrow">
          <Sprout size={22} aria-hidden="true" />
          Review opportunity
        </p>
      </div>
      <Card padding="compact" className="jobs-review-heading">
        <MeadowCardCorner variant="floral" />
        <span className="jobs-review-logo" aria-hidden="true">
          <Building2 size={30} strokeWidth={1.8} />
        </span>
        <div className="jobs-review-heading-text">
          <h2>{item?.title ?? summary.title}</h2>
          <p className="jobs-review-heading-company">
            {item?.company ?? summary.company ?? 'Employer not provided'}
            {(item?.location ?? summary.location)
              ? ` · ${item?.location ?? summary.location}`
              : ''}
          </p>
        </div>
        <p className="jobs-review-chip jobs-review-chip-decision">
          Review decision: {tracked ? 'Already in applications' : decision}
        </p>
      </Card>
      {!item && !error && <p role="status">Loading opportunity details…</p>}
      {error && (
        <p role="alert" className="jobs-error">
          {error}{' '}
          <Button variant="secondary" onClick={() => void load()}>
            Retry detail
          </Button>
        </p>
      )}
      {item && (
        <>
          <div className="jobs-review-detail-grid">
            <Card
              padding="compact"
              variant="subtle"
              className="jobs-review-panel jobs-review-overview"
            >
              <h3 className="jobs-review-panel-title">
                <Info size={22} aria-hidden="true" />
                Overview and sources
              </h3>
              <dl className="jobs-review-facts">
                <div>
                  <dt>
                    <MapPin size={17} aria-hidden="true" />
                    Location
                  </dt>
                  <dd>{item.location ?? 'Not provided'}</dd>
                </div>
                <div>
                  <dt>
                    <Building size={17} aria-hidden="true" />
                    Source
                  </dt>
                  <dd>{item.sources[0]?.provider ?? 'Not provided'}</dd>
                </div>
                {item.sources[0]?.postingAge && (
                  <div>
                    <dt>
                      <CalendarDays size={17} aria-hidden="true" />
                      Posted
                    </dt>
                    <dd>{item.sources[0].postingAge}</dd>
                  </div>
                )}
              </dl>
              {item.sources.length === 0 && (
                <p>No original source reference is available.</p>
              )}
              {item.sources[0] && (
                <p className="jobs-review-overview-row">
                  <Link2 size={17} aria-hidden="true" />
                  Original listing · {item.sources[0].provider}:{' '}
                  <ExternalLink
                    url={item.sources[0].discoveredUrl}
                    label="Open listing"
                  />
                  {item.sources[0].postingAge && (
                    <> · Reported age: {item.sources[0].postingAge}</>
                  )}
                </p>
              )}
              {item.sources.length > 1 && (
                <details>
                  <summary>Other sources ({item.sources.length - 1})</summary>
                  <ul>
                    {item.sources.slice(1).map((source) => (
                      <li key={source.id}>
                        {source.provider}:{' '}
                        <ExternalLink
                          url={source.discoveredUrl}
                          label="Open listing"
                        />
                        {source.postingAge && (
                          <> · Reported age: {source.postingAge}</>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {item.sourcesTruncated && (
                <p>
                  Additional source aliases are not included in this bounded
                  view.
                </p>
              )}
              {item.verifiedCaptureId && item.canonicalUrl ? (
                <p className="jobs-review-overview-row">
                  <Link2 size={17} aria-hidden="true" />
                  Verified company/ATS posting:{' '}
                  <ExternalLink
                    url={item.canonicalUrl}
                    label="Open canonical posting"
                  />
                </p>
              ) : (
                <p>
                  No verified canonical posting is available yet. This does not
                  invalidate the original listing.
                </p>
              )}
            </Card>
            <JobDescription item={item} />
          </div>
          <Assessment item={item} />
        </>
      )}
      <Card
        padding="compact"
        variant="subtle"
        className="jobs-review-panel jobs-review-decision"
      >
        <h3 className="jobs-review-panel-title">
          <Flag size={22} aria-hidden="true" />
          Decision
        </h3>
        {tracked ? (
          <p>
            Already in applications. Review decisions cannot be changed here.
          </p>
        ) : (
          <>
            <p>
              Keep this opportunity for later or dismiss it. This does not
              create an application.
            </p>
            <div className="jobs-review-decision-actions">
              {decision !== 'saved' && (
                <Button
                  variant="secondary"
                  disabled={pending || !item}
                  onClick={() => void decide('saved')}
                  leadingIcon={<Bookmark size={16} />}
                >
                  Save
                </Button>
              )}
              {decision !== 'dismissed' && (
                <Button
                  variant="secondary"
                  disabled={pending || !item}
                  onClick={() => void decide('dismissed')}
                  leadingIcon={<X size={16} />}
                >
                  Dismiss
                </Button>
              )}
              {decision === 'dismissed' && (
                <Button
                  variant="secondary"
                  disabled={pending || !item}
                  onClick={() => void decide('new')}
                  leadingIcon={<RotateCcw size={16} />}
                >
                  Restore
                </Button>
              )}
            </div>
          </>
        )}
        <p role="status">{pending ? 'Saving decision…' : notice}</p>
        {decisionError && (
          <p role="alert" className="jobs-error">
            {decisionError}
          </p>
        )}
        {(tracked || decision !== 'dismissed') && (
          <ApplyOpportunity
            opportunityId={summary.opportunityId}
            applicationId={item?.applicationId ?? summary.applicationId}
            dismissed={decision === 'dismissed'}
            onOpen={onOpenApplication}
          />
        )}
      </Card>
    </div>
  );
}
