import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Play,
  Repeat,
  Settings,
  Trash2,
  Trophy,
  Zap,
} from 'lucide-react';
import type {
  InsightsProgress,
  InterviewMethod,
  InterviewSessionSummary,
  InterviewWorkflowState,
} from '../../../../../shared/contracts';
import { getInsightsProgress, listInsightsQuestions } from '../../../../api';
import { Button } from '../../../components/Button';
import type { Destination } from '../../destinations';
import { SessionOutlet } from '../../../../pages/interviews/session/SessionOutlet';
import { HistoryTab } from '../../../../pages/interviews/history/HistoryTab';
import type { PracticePreset } from '../../../../pages/interviews/prepare/preset';
import {
  usePrepareController,
  type PrepareController,
} from '../../../../pages/interviews/prepare/usePrepareController';
import {
  DEFAULT_MINUTES,
  TIME_OPTIONS,
  competencyPoints,
  composeGuidance,
  levelOf,
  questionsFor,
  rankFocus,
  tallyCompetencies,
  POINTS_PER_LEVEL,
  type CompetencyTally,
  type Minutes,
} from './interviewView';
import { useRoleFocus, type RoleFocus } from './useRoleFocus';
import './GndInterviewsPage.css';

type View =
  | { kind: 'home' }
  | { kind: 'setup'; focus?: string[] }
  | { kind: 'history' }
  | { kind: 'session'; id: string; state?: InterviewWorkflowState };

const METHODS: {
  value: InterviewMethod;
  label: string;
  lead: string;
  icon: typeof Zap;
}[] = [
  {
    value: 'quick_fire',
    label: 'Quick-fire',
    lead: 'A focused set of questions, one after another, with feedback at the end.',
    icon: Zap,
  },
  {
    value: 'deep_loop',
    label: 'Deep loop',
    lead: 'A conversation with follow-ups and a review after each answer.',
    icon: Repeat,
  },
];

/**
 * Kompas Interviews: your competency and points, then pick a method and set
 * it up. Drafts and unfinished sessions only appear when there are some.
 */
