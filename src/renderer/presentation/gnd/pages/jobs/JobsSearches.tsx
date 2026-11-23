import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  Clock3,
  ListFilter,
  Plus,
  Search,
  Bookmark,
} from 'lucide-react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import {
  PillTabs,
  pillTabId,
  pillTabPanelId,
  type PillTab,
} from '../../../components/PillTabs';
import { SearchEditor } from '../../../../pages/jobs/SearchEditor';
import { DiscoverRun } from '../../../../pages/jobs/DiscoverRun';
import { ReviewInbox } from '../../../../pages/jobs/review/ReviewInbox';
import { ApplicationsBoard } from '../../../../pages/jobs/applications/ApplicationsBoard';
import type { Destination } from '../../destinations';
import { useJobsController } from '../../../../pages/jobs/useJobsController';
import '../../../../pages/jobs/JobsPage.css';

export type Tab = 'saved' | 'discover' | 'review' | 'applications';
const tabs: readonly PillTab<Tab>[] = [
  { id: 'saved', label: 'Saved Searches', icon: BriefcaseBusiness },
  { id: 'discover', label: 'Discover', icon: Search },
  { id: 'review', label: 'Review', icon: Bookmark },
  { id: 'applications', label: 'Applications', icon: BriefcaseBusiness },
];

/**
 * The searches workspace: saved searches, run progress, the review inbox and
 * the applications board. Reached from Jobs ("Your searches").
 */
