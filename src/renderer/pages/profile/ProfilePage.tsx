import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  CircleCheck,
  GraduationCap,
  Layers,
  FileText,
  MapPin,
  Pencil,
  Plus,
  Rocket,
  Sparkles,
  Target as TargetIcon,
  UserRound,
} from 'lucide-react';
import type { Experience, Profile, Target } from '../../../shared/contracts';
import type { Destination } from '../../app/destinations';
import {
  getProfile,
  listConfirmedSkills,
  listExperiences,
  listTargets,
  replaceConfirmedSkills,
  updateTarget,
} from '../../api';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import {
  PillTabs,
  pillTabId,
  pillTabPanelId,
  type PillTab,
} from '../../presentation/components/PillTabs';
import { MeadowCardCorner } from '../../presentation/meadow/decorations/MeadowCardCorner';
import { DocumentsSection } from './DocumentsSection';
import { ProfileIdentityCard, ProfileOverview } from './ProfileOverview';
import {
  ExperienceEditor,
  ProfileEditor,
  TargetEditor,
  errorText,
  removeExperience,
  removeTarget,
} from './editors';
import './ProfilePage.css';

type Tab =
  | 'overview'
  | 'experience'
  | 'education'
  | 'skills'
  | 'targets'
  | 'documents';
const tabs: readonly PillTab<Tab>[] = [
  { id: 'overview', label: 'Overview', icon: UserRound },
  { id: 'experience', label: 'Experience', icon: BriefcaseBusiness },
  { id: 'education', label: 'Education', icon: BookOpen },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'targets', label: 'Targets', icon: TargetIcon },
  { id: 'documents', label: 'Documents', icon: FileText },
];
type Data = {
  profile: Profile;
  experiences: Experience[];
  targets: Target[];
  skills: string[];
};

const targetBadgeIcons = [Rocket, Layers, Sparkles] as const;

const categoryLabels: Record<string, string> = {
  employment: 'Work',
  education: 'Education',
  project: 'Project',
  other: 'Other',
};

function parseDate(value: string | null | undefined) {
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(value ?? '');
  if (!match) return null;
  return { year: Number(match[1]), month: match[2] ? Number(match[2]) : null };
}

