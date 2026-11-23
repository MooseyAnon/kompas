import React, { useEffect, useState } from 'react';
import { AlertCircle, SlidersHorizontal } from 'lucide-react';
import { listSavedSearches } from '../../../../api';
import type { Destination } from '../../destinations';
import { Button } from '../../../components/Button';
import type {
  DiscoveryWorkflowState,
  JobDiscoveryConfigurationV1,
} from '../../../../../shared/contracts';
import type { JobsEntry, Navigate } from '../../GndPage';
import { FindingRoles } from './FindingRoles';
import { JobCard } from './JobCard';
import { JobDetail } from './JobDetail';
import { JobsSearches, type Tab } from './JobsSearches';
import { RoleSearchBox } from './RoleSearchBox';
import { startSearch } from './roleSearch';
import { SearchFilters } from './SearchFilters';
import { filterCount, stoppedShort } from './searchFilterRules';
import { PreferencesPanel } from './PreferencesPanel';
import {
  fitsPreferences,
  preferencesOf,
  SETUP_OPTIONS,
} from './searchPreferences';
import { useJobs } from './useJobs';
import { useSearchPreferences } from './useSearchPreferences';
import { Toast } from '../../components/Overlay';
import './JobsList.css';

type Finished = { at: Date; state: DiscoveryWorkflowState | null };
type View =
  | { kind: 'roles'; finished?: Finished }
  | { kind: 'detail'; opportunityId: string }
  | { kind: 'filters' }
  | { kind: 'finding'; runId: string }
  | { kind: 'searches'; tab: Tab; runId?: string };

