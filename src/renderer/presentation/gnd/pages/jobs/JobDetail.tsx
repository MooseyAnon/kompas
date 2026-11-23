import React, { useEffect, useState } from 'react';
import { ArrowLeft, CircleCheck, CircleHelp, ExternalLink } from 'lucide-react';
import {
  applyReviewOpportunity,
  decideReviewOpportunity,
  getApplication,
  getReviewOpportunity,
  previewReviewApply,
  recordApplicationStage,
} from '../../../../api';
import type {
  OpportunityApplyPreview,
  OpportunityDetail,
  StageKind,
} from '../../../../../shared/contracts';
import { failureNotice } from '../../../../app/Notifications';
import { Button } from '../../../components/Button';
import type { Navigate } from '../../GndPage';
import { jobView } from './jobView';
import './JobDetail.css';

const unscoredReason: Record<string, string> = {
  NO_REQUIRED_SKILLS: 'This listing doesn’t name required skills to compare.',
  NO_CONFIRMED_SKILLS: 'Add skills to your profile to see how you match.',
  PROFILE_UNAVAILABLE: 'Your profile couldn’t be read. Try again shortly.',
  NO_EXTRACTION: 'The listing hasn’t been read yet.',
};

export function JobDetail({
  opportunityId,
  onBack,
  onNavigate,
}: {
  opportunityId: string;
  onBack: () => void;
  onNavigate: Navigate;
}) {
  const [detail, setDetail] = useState<OpportunityDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Notes from tracking the listing (link unverified, no copy saved).
  const [preview, setPreview] = useState<OpportunityApplyPreview | null>(null);
  // The stage of the tracked application; 'saved' means opened, not sent.
  const [stage, setStage] = useState<StageKind | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void getReviewOpportunity(opportunityId)
      .then(async (next) => {
        setDetail(next);
        if (next.applicationId) {
          const app = await getApplication(next.applicationId);
          setStage(app.application.currentStage.stageKind ?? 'other');
        }
      })
      .catch(() => setError('Couldn’t load this role.'));
  }, [opportunityId]);

  if (error && !detail)
    return (
      <section className="gnd-job-detail">
        <BackLink onBack={onBack} />
        <p className="gnd-state" role="alert">
          {error}
        </p>
      </section>
    );
  if (!detail)
    return (
      <section className="gnd-job-detail">
        <BackLink onBack={onBack} />
        <p className="gnd-state" role="status">
          Loading role…
        </p>
      </section>
    );

  const job = jobView(detail, detail);
  const jd = detail.extraction?.jd ?? null;
  const scored = detail.match?.status === 'scored';
  const reflected = job.matched.length;
  const total = job.requiredCount;
  const about = (jd?.responsibilities ?? [])
    .slice(0, 3)
    .map((item) => item.text)
    .join(' ');
  const tiles: Array<[string, string | null | undefined]> = [
    ['Location', jd?.location?.text ?? detail.location],
    ['Work setup', jd?.workArrangement?.text],
    ['Salary', jd?.salaryText?.text ?? 'Not published'],
    ['Employment type', jd?.employmentType?.text],
  ];

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(
        failureNotice(e, 'Something went wrong. Please try again.').message,
      );
    } finally {
      setBusy(false);
    }
  }

  const toggleSaved = () =>
    run(async () => {
      const next = detail.decision === 'saved' ? 'new' : 'saved';
      const updated = await decideReviewOpportunity(opportunityId, next);
      setDetail({ ...detail, decision: updated.decision });
    });

  // Opening the listing doesn't count as applying: it keeps the role in
  // Opportunities for you until the user says they sent their application.
  const startApply = () =>
    run(async () => {
      if (job.listingUrl) window.open(job.listingUrl, '_blank', 'noopener');
      if (!detail.applicationId) {
        const result = await previewReviewApply(opportunityId);
        const applicationId =
          result.applicationId ??
          (await applyReviewOpportunity(opportunityId, {
            confirmUnverified: result.unverified,
            withoutSnapshot: result.snapshot !== 'available',
            allowDuplicate: !!result.manualMatchId,
          }));
        setPreview(result);
        setDetail({ ...detail, applicationId });
        setStage('saved');
      }
      setAsking(true);
    });

  const markApplied = () =>
    run(async () => {
      if (!detail.applicationId) return;
      await recordApplicationStage({
        applicationId: detail.applicationId,
        stageLabel: 'Applied',
        stageKind: 'applied',
      });
      onNavigate('applications');
    });

  const opening = !!detail.applicationId && stage === 'saved';

  return (
    <section className="gnd-job-detail" aria-labelledby="job-title">
      <BackLink onBack={onBack} />
      <header className="gnd-job-detail-head">
        <p className="gnd-job-detail-company">{job.company}</p>
        <h1 id="job-title" className="gnd-page-title">
          {job.title}
        </h1>
        {job.listingUrl && (
          <a
            className="gnd-job-detail-listing"
            href={job.listingUrl}
            target="_blank"
            rel="noreferrer"
          >
            View job listing <ExternalLink aria-hidden="true" />
          </a>
        )}
      </header>

      <div className="gnd-job-detail-top">
        <dl className="gnd-job-tiles">
          {tiles.map(([label, value]) => (
            <div key={label} className="gnd-job-tile">
              <dt>{label}</dt>
              <dd>{value?.trim() || 'Not stated'}</dd>
            </div>
          ))}
        </dl>

        <div className="gnd-match-card" aria-live="polite">
          {scored ? (
            <>
              <p className="gnd-match-figure">
                <strong>{job.matchPercent}%</strong>
                <span>
                  {reflected} of {total} requirement{total === 1 ? '' : 's'}{' '}
                  reflected
                </span>
              </p>
              <div className="gnd-match-bar" aria-hidden="true">
                {Array.from({ length: Math.min(total, 12) }, (_, i) => (
                  <span
                    key={i}
                    className={
                      i < Math.round((reflected / total) * Math.min(total, 12))
                        ? 'is-on'
                        : ''
                    }
                  />
                ))}
              </div>
              <p className="gnd-match-caption">
                Required skills from the listing that your confirmed skills
                cover. Degrees and experience aren’t scored yet.
              </p>
            </>
          ) : (
            <>
              <p className="gnd-match-figure">
                <strong className="is-empty">–</strong>
                <span>Not scored yet</span>
              </p>
              <p className="gnd-match-caption">
                {unscoredReason[detail.match?.reason ?? 'NO_EXTRACTION']}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="gnd-job-detail-body">
        <div className="gnd-job-panel">
          {jd ? (
            <ul className="gnd-requirements">
              {job.matched.map((skill) => (
                <li key={`m-${skill}`}>
                  <CircleCheck className="is-on" aria-hidden="true" />
                  <span>
                    <strong>{skill} · reflected</strong>
                    <small>In your confirmed skills.</small>
                  </span>
                </li>
              ))}
              {job.missing.map((skill) => (
                <li key={`u-${skill}`}>
                  <CircleHelp className="is-gap" aria-hidden="true" />
                  <span>
                    <strong>{skill} · not yet shown</strong>
                    <small>Required in the employer’s listing.</small>
                  </span>
                </li>
              ))}
              {!job.matched.length && !job.missing.length && (
                <li className="gnd-muted">
                  This listing doesn’t name required skills.
                </li>
              )}
            </ul>
          ) : (
            <p className="gnd-muted">
              Requirements appear here once local AI has read the listing.
            </p>
          )}
        </div>

        <div className="gnd-job-panel">
          {about && <p className="gnd-job-about">{about}</p>}
          <p className="gnd-job-reassure">
            Not in your profile doesn’t mean you haven’t done it. Add the skills
            you have, and the match updates.
          </p>
          <button
            type="button"
            className="gnd-link"
            onClick={() => onNavigate('profile', { profileTab: 'skills' })}
          >
            Add skills to your profile
          </button>
        </div>
      </div>

      {asking && (
        <div
          className="gnd-apply-confirm"
          role="group"
          aria-label="Did you send your application?"
        >
          <h2 className="gnd-section-title">Did you send your application?</h2>
          <p>
            We’ve opened the listing. Once you’ve sent your CV on their site,
            mark it here. Until then it stays in Opportunities for you.
          </p>
          {preview?.unverified && (
            <p className="gnd-muted">The listing link couldn’t be verified.</p>
          )}
          {preview && preview.snapshot !== 'available' && (
            <p className="gnd-muted">
              A copy of the listing couldn’t be saved.
            </p>
          )}
          <div className="gnd-actions-row">
            <Button
              size="hero"
              disabled={busy}
              onClick={() => void markApplied()}
            >
              Yes, I applied
            </Button>
            <button
              type="button"
              className="gnd-text-link"
              onClick={() => setAsking(false)}
            >
              Not yet
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="gnd-message" role="alert">
          {error}
        </p>
      )}

      {!asking && (
        <div className="gnd-job-actions">
          {opening ? (
            <>
              <Button
                size="hero"
                variant="outline"
                disabled={busy}
                onClick={() => void startApply()}
              >
                Open listing again
              </Button>
              <Button
                size="hero"
                disabled={busy}
                onClick={() => void markApplied()}
              >
                I’ve applied
              </Button>
            </>
          ) : detail.applicationId ? (
            <Button size="hero" onClick={() => onNavigate('applications')}>
              Open application
            </Button>
          ) : (
            <>
              <Button
                size="hero"
                variant="outline"
                disabled={busy}
                onClick={() => void toggleSaved()}
              >
                {detail.decision === 'saved'
                  ? 'Saved · undo'
                  : 'Save for later'}
              </Button>
              <Button
                size="hero"
                disabled={busy}
                onClick={() => void startApply()}
              >
                Apply for role
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="gnd-link gnd-back" onClick={onBack}>
      <ArrowLeft aria-hidden="true" /> All roles
    </button>
  );
}