function formatDate(value: string | null | undefined) {
  const parsed = parseDate(value);
  if (!parsed) return value ?? '';
  if (parsed.month === null) return String(parsed.year);
  return new Date(parsed.year, parsed.month - 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

/** Month-precision duration; omitted when either end is only a year. */
function durationLabel(
  start: string | null | undefined,
  end: string | null | undefined,
) {
  const from = parseDate(start);
  const now = new Date();
  const to = end
    ? parseDate(end)
    : { year: now.getFullYear(), month: now.getMonth() + 1 };
  if (!from?.month || !to?.month) return '';
  const months = (to.year - from.year) * 12 + (to.month - from.month) + 1;
  if (months < 1) return '';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [
    years && `${years} ${years === 1 ? 'year' : 'years'}`,
    rest && `${rest} ${rest === 1 ? 'month' : 'months'}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Clamped to two lines so entries stay uniform; expands on request. */
function EntryDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    const measure = () =>
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <>
      <p
        ref={ref}
        className={`profile-entry-description${expanded ? '' : ' is-clamped'}`}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          className="profile-entry-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

export function ProfilePage({
  onNavigate,
  initialTab = 'overview',
  onboarding = false,
}: {
  onNavigate: (next: Destination) => void;
  initialTab?: Tab;
  onboarding?: boolean;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<
    'profile' | 'experience' | 'target' | null
  >(null);
  const [editing, setEditing] = useState<Experience | Target | undefined>();
  const [working, setWorking] = useState(false);
  const outlet = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const editorTrigger = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async (initial = false) => {
    const id = ++request.current;
    if (initial) setLoading(true);
    try {
      const [profile, experiences, targets, skills] = await Promise.all([
        getProfile(),
        listExperiences(),
        listTargets(),
        listConfirmedSkills(),
      ]);
      if (id === request.current) {
        setData({ profile, experiences, targets, skills });
        setError('');
      }
    } catch (e) {
      if (id === request.current) setError(errorText(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh(true);
    return () => {
      request.current++;
    };
  }, [refresh]);
  useLayoutEffect(() => {
    if (outlet.current) outlet.current.scrollTop = 0;
  }, [tab]);
  function select(next: Tab) {
    setTab(next);
    setEditor(null);
    setEditing(undefined);
    setNotice('');
    setError('');
  }
  function open(
    next: 'profile' | 'experience' | 'target',
    item?: Experience | Target,
  ) {
    editorTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setEditing(item);
    setEditor(next);
    setNotice('');
  }
  function close() {
    setEditor(null);
    setEditing(undefined);
    requestAnimationFrame(() => {
      if (editorTrigger.current?.isConnected) editorTrigger.current.focus();
      else document.getElementById(pillTabId('profile', tab))?.focus();
    });
  }
  async function mutate(task: () => Promise<void>, message: string) {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await task();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  }
  function saved(message: string) {
    void refresh();
    setNotice(message);
  }

  const entries = (data?.experiences ?? []).filter((item) =>
    tab === 'education'
      ? item.category === 'education'
      : item.category !== 'education',
  );
  const transparentCard =
    tab === 'overview' ||
    tab === 'experience' ||
    tab === 'education' ||
    tab === 'targets' ||
    tab === 'skills' ||
    tab === 'documents';
  // Distinct sectors and levels of active targets; no separate direction data exists yet.
  const directionChips = [
    ...new Set(
      (data?.targets ?? [])
        .filter((item) => item.active)
        .flatMap((item) => [item.sector, item.targetLevel])
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  return (
    <section
      className={`profile-page${onboarding ? ' profile-onboarding' : ''}`}
      aria-labelledby={onboarding ? undefined : 'profile-title'}
      aria-label={onboarding ? 'Profile editing' : undefined}
      data-testid="profile-page"
    >
      {!onboarding && (
        <header className="profile-intro">
          <span className="profile-intro-icon" aria-hidden="true">
            <FileText size={44} strokeWidth={1.8} />
          </span>
          <div>
            <h1 id="profile-title">
              Profile
              <Sparkles size={30} aria-hidden="true" />
            </h1>
            <p>Your confirmed career story, always yours to edit.</p>
          </div>
          <Button
            variant="secondary"
            className="profile-intro-edit"
            leadingIcon={<Pencil size={17} aria-hidden="true" />}
            onClick={() => {
              select('overview');
              open('profile');
            }}
          >
            Edit profile
          </Button>
        </header>
      )}
      {(!onboarding || initialTab === 'overview') && (
        <PillTabs
          tabs={tabs}
          selected={tab}
          onSelect={select}
          label="Profile sections"
          idPrefix="profile"
        />
      )}
      <Card
        className={`profile-main-card${transparentCard ? ' is-overview' : ''}`}
      >
        <div
          className="profile-outlet"
          ref={outlet}
          role="tabpanel"
          id={pillTabPanelId('profile')}
          aria-labelledby={
            onboarding && initialTab !== 'overview'
              ? undefined
              : pillTabId('profile', tab)
          }
          aria-label={
            onboarding && initialTab !== 'overview'
              ? `${tab} editing`
              : undefined
          }
          tabIndex={0}
          data-testid={`profile-view-${tab}`}
        >
          {loading && <p role="status">Loading profile…</p>}
          {error && (
            <p role="alert">
              {error}{' '}
              {!data && (
                <Button variant="secondary" onClick={() => void refresh(true)}>
                  Try again
                </Button>
              )}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {data && !loading && (
            <div className="profile-content" key={tab}>
              {tab === 'overview' && (
                <ProfileOverview
                  {...data}
                  onEditProfile={() => open('profile')}
                  onAddExperience={() => {
                    select('experience');
                    open('experience');
                  }}
                  onAddTarget={() => {
                    select('targets');
                    open('target');
                  }}
                  onShowTargets={() => select('targets')}
                  onShowSkills={() => select('skills')}
                  onShowDocuments={() => select('documents')}
                />
              )}
              {editor === 'profile' && (
                <ProfileEditor
                  profile={data.profile}
                  onSaved={(profile) => {
                    setData({ ...data, profile });
                    saved('Profile saved.');
                  }}
                  onClose={close}
                />
              )}
              {(tab === 'experience' || tab === 'education') && (
                <div className="profile-experience-layout">
                  <aside className="profile-identity-column">
                    <ProfileIdentityCard
                      profile={data.profile}
                      leadTarget={
                        data.targets.find((item) => item.active) ??
                        data.targets[0] ??
                        null
                      }
                      onShowTargets={() => select('targets')}
                    />
                  </aside>
                  <Card
                    className={`profile-experience-panel${tab === 'education' ? ' is-education' : ''}`}
                  >
                    <header className="profile-panel-head">
                      {tab === 'education' ? (
                        <GraduationCap size={40} aria-hidden="true" />
                      ) : (
                        <BriefcaseBusiness size={30} aria-hidden="true" />
                      )}
                      <div className="profile-experience-title">
                        <h2>
                          {tab === 'education'
                            ? 'Education'
                            : 'Experience & projects'}
                        </h2>
                        <p>
                          {tab === 'education'
                            ? 'Your academic background, qualifications and continuous learning.'
                            : 'Your work history, projects and professional growth.'}
                        </p>
                      </div>
                      <Button
                        className="profile-experience-add"
                        leadingIcon={<Plus size={18} aria-hidden="true" />}
                        onClick={() => open('experience')}
                      >
                        Add {tab === 'education' ? 'education' : 'experience'}
                      </Button>
                    </header>
                    {editor === 'experience' && (
                      <ExperienceEditor
                        item={editing as Experience | undefined}
                        category={
                          tab === 'education' ? 'education' : 'employment'
                        }
                        onSaved={() => saved('Experience saved.')}
                        onClose={close}
                      />
                    )}
                    {entries.length === 0 && (
                      <p>
                        No {tab === 'education' ? 'education' : 'experience'}{' '}
                        recorded yet. Add your own entries at any time.
                      </p>
                    )}
                    {tab === 'education' && entries.length > 0 && (
                      <section
                        className="profile-education-history"
                        aria-labelledby="profile-education-history-title"
                      >
                        <header className="profile-education-history-head">
                          <BookOpen size={26} aria-hidden="true" />
                          <h3 id="profile-education-history-title">
                            Education history
                          </h3>
                          <span className="profile-count-pill">
                            {entries.length}{' '}
                            {entries.length === 1 ? 'item' : 'items'}
                          </span>
                        </header>
                        <ul className="profile-education-list">
                          {entries.map((item) => (
                            <li key={item.id}>
                              <article className="profile-education-entry">
                                <span
                                  className="profile-education-badge"
                                  aria-hidden="true"
                                >
                                  <GraduationCap size={30} />
                                </span>
                                <div className="profile-education-main">
                                  <span className="profile-education-chip">
                                    Education
                                  </span>
                                  <h4>{item.roleTitle || item.organisation}</h4>
                                  {item.roleTitle && item.organisation && (
                                    <p className="profile-education-org">
                                      {item.organisation}
                                    </p>
                                  )}
                                  {item.description && (
                                    <EntryDescription text={item.description} />
                                  )}
                                </div>
                                {(item.startDate || item.endDate) && (
                                  <p className="profile-education-dates">
                                    <CalendarDays
                                      size={18}
                                      aria-hidden="true"
                                    />
                                    {formatDate(item.startDate) ||
                                      'Date not set'}{' '}
                                    – {formatDate(item.endDate) || 'Present'}
                                  </p>
                                )}
                                <div className="profile-entry-actions">
                                  {item.startDate && !item.endDate && (
                                    <span className="profile-status is-active">
                                      Current
                                    </span>
                                  )}
                                  <Button
                                    variant="secondary"
                                    className="profile-small-button"
                                    leadingIcon={
                                      <Pencil size={15} aria-hidden="true" />
                                    }
                                    onClick={() => open('experience', item)}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    className="profile-small-button"
                                    disabled={working}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `Delete ${item.roleTitle}?`,
                                        )
                                      )
                                        void mutate(
                                          () => removeExperience(item),
                                          'Experience deleted.',
                                        );
                                    }}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </article>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {tab !== 'education' && (
                      <ol className="profile-timeline">
                        {entries.map((item) => {
                          const current = Boolean(
                            item.startDate && !item.endDate,
                          );
                          const duration = durationLabel(
                            item.startDate,
                            item.endDate,
                          );
                          return (
                            <li
                              key={item.id}
                              className={current ? 'is-current' : undefined}
                            >
                              <span
                                className="profile-timeline-dot"
                                aria-hidden="true"
                              />
                              <article
                                className={`profile-entry${current ? ' profile-decorated' : ''}`}
                              >
                                {current && (
                                  <MeadowCardCorner variant="subtle" />
                                )}
                                <span
                                  className="profile-entry-badge"
                                  aria-hidden="true"
                                >
                                  {item.category === 'education' ? (
                                    <GraduationCap size={30} />
                                  ) : (
                                    <Building2 size={30} />
                                  )}
                                </span>
                                <div className="profile-entry-body">
                                  <h3>{item.organisation || item.roleTitle}</h3>
                                  {item.organisation && (
                                    <p className="profile-entry-role">
                                      {item.roleTitle}
                                    </p>
                                  )}
                                  <p className="profile-entry-meta">
                                    {(item.startDate || item.endDate) && (
                                      <span className="profile-entry-dates">
                                        <CalendarDays
                                          size={16}
                                          aria-hidden="true"
                                        />
                                        {formatDate(item.startDate) ||
                                          'Date not set'}{' '}
                                        –{' '}
                                        {formatDate(item.endDate) || 'Present'}
                                        {duration && ` (${duration})`}
                                      </span>
                                    )}
                                    <span className="profile-entry-category">
                                      <BriefcaseBusiness
                                        size={15}
                                        aria-hidden="true"
                                      />
                                      {categoryLabels[item.category] ??
                                        item.category}
                                    </span>
                                  </p>
                                  {item.description && (
                                    <EntryDescription text={item.description} />
                                  )}
                                </div>
                                <div className="profile-entry-actions">
                                  {current && (
                                    <span className="profile-status is-active">
                                      Current
                                    </span>
                                  )}
                                  <Button
                                    variant="secondary"
                                    className="profile-small-button"
                                    leadingIcon={
                                      <Pencil size={15} aria-hidden="true" />
                                    }
                                    onClick={() => open('experience', item)}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    className="profile-small-button"
                                    disabled={working}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `Delete ${item.roleTitle}?`,
                                        )
                                      )
                                        void mutate(
                                          () => removeExperience(item),
                                          'Experience deleted.',
                                        );
                                    }}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </article>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </Card>
                </div>
              )}
              {tab === 'skills' && (
                <div className="profile-experience-layout">
                  <aside className="profile-identity-column">
                    <ProfileIdentityCard
                      profile={data.profile}
                      leadTarget={
                        data.targets.find((item) => item.active) ??
                        data.targets[0] ??
                        null
                      }
                      onShowTargets={() => select('targets')}
                    />
                  </aside>
                  <SkillsSection
                    names={data.skills}
                    onSaved={(skills) => {
                      setData({ ...data, skills });
                      setNotice(
                        'Confirmed skills saved. Refresh matches in Jobs to update scores.',
                      );
                    }}
                  />
                </div>
              )}
              {tab === 'targets' && (
                <div className="profile-experience-layout">
                  <aside className="profile-identity-column">
                    <ProfileIdentityCard
                      profile={data.profile}
                      leadTarget={
                        data.targets.find((item) => item.active) ??
                        data.targets[0] ??
                        null
                      }
                      onShowTargets={() => select('targets')}
                    />
                  </aside>
                  <div className="profile-experience-panel profile-hero-panel is-targets">
                    <header className="profile-panel-head">
                      <TargetIcon size={40} aria-hidden="true" />
                      <div className="profile-experience-title">
                        <h2>Career direction</h2>
                        <p>
                          Set as many directions as you need. Targets are
                          separate from your current role.
                        </p>
                        {directionChips.length > 0 && (
                          <ul
                            className="profile-direction-chips"
                            aria-label="Active target focus"
                          >
                            {directionChips.map((chip) => (
                              <li key={chip}>{chip}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </header>
                    <section
                      className="profile-education-history profile-target-roles"
                      aria-labelledby="profile-target-roles-title"
                    >
                      <header className="profile-education-history-head">
                        <Layers size={28} aria-hidden="true" />
                        <h3 id="profile-target-roles-title">Target roles</h3>
                        <Button
                          variant="secondary"
                          className="profile-small-button"
                          leadingIcon={<Plus size={16} aria-hidden="true" />}
                          onClick={() => open('target')}
                        >
                          Add target
                        </Button>
                      </header>
                      {editor === 'target' && (
                        <TargetEditor
                          item={editing as Target | undefined}
                          onSaved={() => saved('Target saved.')}
                          onClose={close}
                        />
                      )}
                      {!data.targets.length && <p>No target roles yet.</p>}
                      <ul className="profile-education-list">
                        {data.targets.map((item, index) => {
                          const BadgeIcon =
                            targetBadgeIcons[index % targetBadgeIcons.length];
                          return (
                            <li key={item.id}>
                              <article className="profile-target-entry">
                                <span
                                  className={`profile-target-entry-badge is-tone-${index % targetBadgeIcons.length}`}
                                  aria-hidden="true"
                                >
                                  <BadgeIcon size={30} />
                                </span>
                                <div className="profile-target-entry-main">
                                  <h4>{item.roleTitle}</h4>
                                  {item.sector && (
                                    <p className="profile-target-entry-focus">
                                      Sector: {item.sector}
                                    </p>
                                  )}
                                  <p className="profile-target-entry-meta">
                                    {item.targetLevel && (
                                      <span>
                                        <ChartNoAxesColumn
                                          size={15}
                                          aria-hidden="true"
                                        />
                                        Level: {item.targetLevel}
                                      </span>
                                    )}
                                    {item.location && (
                                      <span>
                                        <MapPin size={15} aria-hidden="true" />
                                        Location: {item.location}
                                      </span>
                                    )}
                                    {!item.targetLevel &&
                                      !item.location &&
                                      !item.sector &&
                                      'No additional details'}
                                  </p>
                                </div>
                                <div className="profile-entry-actions">
                                  <span
                                    className={`profile-status${item.active ? ' is-active' : ''}`}
                                  >
                                    {item.active ? 'Active' : 'Inactive'}
                                  </span>
                                  <Button
                                    variant="secondary"
                                    className="profile-small-button"
                                    leadingIcon={
                                      <Pencil size={15} aria-hidden="true" />
                                    }
                                    onClick={() => open('target', item)}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    className="profile-small-button"
                                    disabled={working}
                                    onClick={() =>
                                      void mutate(
                                        async () => {
                                          await updateTarget(item.id, {
                                            active: !item.active,
                                          });
                                        },
                                        item.active
                                          ? 'Target deactivated.'
                                          : 'Target activated.',
                                      )
                                    }
                                  >
                                    {item.active ? 'Deactivate' : 'Activate'}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    className="profile-small-button"
                                    disabled={working}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `Delete target ${item.roleTitle}?`,
                                        )
                                      )
                                        void mutate(
                                          () => removeTarget(item),
                                          'Target deleted.',
                                        );
                                    }}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </article>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  </div>
                </div>
              )}
              {tab === 'documents' && (
                <div className="profile-experience-layout">
                  <aside className="profile-identity-column">
                    <ProfileIdentityCard
                      profile={data.profile}
                      leadTarget={
                        data.targets.find((item) => item.active) ??
                        data.targets[0] ??
                        null
                      }
                      onShowTargets={() => select('targets')}
                    />
                  </aside>
                  <DocumentsSection
                    profile={data.profile}
                    experiences={data.experiences}
                    skills={data.skills}
                    onChanged={() => void refresh()}
                    onSettings={() => onNavigate('settings')}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

function SkillsSection({
  names,
  onSaved,
}: {
  names: string[];
  onSaved: (names: string[]) => void;
}) {
  const [draft, setDraft] = useState(names.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const current = await listConfirmedSkills();
      if (current.join('\n') !== names.join('\n')) {
        setError(
          'Skills changed elsewhere. Reopen this section before saving.',
        );
        return;
      }
      const result = await replaceConfirmedSkills(
        draft
          .split('\n')
          .map((name) => name.trim())
          .filter(Boolean),
      );
      setDraft(result.join('\n'));
      setEditing(false);
      onSaved(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="profile-experience-panel profile-hero-panel is-skills">
      <header className="profile-panel-head">
        <Layers size={40} aria-hidden="true" />
        <div className="profile-experience-title">
          <h2>Skills</h2>
          <p>
            Only skills you explicitly confirm appear here. Confirmed skills are
            used to score job matches.
          </p>
        </div>
      </header>
      <div className="profile-skills-summary">
        <div className="profile-skills-stat">
          <CircleCheck size={34} aria-hidden="true" />
          <span>
            <strong>{names.length}</strong>
            Confirmed {names.length === 1 ? 'skill' : 'skills'}
          </span>
        </div>
        <Button
          className="profile-experience-add"
          leadingIcon={<Pencil size={18} aria-hidden="true" />}
          aria-expanded={editing}
          onClick={() => {
            setDraft(names.join('\n'));
            setError('');
            setEditing(!editing);
          }}
        >
          {editing ? 'Close editor' : 'Edit skills'}
        </Button>
      </div>
      {editing && (
        <form
          className="profile-form profile-skills-editor"
          onSubmit={(e) => void save(e)}
        >
          <label>
            Skills (one per line, up to 100)
            <textarea
              rows={8}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save confirmed skills'}
          </Button>
        </form>
      )}
      <section
        className="profile-skills-group"
        aria-labelledby="profile-skills-confirmed-title"
      >
        <header className="profile-education-history-head">
          <CircleCheck size={26} aria-hidden="true" />
          <h3 id="profile-skills-confirmed-title">Confirmed skills</h3>
          <span className="profile-count-pill">
            {names.length} {names.length === 1 ? 'skill' : 'skills'}
          </span>
        </header>
        {names.length ? (
          <ul className="profile-skill-chips">
            {names.map((name) => (
              <li key={name} className="profile-skill-chip">
                <CircleCheck size={18} aria-hidden="true" />
                {name}
              </li>
            ))}
          </ul>
        ) : (
          <p>No confirmed skills yet. Use Edit skills to add them.</p>
        )}
      </section>
    </div>
  );
}