export function GndInterviewsPage({
  onNavigate,
  preset,
}: {
  onNavigate?: (next: Destination) => void;
  preset?: PracticePreset;
}) {
  const [view, setView] = useState<View>(
    preset ? { kind: 'setup' } : { kind: 'home' },
  );
  const controller = usePrepareController(
    (id, state) => setView({ kind: 'session', id, state }),
    preset,
  );
  const roleFocus = useRoleFocus();
  const openLocalAi = () => onNavigate?.('settings');
  const stageLabels = roleFocus.stages.map((stage) => stage.label);
  const roleName = roleFocus.role ?? 'your next role';

  /** Open the setup for a method, with a subject and focus filled in. */
  function setUp(method: InterviewMethod, subject?: string, focus?: string[]) {
    controller.setMethod(method);
    if (subject !== undefined) controller.setField('subject', subject);
    setView({ kind: 'setup', focus });
  }

  if (view.kind === 'session')
    return (
      <section className="gnd-iv">
        <Back onClick={() => setView({ kind: 'home' })}>
          Back to interviews
        </Back>
        <div className="gnd-card gnd-iv-session">
          <SessionOutlet
            sessionId={view.id}
            initialState={view.state}
            onOpenLocalAi={openLocalAi}
          />
        </div>
      </section>
    );

  if (view.kind === 'history')
    return (
      <section className="gnd-iv">
        <Back onClick={() => setView({ kind: 'home' })}>
          Back to interviews
        </Back>
        <div className="gnd-card gnd-iv-session">
          <HistoryTab
            onOpenSession={(id) => setView({ kind: 'session', id })}
          />
        </div>
      </section>
    );

  if (view.kind === 'setup')
    return (
      <Setup
        controller={controller}
        roleFocus={roleFocus}
        initialFocus={view.focus ?? []}
        onBack={() => {
          controller.cancelEdit();
          setView({ kind: 'home' });
        }}
        onOpenLocalAi={openLocalAi}
      />
    );

  return (
    <section className="gnd-iv" aria-labelledby="gnd-iv-title">
      <header className="gnd-iv-head">
        <div>
          <h1 id="gnd-iv-title" className="gnd-page-title">
            Interviews
          </h1>
          <p className="gnd-muted">
            Practise for {roleName} and watch your competency grow.
          </p>
        </div>
        <Button
          leadingIcon={<Play aria-hidden="true" />}
          data-testid="gnd-iv-mock"
          onClick={() =>
            setUp('deep_loop', `${roleName} interview`, stageLabels)
          }
        >
          Take a mock interview
        </Button>
      </header>

      <PickUp
        controller={controller}
        onEdit={(id) => {
          void controller.editDraft(id);
          setView({ kind: 'setup' });
        }}
      />

      <div className="gnd-iv-home">
        <section className="gnd-iv-start" aria-labelledby="gnd-iv-start-title">
          <h2 id="gnd-iv-start-title" className="gnd-section-title">
            Set up a practice
          </h2>
          <div className="gnd-iv-methods">
            {METHODS.map(({ value, label, lead, icon: Icon }) => (
              <button
                key={value}
                type="button"
                className="gnd-iv-method"
                data-testid={`gnd-iv-method-${value}`}
                onClick={() => setUp(value)}
              >
                <span className="gnd-iv-method-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span className="gnd-iv-method-label">{label}</span>
                <span className="gnd-iv-method-lead">{lead}</span>
                <ArrowRight className="gnd-iv-method-go" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
        <Competency
          roleFocus={roleFocus}
          onTest={() =>
            setUp('quick_fire', `${roleName} baseline`, [
              ...stageLabels,
              ...roleFocus.skills.slice(0, 3).map((skill) => skill.label),
            ])
          }
          onPractise={(name) => setUp('quick_fire', name, [name])}
          onHistory={() => setView({ kind: 'history' })}
        />
      </div>
    </section>
  );
}

function Back({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="gnd-back gnd-iv-back" onClick={onClick}>
      <ArrowLeft aria-hidden="true" /> {children}
    </button>
  );
}

/** Only shown when there is a draft or unfinished session. */
function PickUp({
  controller,
  onEdit,
}: {
  controller: PrepareController;
  onEdit: (id: string) => void;
}) {
  const { recent, busy, confirming } = controller;
  if (recent.status !== 'ready' || recent.data.length === 0) return null;
  const items: InterviewSessionSummary[] = recent.data.slice(0, 3);
  return (
    <section className="gnd-iv-pickup" aria-labelledby="gnd-iv-pickup-title">
      <h2 id="gnd-iv-pickup-title" className="gnd-iv-pickup-title">
        Pick up where you left off
      </h2>
      {controller.rowError && (
        <p className="gnd-form-error" role="alert">
          {controller.rowError}
        </p>
      )}
      <ul className="gnd-iv-pickup-list">
        {items.map((item) => {
          const draft = item.status === 'draft';
          const asking = confirming?.sessionId === item.id;
          return (
            <li key={item.id} className="gnd-card gnd-iv-pickup-card">
              <div>
                <p className="gnd-iv-pickup-meta">
                  {item.method === 'quick_fire' ? 'Quick-fire' : 'Deep loop'} ·{' '}
                  {draft ? 'Draft' : 'In progress'}
                </p>
                <p className="gnd-iv-pickup-subject">{item.subject}</p>
              </div>
              {asking ? (
                <div className="gnd-iv-pickup-actions">
                  <span className="gnd-muted">
                    {draft ? 'Delete this draft?' : 'End this session?'}
                  </span>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={controller.cancelConfirm}
                  >
                    Keep it
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={controller.confirmRow}
                  >
                    {draft ? 'Delete' : 'End it'}
                  </Button>
                </div>
              ) : (
                <div className="gnd-iv-pickup-actions">
                  <button
                    type="button"
                    className="gnd-iv-icon-button"
                    aria-label={`${draft ? 'Delete draft' : 'End session'}: ${item.subject}`}
                    disabled={busy !== null}
                    onClick={() =>
                      controller.requestConfirm(
                        item.id,
                        draft ? 'delete' : 'abandon',
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                  <Button
                    disabled={busy !== null}
                    leadingIcon={<Play aria-hidden="true" />}
                    onClick={() =>
                      draft
                        ? onEdit(item.id)
                        : controller.resumeSession(item.id)
                    }
                  >
                    {draft ? 'Continue setup' : 'Resume'}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Loaded = { progress: InsightsProgress; tallies: CompetencyTally[] };

/**
 * Your competency for the role: its usual interview stages and the skills its
 * job descriptions repeat, ranked by how practice has gone, plus points.
 * Empty until you take the test.
 */
function Competency({
  roleFocus,
  onTest,
  onPractise,
  onHistory,
}: {
  roleFocus: RoleFocus;
  onTest: () => void;
  onPractise: (name: string) => void;
  onHistory: () => void;
}) {
  const [load, setLoad] = useState<
    { status: 'loading' | 'error' } | { status: 'ready'; data: Loaded }
  >({ status: 'loading' });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const progress = await getInsightsProgress({});
        const page =
          progress.subject && progress.method
            ? await listInsightsQuestions({
                subject: progress.subject,
                method: progress.method,
                limit: 100,
              })
            : { items: [] };
        if (live)
          setLoad({
            status: 'ready',
            data: { progress, tallies: tallyCompetencies(page.items) },
          });
      } catch {
        if (live) setLoad({ status: 'error' });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const empty = load.status === 'ready' && load.data.progress.sessions === 0;
  const points =
    load.status === 'ready' ? competencyPoints(load.data.progress) : 0;
  const { level, intoLevel } = levelOf(points);
  const ranked =
    load.status === 'ready'
      ? rankFocus(roleFocus.stages, roleFocus.skills, load.data.tallies)
      : [];

  return (
    <section
      className="gnd-card gnd-iv-competency"
      aria-labelledby="gnd-iv-competency-title"
    >
      <div className="gnd-iv-competency-head">
        <h2 id="gnd-iv-competency-title" className="gnd-section-title">
          Your competency
        </h2>
        {load.status === 'ready' && !empty && (
          <button type="button" className="gnd-link" onClick={onHistory}>
            Past sessions
          </button>
        )}
      </div>
      {roleFocus.role && (
        <p className="gnd-muted gnd-iv-role">For {roleFocus.role}</p>
      )}

      {load.status === 'loading' && (
        <p className="gnd-state" role="status">
          Loading your progress…
        </p>
      )}
      {load.status === 'error' && (
        <p className="gnd-state" role="alert">
          Your progress couldn’t be loaded.
        </p>
      )}

      {empty && (
        <div className="gnd-iv-empty">
          <span className="gnd-iv-trophy">
            <Trophy aria-hidden="true" />
          </span>
          <p>
            Take a short test to see where you stand on the stages and skills{' '}
            {roleFocus.role ? `${roleFocus.role} interviews` : 'interviews'}{' '}
            usually cover. Then practise to earn points.
          </p>
          <Button data-testid="gnd-iv-take-test" onClick={onTest}>
            Take test
          </Button>
        </div>
      )}

      {load.status === 'ready' && !empty && (
        <>
          <div className="gnd-iv-score">
            <span className="gnd-iv-trophy">
              <Trophy aria-hidden="true" />
            </span>
            <div className="gnd-iv-score-text">
              <p className="gnd-iv-points" data-testid="gnd-iv-points">
                {points.toLocaleString('en-GB')} points
              </p>
              <p className="gnd-muted">
                Level {level} · {POINTS_PER_LEVEL - intoLevel} to level{' '}
                {level + 1}
              </p>
            </div>
          </div>
          <div
            className="gnd-iv-meter"
            role="progressbar"
            aria-label={`Progress to level ${level + 1}`}
            aria-valuemin={0}
            aria-valuemax={POINTS_PER_LEVEL}
            aria-valuenow={intoLevel}
          >
            <span style={{ width: `${intoLevel}%` }} />
          </div>
          <ul className="gnd-iv-areas" aria-label="Competencies">
            {ranked.map((row) => (
              <li key={`${row.kind}-${row.id}`} className="gnd-iv-area">
                <div className="gnd-iv-area-row">
                  <span className="gnd-iv-area-name">
                    {row.label}
                    <span className="gnd-iv-area-kind">
                      {row.kind === 'stage' ? 'Stage' : 'Skill'}
                    </span>
                  </span>
                  <span className="gnd-muted">
                    {row.score === null ? 'Not tried' : `${row.score}%`}
                  </span>
                </div>
                <div
                  className="gnd-iv-meter gnd-iv-meter-thin"
                  aria-hidden="true"
                >
                  <span style={{ width: `${row.score ?? 0}%` }} />
                </div>
                <button
                  type="button"
                  className="gnd-link gnd-iv-area-go"
                  onClick={() => onPractise(row.label)}
                >
                  {row.score !== null && row.score >= 70
                    ? 'Keep it sharp'
                    : 'Practise this'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The chosen method's setup: subject, role, time and focus. */
function Setup({
  controller,
  roleFocus,
  initialFocus,
  onBack,
  onOpenLocalAi,
}: {
  controller: PrepareController;
  roleFocus: RoleFocus;
  initialFocus: string[];
  onBack: () => void;
  onOpenLocalAi: () => void;
}) {
  const { values, busy, fieldErrors, editor, targets, notice } = controller;
  const [minutes, setMinutes] = useState<Minutes>(DEFAULT_MINUTES);
  const [focus, setFocus] = useState<string[]>(initialFocus);
  const options = [
    ...new Set([
      ...roleFocus.stages.map((stage) => stage.label),
      ...roleFocus.skills.map((skill) => skill.label),
      ...initialFocus,
    ]),
  ];
  const [note, setNote] = useState(values.additionalGuidance);
  const deepLoop = values.method === 'deep_loop';
  const method = METHODS.find((item) => item.value === values.method)!;
  const locked = busy !== null || editor.kind === 'loading';

  // A draft loads its saved guidance as the typed note.
  useEffect(() => {
    if (editor.kind === 'editing')
      setNote(editor.session.additionalGuidance ?? '');
  }, [editor]);

  // Time and focus are turned into the fields the backend knows about.
  useEffect(() => {
    if (!deepLoop) controller.setField('questionCount', questionsFor(minutes));
    controller.setField(
      'additionalGuidance',
      composeGuidance({ focus, minutes, deepLoop, note }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes, focus, note, deepLoop]);

  function toggle(label: string) {
    setFocus((current) =>
      current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label],
    );
  }

  function start(event: React.FormEvent) {
    event.preventDefault();
    const field = controller.startPractice();
    if (field) document.getElementById(`gnd-iv-${field}`)?.focus();
  }

  const items = targets.status === 'ready' ? targets.data : [];

  return (
    <section className="gnd-iv" aria-labelledby="gnd-iv-setup-title">
      <Back onClick={onBack}>Back to interviews</Back>
      <form className="gnd-iv-setup" noValidate onSubmit={start}>
        <header className="gnd-iv-setup-head">
          <span className="gnd-iv-method-icon">
            <method.icon aria-hidden="true" />
          </span>
          <div>
            <h1 id="gnd-iv-setup-title" className="gnd-section-title">
              {method.label}
            </h1>
            <p className="gnd-muted">{method.lead}</p>
          </div>
        </header>

        <fieldset className="gnd-iv-fields" disabled={locked}>
          <div className="gnd-form-field">
            <label className="gnd-label" htmlFor="gnd-iv-subject">
              What do you want to practise?
            </label>
            <input
              id="gnd-iv-subject"
              className="gnd-input"
              autoComplete="off"
              placeholder="e.g. System design, product sense, design critique"
              value={values.subject}
              aria-invalid={fieldErrors.subject ? true : undefined}
              onChange={(event) =>
                controller.setField('subject', event.target.value)
              }
            />
            {fieldErrors.subject && (
              <p className="gnd-form-error">{fieldErrors.subject}</p>
            )}
          </div>

          {items.length > 0 && (
            <div className="gnd-form-field">
              <label className="gnd-label" htmlFor="gnd-iv-careerTargetId">
                Role it’s for <span className="gnd-muted">(optional)</span>
              </label>
              <select
                id="gnd-iv-careerTargetId"
                className="gnd-input"
                value={values.careerTargetId}
                disabled={targets.status === 'loading'}
                onChange={(event) =>
                  controller.setField('careerTargetId', event.target.value)
                }
              >
                <option value="">Any role</option>
                {items.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.roleTitle}
                  </option>
                ))}
              </select>
            </div>
          )}

          <fieldset className="gnd-iv-group">
            <legend className="gnd-label">How much time do you have?</legend>
            <div className="gnd-iv-chips">
              {TIME_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="gnd-iv-chip"
                  aria-pressed={minutes === option}
                  onClick={() => setMinutes(option)}
                >
                  {option} min
                </button>
              ))}
            </div>
            <p className="gnd-help" data-testid="gnd-iv-time-note">
              {deepLoop
                ? 'The conversation is paced to fit; you can stop at any time.'
                : `That’s about ${questionsFor(minutes)} questions.`}
            </p>
          </fieldset>

          <fieldset className="gnd-iv-group">
            <legend className="gnd-label">
              Focus on <span className="gnd-muted">(optional)</span>
            </legend>
            {roleFocus.role && (
              <p className="gnd-help">
                Stages {roleFocus.role} interviews usually have, and skills
                their job descriptions keep asking for.
              </p>
            )}
            <div className="gnd-iv-chips">
              {options.map((label) => (
                <button
                  key={label}
                  type="button"
                  className="gnd-iv-chip"
                  aria-pressed={focus.includes(label)}
                  onClick={() => toggle(label)}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="gnd-form-field">
            <label className="gnd-label" htmlFor="gnd-iv-additionalGuidance">
              Anything else? <span className="gnd-muted">(optional)</span>
            </label>
            <textarea
              id="gnd-iv-additionalGuidance"
              className="gnd-input gnd-iv-note"
              rows={3}
              placeholder="e.g. Base questions on my latest role"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            {fieldErrors.additionalGuidance && (
              <p className="gnd-form-error">{fieldErrors.additionalGuidance}</p>
            )}
          </div>
        </fieldset>

        {notice && (
          <div
            className={
              notice.tone === 'error'
                ? 'gnd-iv-notice is-error'
                : 'gnd-iv-notice'
            }
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            <p>{notice.message}</p>
            {notice.tone === 'error' && notice.openSettings && (
              <Button
                variant="outline"
                leadingIcon={<Settings aria-hidden="true" />}
                onClick={onOpenLocalAi}
              >
                Open Local AI settings
              </Button>
            )}
          </div>
        )}

        <div className="gnd-iv-setup-actions">
          <Button
            variant="outline"
            disabled={locked || !controller.dirty}
            onClick={() => controller.saveDraft()}
          >
            {busy === 'save' ? 'Saving…' : 'Save for later'}
          </Button>
          <Button
            type="submit"
            disabled={locked}
            leadingIcon={<Play aria-hidden="true" />}
            data-testid="gnd-iv-start"
          >
            {busy === 'start' ? 'Starting…' : 'Start practice'}
          </Button>
        </div>
      </form>
    </section>
  );
}
