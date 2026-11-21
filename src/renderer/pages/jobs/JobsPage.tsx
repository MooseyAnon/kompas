import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  Clock3,
  ListFilter,
  Pencil,
  Play,
  Plus,
  Search,
  Bookmark,
} from 'lucide-react';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import { EmptyState } from '../../presentation/components/EmptyState';
import {
  PillTabs,
  pillTabId,
  pillTabPanelId,
  type PillTab,
} from '../../presentation/components/PillTabs';
import { SearchEditor } from './SearchEditor';
import { DiscoverRun } from './DiscoverRun';
import { ReviewInbox } from './review/ReviewInbox';
import { ApplicationsBoard } from './applications/ApplicationsBoard';
import type { Destination } from '../../app/destinations';
import { useJobsController } from './useJobsController';
import { MeadowCardCorner } from '../../presentation/meadow/decorations/MeadowCardCorner';
import type { SavedSearch } from '../../../shared/contracts/job-discovery';
import './JobsPage.css';

type Tab = 'saved' | 'discover' | 'review' | 'applications';
const tabs: readonly PillTab<Tab>[] = [
  { id: 'saved', label: 'Saved Searches', icon: BriefcaseBusiness },
  { id: 'discover', label: 'Discover', icon: Search },
  { id: 'review', label: 'Review', icon: Bookmark },
  { id: 'applications', label: 'Applications', icon: BriefcaseBusiness },
];

export function JobsPage({
  onNavigate,
}: {
  onNavigate?: (next: Destination) => void;
}) {
  const c = useJobsController();
  const [tab, setTab] = useState<Tab>('saved');
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const outlet = useRef<HTMLDivElement>(null);
  const editorName = c.editor?.id ?? 'new';
  // The create/edit pane is always visible beside the list; this flag tracks
  // whether the user explicitly opened it (New/Edit) rather than the default blank form.
  const [editorOpened, setEditorOpened] = useState(false);
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
  useEffect(() => {
    if (tab === 'saved' && !c.editor && !c.busy) {
      setEditorOpened(false);
      c.openEditor();
    }
  }, [tab, c.editor, c.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  function openEditor(item?: SavedSearch) {
    setEditorOpened(true);
    c.openEditor(item);
  }
  function closeEditor() {
    setEditorOpened(false);
    c.closeEditor();
  }
  const split =
    tab === 'saved' ||
    tab === 'discover' ||
    tab === 'review' ||
    tab === 'applications';
  const title =
    tab === 'discover' && c.activeRun
      ? 'Discovery in progress'
      : 'Find your next opportunity';

  return (
    <section
      className="jobs-page"
      data-testid="jobs-page"
      aria-labelledby="jobs-title"
    >
      <header className="jobs-intro">
        <h1 id="jobs-title">
          <BriefcaseBusiness size={40} aria-hidden="true" /> {title}
        </h1>
      </header>
      <PillTabs
        tabs={tabs}
        selected={tab}
        onSelect={setTab}
        label="Jobs sections"
        idPrefix="jobs"
      />
      <Card className={`jobs-main-card${split ? ' jobs-main-card-split' : ''}`}>
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
            <div className="jobs-saved-layout">
              <Card className="jobs-pane jobs-saved">
                <div className="jobs-heading">
                  <div>
                    <h2>Saved searches</h2>
                    <p>Manage your searches and run discovery when ready.</p>
                  </div>
                  <Button
                    leadingIcon={<Plus size={18} />}
                    onClick={() => openEditor()}
                    data-testid="jobs-new"
                  >
                    New search
                  </Button>
                </div>
                {c.notice && !editorOpened && (
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
                        <MeadowCardCorner variant="floral" />
                        <div className="jobs-card-title">
                          <h3>
                            <BriefcaseBusiness size={22} aria-hidden="true" />
                            {item.config.name}
                          </h3>
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
                        <div
                          className="jobs-card-facts"
                          aria-label="Sources and latest run"
                        >
                          {item.config.sources.collectionProviders.map(
                            (provider) => (
                              <span key={provider} className="jobs-chip">
                                {provider === 'linkedin'
                                  ? 'LinkedIn'
                                  : 'Indeed'}
                              </span>
                            ),
                          )}
                          {last && (
                            <span
                              className={`jobs-last-run jobs-status-${last.status}`}
                            >
                              Latest loaded run: <strong>{last.status}</strong>
                            </span>
                          )}
                        </div>
                        <div className="jobs-actions">
                          <Button
                            variant="secondary"
                            leadingIcon={<Pencil size={16} />}
                            disabled={!!c.busy}
                            onClick={() => openEditor(item)}
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
                            leadingIcon={<Play size={16} />}
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
              </Card>
              {c.editor && (
                <Card className="jobs-pane jobs-editor-pane">
                  <SearchEditor
                    key={editorName}
                    form={c.editor.form}
                    savedId={c.editor.id}
                    errors={c.errors}
                    notice={editorOpened ? c.notice : null}
                    busy={!!c.busy}
                    activeRunId={c.activeRun?.id ?? null}
                    preview={
                      c.preview?.id === c.editor.id ? c.preview.queries : null
                    }
                    onChange={c.changeForm}
                    onBack={editorOpened ? closeEditor : undefined}
                    autoFocus={editorOpened}
                    onSave={c.save}
                    onPreview={() => {
                      if (c.editor?.saved) c.showPreview(c.editor.saved);
                    }}
                    onStart={() => c.start()}
                    onViewActiveRun={() => {
                      if (c.activeRun) enterRun(c.activeRun.id);
                    }}
                  />
                </Card>
              )}
            </div>
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
              <div
                className={`jobs-heading${c.runId ? ' jobs-heading-run' : ''}`}
              >
                <div className="jobs-heading-text">
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
              <Card className="jobs-roles jobs-history">
                <h3 className="jobs-history-title">
                  <Clock3 size={19} aria-hidden="true" /> Recent runs
                </h3>
                <p className="jobs-meta">
                  Open a run to follow its discovered roles.
                </p>
                {c.runs.loading && <p role="status">Loading run history…</p>}
                {c.runs.error && (
                  <p role="alert" className="jobs-error">
                    {c.runs.error}{' '}
                    <Button
                      variant="secondary"
                      onClick={() => void c.loadRuns()}
                    >
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
                      <Card
                        padding="compact"
                        className="jobs-candidate jobs-candidate-row"
                      >
                        <BriefcaseBusiness
                          size={20}
                          aria-hidden="true"
                          className="jobs-candidate-icon"
                        />
                        <h4>
                          {c.searches.items.find(
                            (item) => item.id === run.savedSearchId,
                          )?.config.name ?? 'Saved search'}
                        </h4>
                        <span
                          className={`jobs-status-chip jobs-run-status jobs-status-${run.status}`}
                        >
                          {run.status}
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
              </Card>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
