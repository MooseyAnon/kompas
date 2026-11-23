import React, { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, Plus } from 'lucide-react';
import {
  getApplication,
  getProfile,
  listApplications,
  listConfirmedSkills,
  listDocuments,
  listExperiences,
  listSavedSearches,
  listTargets,
  openDocument,
  recordApplicationStage,
  setApplicationArchived,
  updateProfile,
} from '../../../../api';
import type {
  Application,
  ApplicationDocument,
  Experience,
  Profile,
  StageEvent,
} from '../../../../../shared/contracts';
import { failureNotice, useNotify } from '../../../../app/Notifications';
import { randomMascot } from '../../components/Avatar';
import { Button } from '../../../components/Button';
import type { Navigate } from '../../GndPage';
import { ApplicationDetailPage } from './ApplicationDetailPage';
import { ApplicationModal } from './ApplicationForms';
import type { JobView } from '../jobs/jobView';
import { preferencesOf } from '../jobs/searchPreferences';
import { useJobs } from '../jobs/useJobs';
import {
  DocumentsPanel,
  ExperienceList,
  ProfilePicture,
  SkillPicker,
} from './ProfileParts';
import { ProfileSetup } from './ProfileSetup';
import {
  agendaFor,
  appliedLine,
  archivedReason,
  groupApplications,
  initials,
  practiceFor,
  profileLine,
  whenText,
  type AgendaDay,
  type Filter,
} from './applicationsView';
import './ApplicationsPage.css';

const DOTS = 20;
const MATCHES_SHOWN = 3;

/**
 * Your profile and applications on one page: who you are, the roles you're
 * looking for, your experience and documents, then applications by status.
 */
