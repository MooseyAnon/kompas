import React, { useEffect, useState } from 'react';
import { Buddy } from '../../buddy/Buddy';
import { ArrowRight, Sparkles } from 'lucide-react';
import {
  getProfile,
  listApplications,
  listDiscoveryRuns,
  listSavedSearches,
} from '../../../../api';
import type { Application } from '../../../../../shared/contracts';
import { Button } from '../../../components/Button';
import type { Navigate } from '../../GndPage';
import { JobCard } from '../jobs/JobCard';
import { RoleSearchBox } from '../jobs/RoleSearchBox';
import { useJobs } from '../jobs/useJobs';
import { practiceFor } from '../applications/applicationsView';
import { nextInterview, forYou, type ForYou } from './homeView';
import { QuickActions } from './QuickActions';
import './HomePage.css';

export function HomePage({ onNavigate }: { onNavigate: Navigate }) {
  const { jobs, loading } = useJobs('new');
  const [name, setName] = useState('');
  const [interview, setInterview] = useState<Application | null>(null);
  const [state, setState] = useState<{
    running: boolean;
    hasSearch: boolean;
  } | null>(null);

  useEffect(() => {
    void getProfile()
      .then((profile) => setName(profile.displayName.trim().split(/\s+/u)[0]))
      .catch(() => {});
    void listApplications({ kind: 'interview', limit: 50 })
      .then((page) => setInterview(nextInterview(page.items, new Date())))
      .catch(() => {});
    void Promise.all([
      listDiscoveryRuns({ limit: 1 }),
      listSavedSearches({ limit: 1 }),
    ])
      .then(([runs, searches]) =>
        setState({
          running: runs.items[0]?.status === 'running',
          hasSearch: searches.items.length > 0,
        }),
      )
      .catch(() => setState({ running: false, hasSearch: true }));
  }, []);

  const card: ForYou | null =
    state && !loading
      ? forYou(jobs.length, state.running, state.hasSearch)
      : null;
  const shown = jobs.slice(0, 4);

  return (
    <section className="gnd-home" aria-labelledby="home-title">
      <header className="gnd-home-head">
        <div className="gnd-home-greeting">
          <Buddy className="gnd-home-buddy" size={64} />
          <div>
            <p className="gnd-home-hello">
              {name ? `Hey ${name}` : 'Hey there'}
            </p>
            <h1 id="home-title" className="gnd-home-title">
              Your next move.
            </h1>
          </div>
        </div>
        <RoleSearchBox
          className="gnd-home-search"
          onStarted={(runId) => onNavigate('jobs', { runId })}
        />
      </header>

      <div className="gnd-home-cards">
        <article className="gnd-for-you" aria-live="polite">
          <p className="gnd-for-you-eyebrow">
            <Sparkles aria-hidden="true" /> For you
          </p>
          {card ? (
            <>
              <h2>{card.title}</h2>
              <p>{card.body}</p>
              <Button
                size="hero"
                variant="light"
                onClick={() =>
                  onNavigate(
                    'jobs',
                    card.tab === 'filters'
                      ? { filters: true }
                      : card.tab
                        ? { tab: card.tab }
                        : undefined,
                  )
                }
              >
                {card.action}
              </Button>
            </>
          ) : (
            <h2 className="gnd-for-you-loading">Looking at your roles…</h2>
          )}
        </article>

        <article className="gnd-next-interview">
          {interview ? (
            <>
              <div className="gnd-next-interview-head">
                <p>Next interview</p>
                {Date.parse(interview.currentStage.occurredAt) > Date.now() && (
                  <span className="gnd-badge">Coming soon</span>
                )}
              </div>
              <h2>{interview.companyName}</h2>
              <p className="gnd-muted">
                {interview.roleTitle} · {interview.currentStage.stageLabel}
              </p>
              <p className="gnd-muted">
                {new Date(interview.currentStage.occurredAt).toLocaleString(
                  'en-GB',
                  {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  },
                )}
              </p>
              <Button
                size="hero"
                variant="outline"
                onClick={() =>
                  onNavigate('interviews', {
                    practice: practiceFor(interview, 'deep_loop'),
                  })
                }
              >
                Prepare for interview
              </Button>
            </>
          ) : (
            <>
              <p className="gnd-next-interview-eyebrow">Interview practice</p>
              <h2>Start preparing for interviews</h2>
              <p className="gnd-muted">
                Practise for the roles you’re looking for. No interview
                scheduled? You can still get started.
              </p>
              <Button size="hero" onClick={() => onNavigate('interviews')}>
                Practice interviews <ArrowRight aria-hidden="true" />
              </Button>
            </>
          )}
        </article>
      </div>

      <QuickActions onNavigate={onNavigate} />

      <div className="gnd-home-matches-head">
        <h2 className="gnd-section-title">
          New matches
          {jobs.length > 0 && <span className="gnd-count">{jobs.length}</span>}
        </h2>
        <button
          type="button"
          className="gnd-link"
          onClick={() => onNavigate('jobs')}
        >
          See all jobs <ArrowRight aria-hidden="true" />
        </button>
      </div>
      {loading ? (
        <p className="gnd-state">Loading your matches…</p>
      ) : shown.length ? (
        <div className="gnd-job-grid">
          {shown.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onOpen={(id) => onNavigate('jobs', { opportunityId: id })}
            />
          ))}
        </div>
      ) : (
        <p className="gnd-state">
          No new roles yet. Search for a role above, or run your saved search.
        </p>
      )}
    </section>
  );
}