/** "Senior Product Designer, Design Lead · London, Leeds · Hybrid" */
export function searchSummary(config: JobDiscoveryConfigurationV1 | null) {
  if (!config) return '';
  const intent = config.intent;
  const prefs = preferencesOf(intent);
  return [
    intent.targetRoles.join(', '),
    prefs.locations.join(', '),
    prefs.setups
      .map((s) => SETUP_OPTIONS.find((o) => o.value === s)?.label)
      .join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Jobs: "Search your next role" (best matches first), a job's detail, search
 * filters, the "Finding your roles" screen and the results it opens.
 */
export function JobsPage({
  onNavigate,
  initialTab,
  initialOpportunityId,
  initialFilters,
  initialRunId,
}: {
  onNavigate?: Navigate | ((next: Destination) => void);
  /** Open the older searches workspace on this tab. */
  initialTab?: Tab;
  initialOpportunityId?: string;
  initialFilters?: boolean;
  initialRunId?: string;
}) {
  const [view, setView] = useState<View>(
    initialRunId
      ? { kind: 'finding', runId: initialRunId }
      : initialFilters
        ? { kind: 'filters' }
        : initialTab
          ? { kind: 'searches', tab: initialTab }
          : initialOpportunityId
            ? { kind: 'detail', opportunityId: initialOpportunityId }
            : { kind: 'roles' },
  );
  const [config, setConfig] = useState<JobDiscoveryConfigurationV1 | null>(
    null,
  );
  const [searchId, setSearchId] = useState<string | null>(null);
  const navigate: Navigate = (next, entry?: JobsEntry) =>
    (onNavigate as Navigate | undefined)?.(next, entry);

  useEffect(() => {
    if (view.kind !== 'roles' && view.kind !== 'finding') return;
    void listSavedSearches({ limit: 50 })
      .then(({ items }) => {
        const search = items.find((item) => item.config.active) ?? items[0];
        setConfig(search?.config ?? null);
        setSearchId(search?.id ?? null);
      })
      .catch(() => undefined);
  }, [view.kind]);

  if (view.kind === 'searches')
    return (
      <JobsSearches
        key={view.runId ?? view.tab}
        onNavigate={onNavigate}
        onBack={() => setView({ kind: 'roles' })}
        initialTab={view.tab}
        initialRunId={view.runId}
      />
    );
  if (view.kind === 'detail')
    return (
      <JobDetail
        opportunityId={view.opportunityId}
        onBack={() => setView({ kind: 'roles' })}
        onNavigate={navigate}
      />
    );
  if (view.kind === 'filters')
    return (
      <SearchFilters
        onBack={() => setView({ kind: 'roles' })}
        onStarted={(runId) => setView({ kind: 'finding', runId })}
      />
    );

  return (
    <>
      <RolesList
        key={view.kind === 'roles' && view.finished ? 'finished' : 'roles'}
        finished={view.kind === 'roles' ? view.finished : undefined}
        filters={filterCount(config)}
        onOpen={(opportunityId) => setView({ kind: 'detail', opportunityId })}
        onFilters={() => setView({ kind: 'filters' })}
        onStarted={(runId) => setView({ kind: 'finding', runId })}
      />
      {view.kind === 'finding' && (
        <FindingRoles
          runId={view.runId}
          summary={searchSummary(config)}
          onDone={(state) =>
            setView({ kind: 'roles', finished: { at: new Date(), state } })
          }
          onFilters={() => setView({ kind: 'filters' })}
          onRetry={() => {
            if (!searchId) return setView({ kind: 'filters' });
            void startSearch(searchId)
              .then((runId) => setView({ kind: 'finding', runId }))
              .catch(() => setView({ kind: 'filters' }));
          }}
        />
      )}
    </>
  );
}

function RolesList({
  finished,
  filters,
  onOpen,
  onFilters,
  onStarted,
}: {
  finished?: Finished;
  filters: number;
  onOpen: (opportunityId: string) => void;
  onFilters: () => void;
  onStarted: (runId: string) => void;
}) {
  // New roles from the latest search; with none, the most recent ones found.
  const fresh = useJobs('new');
  const recent = useJobs('all');
  const forYou = fresh.loading || fresh.jobs.length ? fresh : recent;
  const saved = useJobs('saved');
  const prefs = useSearchPreferences();
  const [showAll, setShowAll] = useState(false);
  const warning = finished ? stoppedShort(finished.state) : null;
  const chosen = prefs.config ? preferencesOf(prefs.config.intent) : null;
  const fitting = chosen
    ? forYou.jobs.filter((job) => fitsPreferences(job.facts, chosen).fits)
    : forYou.jobs;
  const shown = showAll ? forYou.jobs : fitting;
  const hidden = forYou.jobs.length - fitting.length;
  const count = shown.length;

  return (
    <section className="gnd-jobs" aria-labelledby="jobs-list-title">
      <header className="gnd-jobs-head">
        <div className="gnd-jobs-titles">
          {finished && (
            <p className="gnd-eyebrow">
              Search finished ·{' '}
              {finished.at.toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          )}
          <h1 id="jobs-list-title" className="gnd-page-title">
            {finished
              ? forYou.loading
                ? 'Your new roles'
                : count
                  ? `${count} new role${count === 1 ? '' : 's'} for you`
                  : 'No new roles this time'
              : 'Search your next role'}
          </h1>
        </div>
        <div className="gnd-jobs-tools">
          <RoleSearchBox className="gnd-jobs-search" onStarted={onStarted} />
          <button
            type="button"
            className="gnd-filters-button"
            onClick={onFilters}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filters
            {filters > 0 && <span className="gnd-badge">{filters}</span>}
          </button>
        </div>
      </header>

      <div className="gnd-jobs-layout">
        {prefs.config && (
          <aside className="gnd-jobs-side" aria-label="Your preferences">
            <PreferencesPanel prefs={prefs} variant="side" />
            <Button
              variant="outline"
              disabled={prefs.busy}
              onClick={() => void prefs.searchNow(onStarted)}
            >
              Search again with these
            </Button>
          </aside>
        )}
        <div className="gnd-jobs-main">
          {finished && (warning || count > 0) && (
            <p className="gnd-jobs-fineprint">
              {count > 0 && <span>Best match first</span>}
              {warning && (
                <span className="gnd-jobs-warning">
                  <AlertCircle aria-hidden="true" /> {warning}
                </span>
              )}
            </p>
          )}

          {!finished && (
            <div className="gnd-jobs-section-head">
              <h2 className="gnd-section-title">Recent roles</h2>
            </div>
          )}
          {!forYou.loading && hidden > 0 && (
            <p className="gnd-jobs-hidden">
              {showAll
                ? `Showing all ${forYou.jobs.length} roles, including ${hidden} outside your preferences.`
                : `${hidden} role${hidden === 1 ? '' : 's'} hidden by your preferences.`}{' '}
              <button
                type="button"
                className="gnd-link"
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? 'Hide them' : 'Show all'}
              </button>
            </p>
          )}
          {forYou.loading ? (
            <p className="gnd-state" role="status">
              Loading roles…
            </p>
          ) : forYou.error ? (
            <p className="gnd-state" role="alert">
              {forYou.error}
            </p>
          ) : count ? (
            <div className="gnd-job-grid">
              {shown.map((job) => (
                <JobCard key={job.id} job={job} layout="list" onOpen={onOpen} />
              ))}
            </div>
          ) : hidden > 0 ? (
            <p className="gnd-state">
              None of the new roles fit your preferences yet. Loosen one on the
              left, or show them all.
            </p>
          ) : finished ? (
            <div className="gnd-jobs-empty">
              <p>
                Nothing new matched this time. Try widening your filters: add a
                role, set work setup to Any, or remove a company or keyword.
              </p>
              <Button variant="outline" onClick={onFilters}>
                Change filters
              </Button>
            </div>
          ) : (
            <p className="gnd-state">
              No new roles right now. Search for a role above, or check your
              filters and search again.
            </p>
          )}

          {saved.jobs.length > 0 && (
            <>
              <div className="gnd-jobs-section-head">
                <h2 className="gnd-section-title">Saved for later</h2>
              </div>
              <div className="gnd-job-grid">
                {saved.jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    layout="list"
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <Toast message={prefs.toast.message} />
    </section>
  );
}