export function ApplicationsPage({
  onNavigate,
  focusSkills,
}: {
  onNavigate: Navigate;
  /** Open with the skill search ready to type in. */
  focusSkills?: boolean;
}) {
  const notify = useNotify();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [experiences, setExperiences] = useState<Experience[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [items, setItems] = useState<Application[] | null>(null);
  const [archivedItems, setArchivedItems] = useState<Application[]>([]);
  const [stages, setStages] = useState<Record<string, StageEvent[]>>({});
  const [adding, setAdding] = useState(false);
  const [documents, setDocuments] = useState<
    Record<string, ApplicationDocument[]>
  >({});
  const [filter, setFilter] = useState<Filter>('applied');
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [hasCv, setHasCv] = useState<boolean | null>(null);
  const jobs = useJobs('all');

  async function load() {
    setError('');
    try {
      const [p, exp, sk, targets, searches, apps] = await Promise.all([
        getProfile(),
        listExperiences(),
        listConfirmedSkills(),
        listTargets(),
        listSavedSearches({ limit: 50 }),
        listApplications({ archived: false, limit: 50 }),
      ]);
      void listDocuments()
        .then((docs) => setHasCv(docs.some((doc) => doc.category === 'cv')))
        .catch(() => setHasCv(false));
      void listApplications({ archived: true, limit: 50 })
        .then((archived) => setArchivedItems(archived.items))
        .catch(() => setArchivedItems([]));
      setProfile(p);
      // Everyone gets a sprout the first time; they can change it.
      if (!p.avatar)
        void updateProfile({ avatar: randomMascot() })
          .then(setProfile)
          .catch(() => undefined);
      setExperiences(exp);
      setSkills(sk);
      const search =
        searches.items.find((item) => item.config.active) ?? searches.items[0];
      // The roles you're looking for come from your search; older profiles
      // without one fall back to their career targets.
      setRoles(
        search?.config.intent.targetRoles ??
          targets.filter((t) => t.active).map((t) => t.roleTitle),
      );
      const places = search
        ? preferencesOf(search.config.intent).locations
        : [];
      setLocation(places.join(', ') || p.location || '');
      setItems(apps.items);
      const details = await Promise.all(
        apps.items.map((item) => getApplication(item.id).catch(() => null)),
      );
      setStages(
        Object.fromEntries(
          details
            .filter((d) => d !== null)
            .map((d) => [d.application.id, d.stages]),
        ),
      );
      setDocuments(
        Object.fromEntries(
          details
            .filter((d) => d !== null)
            .map((d) => [
              d.application.id,
              d.documents.filter((doc) => !doc.unlinkedAt && !doc.unavailable),
            ]),
        ),
      );
    } catch {
      setError('Couldn’t load your applications. Please try again.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (openId)
    return (
      <ApplicationDetailPage
        applicationId={openId}
        onNavigate={onNavigate}
        onBack={() => {
          setOpenId(null);
          void load();
        }}
      />
    );

  const groups = groupApplications(items ?? [], archivedItems);
  // Applications wait until there's a CV, or answers standing in for one,
  // so a new profile shows how to start instead of empty lists. Anyone who
  // already has applications sees them regardless.
  const setUp =
    hasCv === true ||
    experiences.length > 0 ||
    (items?.length ?? 0) + archivedItems.length > 0;
  const checking = hasCv === null || items === null;
  const name = profile?.displayName.trim() || 'Your profile';
  const agenda = agendaFor(
    (items ?? [])
      .filter((item) => stages[item.id])
      .map((item) => ({ application: item, stages: stages[item.id] })),
    new Date(),
  );
  const upcomingCount = agenda.upcoming.reduce(
    (n, day) => n + day.events.length,
    0,
  );
  const savedJobs = jobs.jobs.filter((job) => job.decision === 'saved');
  const matches = jobs.jobs
    .filter((job) => job.decision === 'new')
    .slice(0, MATCHES_SHOWN);
  const jobForApplication = (id: string) =>
    jobs.jobs.find((job) => job.applicationId === id);

  async function open(doc: ApplicationDocument) {
    if (!doc.documentId) return;
    try {
      await openDocument(doc.documentId);
    } catch (e) {
      notify(failureNotice(e, 'Couldn’t open that file.'));
    }
  }

  async function markApplied(item: Application) {
    try {
      await recordApplicationStage({
        applicationId: item.id,
        stageLabel: 'Applied',
        stageKind: 'applied',
      });
      await load();
      void jobs.reload();
    } catch (e) {
      notify(failureNotice(e, 'Couldn’t mark that as applied.'));
    }
  }

  const openJob = (job: JobView) =>
    onNavigate('jobs', { opportunityId: job.id });
  const openOpening = (item: Application) => {
    const job = jobForApplication(item.id);
    if (job) openJob(job);
    else setOpenId(item.id);
  };

  return (
    <section className="gnd-applications" aria-labelledby="applications-title">
      <h1
        id="applications-title"
        className="gnd-page-title gnd-applications-title"
      >
        Profile
      </h1>

      <article className="gnd-profile-panel" aria-label="Your profile">
        {setUp && (
          <Button
            className="gnd-profile-add"
            variant="outline"
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" /> Add an application
          </Button>
        )}
        <ProfilePicture
          value={profile?.avatar}
          initials={initials(profile?.displayName ?? '')}
          onChange={async (avatar) =>
            setProfile(await updateProfile({ avatar }))
          }
        />
        <div className="gnd-profile-panel-body">
          <h2>{name}</h2>
          {profile && (
            <p className="gnd-muted">{profileLine(profile, experiences)}</p>
          )}
          {profile?.summary && (
            <p className="gnd-profile-summary">{profile.summary}</p>
          )}
          <SkillPicker
            skills={skills}
            onChange={setSkills}
            autoOpen={focusSkills}
          />
          <div className="gnd-profile-pickers">
            <button
              type="button"
              className="gnd-picker"
              onClick={() => onNavigate('jobs', { filters: true })}
            >
              <span>Looking for:</span>
              <strong>
                {roles.length ? roles.join(', ') : 'Choose roles'}
              </strong>
              <ChevronDown aria-hidden="true" />
            </button>
            <button
              type="button"
              className="gnd-picker"
              onClick={() => onNavigate('jobs', { filters: true })}
            >
              <span>Locations:</span>
              <strong>{location || 'Choose locations'}</strong>
              <ChevronDown aria-hidden="true" />
            </button>
          </div>
        </div>
      </article>

      {!checking && !setUp && (
        <ProfileSetup
          skills={skills}
          onSkills={setSkills}
          onDone={() => void load()}
        />
      )}
      {setUp && (
        <>
          <ExperienceList
            experiences={experiences}
            onChanged={() => void load()}
          />

          <section
            className="gnd-opportunities"
            aria-labelledby="opportunities-title"
          >
            <div className="gnd-applications-label-row">
              <h2 id="opportunities-title" className="gnd-applications-label">
                Opportunities for you
              </h2>
              <button
                type="button"
                className="gnd-link"
                onClick={() => onNavigate('jobs')}
              >
                See all jobs <ArrowRight aria-hidden="true" />
              </button>
            </div>
            {groups.openings.length || matches.length ? (
              <div className="gnd-opportunity-list">
                {groups.openings.map((item) => (
                  <OpportunityRow
                    key={item.id}
                    company={item.companyName}
                    title={item.roleTitle}
                    meta={item.location}
                    tag={<span className="gnd-tag-note">Listing opened</span>}
                    onView={() => openOpening(item)}
                    onApplied={() => void markApplied(item)}
                  />
                ))}
                {matches.map((job) => (
                  <OpportunityRow
                    key={job.id}
                    company={job.company}
                    title={job.title}
                    meta={[job.place, job.salary].filter(Boolean).join(' · ')}
                    tag={
                      job.matchPercent !== null ? (
                        <span className="gnd-badge">
                          {job.matchPercent}% match
                        </span>
                      ) : null
                    }
                    onView={() => openJob(job)}
                  />
                ))}
              </div>
            ) : (
              <p className="gnd-state">
                {jobs.loading
                  ? 'Loading…'
                  : 'No new roles yet. Search for a role and matches will show up here.'}
              </p>
            )}
          </section>

          <div
            className="gnd-app-filters"
            role="tablist"
            aria-label="Filter applications"
          >
            {(
              [
                ['applied', `${groups.applied.length} applied`],
                [
                  'interviews',
                  `${upcomingCount} interview${upcomingCount === 1 ? '' : 's'}`,
                ],
                ['saved', `${savedJobs.length} saved`],
                ['archived', 'Archived'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {error && (
            <p className="gnd-state" role="alert">
              {error}
            </p>
          )}

          <div className="gnd-applications-grid">
            <div className="gnd-applications-lists" role="tabpanel">
              {items === null && filter !== 'saved' ? (
                <p className="gnd-state" role="status">
                  Loading…
                </p>
              ) : filter === 'applied' ? (
                <>
                  <h2 className="gnd-applications-label">Applied</h2>
                  {groups.applied.length ? (
                    groups.applied.map((item) => (
                      <AppliedCard
                        key={item.id}
                        item={item}
                        documents={documents[item.id] ?? []}
                        onUpdate={() => setOpenId(item.id)}
                        onPractise={() =>
                          onNavigate('interviews', {
                            practice: practiceFor(item, 'quick_fire'),
                          })
                        }
                        onOpenDocument={(doc) => void open(doc)}
                      />
                    ))
                  ) : (
                    <p className="gnd-state">
                      Nothing applied yet. When you send an application, mark it
                      as applied and it shows up here.
                    </p>
                  )}
                </>
              ) : filter === 'interviews' ? (
                agenda.upcoming.length || agenda.earlier.length ? (
                  <div className="gnd-agenda">
                    {agenda.upcoming.length > 0 && (
                      <>
                        <p className="gnd-agenda-section">Coming up</p>
                        <p className="gnd-agenda-today">
                          Today ·{' '}
                          {new Date().toLocaleDateString('en-GB', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                          })}
                        </p>
                        {agenda.upcoming.map((day) => (
                          <AgendaDayRow
                            key={day.key}
                            day={day}
                            onOpen={setOpenId}
                            onPractise={(applicationId) => {
                              const app = groups.interviews
                                .concat(groups.applied)
                                .find((item) => item.id === applicationId);
                              if (app)
                                onNavigate('interviews', {
                                  practice: practiceFor(app, 'deep_loop'),
                                });
                            }}
                          />
                        ))}
                      </>
                    )}
                    {agenda.earlier.length > 0 && (
                      <>
                        <p className="gnd-agenda-section">Earlier</p>
                        {agenda.earlier.map((day) => (
                          <AgendaDayRow
                            key={day.key}
                            day={day}
                            onOpen={setOpenId}
                          />
                        ))}
                      </>
                    )}
                  </div>
                ) : (
                  <p className="gnd-state">
                    No interviews yet. When you’re invited, update the
                    application’s status to Interview and it shows up here.
                  </p>
                )
              ) : filter === 'archived' ? (
                <>
                  <h2 className="gnd-applications-label">Archived</h2>
                  <p className="gnd-muted gnd-archived-intro">
                    Applications that have closed, or that you’ve put away.
                  </p>
                  {groups.archived.length ? (
                    groups.archived.map((item) => (
                      <ArchivedCard
                        key={item.id}
                        item={item}
                        onOpen={() => setOpenId(item.id)}
                        onRestore={
                          item.archivedAt
                            ? () =>
                                void setApplicationArchived(item.id, false)
                                  .then(load)
                                  .catch((e) =>
                                    notify(
                                      failureNotice(
                                        e,
                                        'Couldn’t move that back.',
                                      ),
                                    ),
                                  )
                            : undefined
                        }
                      />
                    ))
                  ) : (
                    <p className="gnd-state">Nothing archived.</p>
                  )}
                </>
              ) : (
                <>
                  <div className="gnd-applications-label-row">
                    <h2 className="gnd-applications-label">Saved for later</h2>
                    <span className="gnd-muted">Not submitted</span>
                  </div>
                  {savedJobs.length ? (
                    savedJobs.map((job) => (
                      <div key={job.id} className="gnd-saved-row">
                        <div>
                          <p className="gnd-muted">{job.company}</p>
                          <h3>{job.title}</h3>
                          {job.place && (
                            <p className="gnd-muted">{job.place}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          className="gnd-link"
                          onClick={() => openJob(job)}
                        >
                          View role <ArrowRight aria-hidden="true" />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="gnd-state">
                      {jobs.loading ? 'Loading…' : 'No saved roles.'}
                    </p>
                  )}
                </>
              )}
            </div>

            <aside className="gnd-applications-side">
              <h2>
                {groups.sentCount} job{groups.sentCount === 1 ? '' : 's'}{' '}
                applied
              </h2>
              <div className="gnd-dots" aria-hidden="true">
                {Array.from({ length: DOTS }, (_, i) => (
                  <span
                    key={i}
                    className={i < groups.sentCount ? 'is-on' : ''}
                  />
                ))}
              </div>
              <p className="gnd-muted gnd-dots-caption">
                One filled dot per job you’ve applied to
              </p>
              <hr />
              <DocumentsPanel />
              <hr />
              <h2 className="gnd-practise-title">
                {upcomingCount ? 'Get ready.' : 'Room to practise.'}
              </h2>
              <p className="gnd-muted">
                {upcomingCount
                  ? 'You have an interview coming up. Run a mock interview for it.'
                  : 'No interview invitations recorded. You can still practise at your own pace.'}
              </p>
              <button
                type="button"
                className="gnd-link"
                onClick={() =>
                  upcomingCount
                    ? setFilter('interviews')
                    : onNavigate('interviews')
                }
              >
                {upcomingCount
                  ? 'See your interviews'
                  : 'Start general practice'}{' '}
                <ArrowRight aria-hidden="true" />
              </button>
            </aside>
          </div>
        </>
      )}
      {adding && (
        <ApplicationModal
          onClose={() => setAdding(false)}
          onDone={(detail) => {
            setAdding(false);
            void load();
            if (detail) setOpenId(detail.application.id);
          }}
        />
      )}
    </section>
  );
}

function AgendaDayRow({
  day,
  onOpen,
  onPractise,
}: {
  day: AgendaDay;
  onOpen: (applicationId: string) => void;
  onPractise?: (applicationId: string) => void;
}) {
  return (
    <section
      className={`gnd-agenda-day${day.past ? ' is-past' : ''}`}
      aria-label={`${day.weekday} ${day.day} ${day.month}`}
    >
      <div className="gnd-agenda-date" aria-hidden="true">
        <span className="gnd-agenda-wd">{day.weekday}</span>
        <span className="gnd-agenda-dn">{day.day}</span>
        <span className="gnd-agenda-mo">{day.month}</span>
      </div>
      <div className="gnd-agenda-events">
        {day.events.map((event) => (
          <article
            key={event.id}
            className="gnd-agenda-event"
            data-testid="interview-card"
          >
            <span className="gnd-agenda-time">{event.time ?? 'All day'}</span>
            <div className="gnd-agenda-text">
              <h3>{event.title}</h3>
              <p className="gnd-muted">{event.role}</p>
            </div>
            <div className="gnd-agenda-actions">
              <button
                type="button"
                className="gnd-link"
                onClick={() => onOpen(event.applicationId)}
              >
                Details
              </button>
              {onPractise && !day.past && (
                <Button onClick={() => onPractise(event.applicationId)}>
                  Practise
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ArchivedCard({
  item,
  onOpen,
  onRestore,
}: {
  item: Application;
  onOpen: () => void;
  onRestore?: () => void;
}) {
  return (
    <article className="gnd-applied-card gnd-archived-card">
      <div className="gnd-applied-card-head">
        <p className="gnd-muted">{item.companyName}</p>
        <span className="gnd-badge is-grey">{archivedReason(item)}</span>
      </div>
      <h3>{item.roleTitle}</h3>
      <p className="gnd-muted">
        {item.location ? `${item.location} · ` : ''}
        {whenText(item.currentStage.occurredAt)}
      </p>
      <hr />
      <div className="gnd-archived-actions">
        <button type="button" className="gnd-link" onClick={onOpen}>
          Open details
        </button>
        {onRestore && (
          <button type="button" className="gnd-link" onClick={onRestore}>
            Move back to applied
          </button>
        )}
      </div>
    </article>
  );
}

function OpportunityRow({
  company,
  title,
  meta,
  tag,
  onView,
  onApplied,
}: {
  company: string;
  title: string;
  meta?: string | null;
  tag?: React.ReactNode;
  onView: () => void;
  onApplied?: () => void;
}) {
  return (
    <article className="gnd-saved-row gnd-opportunity-row">
      <div>
        <p className="gnd-muted">{company}</p>
        <h3>{title}</h3>
        {meta && <p className="gnd-muted">{meta}</p>}
      </div>
      <div className="gnd-opportunity-side">
        {tag}
        <span className="gnd-opportunity-actions">
          {onApplied && (
            <button type="button" className="gnd-link" onClick={onApplied}>
              I’ve applied
            </button>
          )}
          <button type="button" className="gnd-link" onClick={onView}>
            View role <ArrowRight aria-hidden="true" />
          </button>
        </span>
      </div>
    </article>
  );
}

function AppliedCard({
  item,
  documents,
  onUpdate,
  onPractise,
  onOpenDocument,
}: {
  item: Application;
  documents: ApplicationDocument[];
  onUpdate: () => void;
  onPractise: () => void;
  onOpenDocument: (doc: ApplicationDocument) => void;
}) {
  const cv = documents.find((doc) => doc.purpose === 'submitted_cv');
  const letter = documents.find(
    (doc) => doc.purpose === 'submitted_cover_letter',
  );
  const closed =
    item.currentStage.stageKind === 'rejected' ||
    item.currentStage.stageKind === 'withdrawn';
  return (
    <article className="gnd-applied-card">
      <div className="gnd-applied-card-head">
        <p className="gnd-muted">
          {item.companyName} · {item.currentStage.stageLabel}
        </p>
        <button type="button" className="gnd-link" onClick={onUpdate}>
          Update status
        </button>
      </div>
      <h3>{item.roleTitle}</h3>
      {item.location && <p className="gnd-muted">{item.location}</p>}
      <p>{appliedLine(item)}</p>
      <hr />
      <div className="gnd-applied-card-actions">
        {closed ? (
          <span className="gnd-muted">Closed</span>
        ) : (
          <Button variant="primary" onClick={onPractise}>
            Practise for this role
          </Button>
        )}
        <span>
          {cv && (
            <button
              type="button"
              className="gnd-link"
              onClick={() => onOpenDocument(cv)}
            >
              View CV
            </button>
          )}
          {letter && (
            <button
              type="button"
              className="gnd-link"
              onClick={() => onOpenDocument(letter)}
            >
              View letter
            </button>
          )}
        </span>
      </div>
    </article>
  );
}