export function JobsSearches({
  onNavigate,
  onBack,
  initialTab = 'saved',
  initialRunId,
}: {
  onNavigate?: (next: Destination) => void;
  onBack?: () => void;
  initialTab?: Tab;
  /** Open this run's progress (e.g. one just started from a search box). */
  initialRunId?: string;
}) {
  const c = useJobsController();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  useEffect(() => {
    if (initialRunId) c.openRun(initialRunId);
  }, [initialRunId]);
  const outlet = useRef<HTMLDivElement>(null);
  const editorName = c.editor?.id ?? 'new';
  useLayoutEffect(() => {
    if (outlet.current) outlet.current.scrollTop = 0;
  }, [tab, c.runId, c.editor?.id]);

  function enterRun(id: string) {
    c.openRun(id);
    setTab('discover');
  }
  // A run ID is assigned only after a successful start (or an explicit open).
  useEffect(() => {
    if (c.runId) setTab('discover');
  }, [c.runId]);
  // Arriving from onboarding: open the run it just started (the newest).
  const openedNewest = useRef(initialTab !== 'discover');
  useEffect(() => {
    if (openedNewest.current || c.runs.loading || c.runId) return;
    const newest = c.runs.items[0];
    if (!newest) return;
    openedNewest.current = true;
    c.openRun(newest.id);
  }, [c.runs.loading, c.runs.items, c.runId]);

  return (
    <section
      className="jobs-page"
      data-testid="jobs-page"
      aria-labelledby="jobs-title"
    >
      <header className="jobs-intro">
        {onBack && (
          <button type="button" className="gnd-link jobs-back" onClick={onBack}>
            <ArrowLeft aria-hidden="true" /> All roles
          </button>
        )}
        <h1 id="jobs-title" className="gnd-page-title">
          Your searches
        </h1>
        <p>
          Save the searches that matter to you, run them, and follow what they
          find.
        </p>
      </header>
      <PillTabs
        tabs={tabs}
        selected={tab}
        onSelect={setTab}
        label="Jobs sections"
        idPrefix="jobs"
      />
      <Card className="jobs-main-card">
        <div
          ref={outlet}
          className="jobs-outlet"
          role="tabpanel"
          id={pillTabPanelId('jobs')}
          aria-labelledby={pillTabId('jobs', tab)}
          tabIndex={0}
          data-testid={`jobs-view-${tab}`}
        >
          {tab === 'applications' ? (
            <ApplicationsBoard
              outlet={outlet}
              openApplicationId={applicationId}
              onApplicationClosed={() => setApplicationId(null)}
            />
          ) : tab === 'saved' ? (
            c.editor ? (
              <SearchEditor
                key={editorName}
                form={c.editor.form}
                savedId={c.editor.id}
                errors={c.errors}
                notice={c.notice}
                busy={!!c.busy}
                activeRunId={c.activeRun?.id ?? null}
                preview={
                  c.preview?.id === c.editor.id ? c.preview.queries : null
                }
                onChange={c.changeForm}
                onBack={c.closeEditor}
                onSave={c.save}
                onPreview={() => {
                  if (c.editor?.saved) c.showPreview(c.editor.saved);
                }}
                onStart={() => c.start()}
                onViewActiveRun={() => {
                  if (c.activeRun) enterRun(c.activeRun.id);
                }}
              />
            ) : (
              <div className="jobs-saved">
                <div className="jobs-heading">
                  <div>
                    <h2>Saved searches</h2>
                    <p>
                      Keep your search intent together and start discovery
                      explicitly.
                    </p>
                  </div>
                  <Button
                    leadingIcon={<Plus size={18} />}
                    onClick={() => c.openEditor()}
                    data-testid="jobs-new"
                  >
                    New search
                  </Button>
                </div>
                {c.notice && (
                  <p role="status" className="jobs-feedback">
                    {c.notice}
                  </p>
                )}
                {c.activeRun && (
                  <Card
                    variant="subtle"
                    padding="compact"
                    className="jobs-active"
                  >
                    <span>A discovery is running.</span>
                    <Button
                      variant="secondary"
                      onClick={() => enterRun(c.activeRun!.id)}
                    >
                      View active run
                    </Button>
                  </Card>
                )}
                {c.searches.loading && (
                  <p role="status">Loading saved searches…</p>
                )}
                {c.searches.error && (
                  <p role="alert" className="jobs-error">
                    {c.searches.error}{' '}
                    <Button
                      variant="secondary"
                      onClick={() => void c.loadSearches()}
                    >
                      Retry
                    </Button>
                  </p>
                )}
                {!c.searches.loading &&
                  !c.searches.error &&
                  c.searches.items.length === 0 && (
                    <EmptyState icon={ListFilter} title="No saved searches yet">
                      <p>
                        Create a search to keep your roles and sources ready for
                        discovery.
                      </p>
                    </EmptyState>
                  )}
                <div className="jobs-card-grid">
                  {c.searches.items.map((item) => {
                    const last = c.latest.get(item.id);
                    return (
                      <Card
                        key={item.id}
                        variant="subtle"
                        padding="compact"
                        className="jobs-search-card"
                      >
                        <div className="jobs-card-title">
                          <h3>{item.config.name}</h3>
                          <span className="jobs-badge">
                            {item.config.active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <p>{item.config.intent.targetRoles.join(' · ')}</p>
                        <p className="jobs-meta">
                          {[
                            item.config.intent.location,
                            item.config.intent.field,
                            item.config.intent.seniority,
                            ...item.config.intent.companies,
                            ...item.config.intent.keywords,
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'No additional intent'}
                        </p>
                        <p className="jobs-meta">
                          Sources:{' '}
                          {item.config.sources.collectionProviders
                            .map((provider) =>
                              provider === 'linkedin' ? 'LinkedIn' : 'Indeed',
                            )
                            .join(', ')}
                          {last ? ` · Latest loaded run: ${last.status}` : ''}
                        </p>
                        <div className="jobs-actions">
                          <Button
                            variant="secondary"
                            disabled={!!c.busy}
                            onClick={() => c.openEditor(item)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={!!c.busy}
                            onClick={() => c.toggle(item)}
                          >
                            {item.config.active ? 'Deactivate' : 'Activate'}
                          </Button>
                          <Button
                            disabled={
                              !!c.busy || !item.config.active || !!c.activeRun
                            }
                            onClick={() => c.start(item)}
                          >
                            Run
                          </Button>
                          {last && (
                            <Button
                              variant="ghost"
                              onClick={() => enterRun(last.id)}
                            >
                              View last run
                            </Button>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
                {c.searches.cursor && (
                  <Button
                    variant="secondary"
                    disabled={c.searchMore}
                    onClick={() => void c.loadSearches(c.searches.cursor!)}
                  >
                    Load more searches
                  </Button>
                )}
              </div>
            )
          ) : tab === 'review' ? (
            <ReviewInbox
              outlet={outlet}
              onOpenApplication={(id) => {
                setApplicationId(id);
                setTab('applications');
                requestAnimationFrame(() =>
                  document
                    .getElementById(pillTabId('jobs', 'applications'))
                    ?.focus(),
                );
              }}
            />
          ) : (
            <div className="jobs-discover">
              <div className="jobs-heading">
                <div>
                  <h2>Discover</h2>
                  <p>
                    Follow each candidate as discovery progresses and inspect
                    saved evidence.
                  </p>
                </div>
                {c.runId && (
                  <Button
                    variant="secondary"
                    leadingIcon={<ArrowLeft size={17} />}
                    onClick={() => {
                      setTab('saved');
                      document
                        .getElementById(pillTabId('jobs', 'saved'))
                        ?.focus();
                    }}
                  >
                    Back to saved searches
                  </Button>
                )}
              </div>
              {c.runId && (
                <DiscoverRun
                  key={c.runId}
                  id={c.runId}
                  savedTitle={
                    c.searches.items.find(
                      (item) => item.id === c.runDetail?.savedSearchId,
                    )?.config.name
                  }
                  startWarning={c.runError}
                  onNavigate={onNavigate}
                  onRunChanged={() => void c.loadRuns()}
                />
              )}
              <h3 className="jobs-history-title">
                <Clock3 size={19} aria-hidden="true" /> Recent runs
              </h3>
              {c.runs.loading && <p role="status">Loading run history…</p>}
              {c.runs.error && (
                <p role="alert" className="jobs-error">
                  {c.runs.error}{' '}
                  <Button variant="secondary" onClick={() => void c.loadRuns()}>
                    Retry
                  </Button>
                </p>
              )}
              {!c.runs.loading &&
                !c.runs.error &&
                c.runs.items.length === 0 && (
                  <EmptyState icon={Search} title="No runs yet">
                    <p>
                      Create an active saved search and start discovery when
                      you’re ready.
                    </p>
                  </EmptyState>
                )}
              <ul className="jobs-run-list">
                {c.runs.items.map((run) => (
                  <li key={run.id}>
                    <Card padding="compact" variant="subtle">
                      <span>
                        {c.searches.items.find(
                          (item) => item.id === run.savedSearchId,
                        )?.config.name ?? 'Saved search'}{' '}
                        · {run.status}
                      </span>
                      <span className="jobs-meta">
                        {new Date(run.startedAt).toLocaleString()} ·{' '}
                        {run.stats.newCandidates} admitted
                      </span>
                      <Button
                        variant="secondary"
                        onClick={() => enterRun(run.id)}
                      >
                        Open run
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
              {c.runs.cursor && (
                <Button
                  variant="secondary"
                  disabled={c.runMore}
                  onClick={() => void c.loadRuns(c.runs.cursor!)}
                >
                  Load more runs
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
