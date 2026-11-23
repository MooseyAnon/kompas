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
  GUIDANCE_BADGES,
  TIME_OPTIONS,
  competencyPoints,
  composeGuidance,
  levelOf,
  questionsFor,
  tallyCompetencies,
  POINTS_PER_LEVEL,
  type BadgeId,
  type CompetencyTally,
  type Minutes,
} from './interviewView';
import './GndInterviewsPage.css';

type View =
  | { kind: 'home' }
  | { kind: 'setup' }
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
  const openLocalAi = () => onNavigate?.('settings');

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
        <h1 id="gnd-iv-title" className="gnd-page-title">
          Practise interviews
        </h1>
        <p className="gnd-muted">
          See where you’re strong, then practise to grow the rest.
        </p>
      </header>

      <PickUp
        controller={controller}
        onEdit={(id) => {
          void controller.editDraft(id);
          setView({ kind: 'setup' });
        }}
      />

      <div className="gnd-iv-home">
        <Competency
          onPractise={(name) => {
            controller.setField('subject', name);
            setView({ kind: 'setup' });
          }}
          onHistory={() => setView({ kind: 'history' })}
        />
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
                onClick={() => {
                  controller.setMethod(value);
                  setView({ kind: 'setup' });
                }}
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

/** Your competency: points and level, and how each area is going. */
function Competency({
  onPractise,
  onHistory,
}: {
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

  const points =
    load.status === 'ready' ? competencyPoints(load.data.progress) : 0;
  const { level, intoLevel } = levelOf(points);
  const empty = load.status === 'ready' && load.data.progress.sessions === 0;

  return (
    <section
      className="gnd-card gnd-iv-competency"
      aria-labelledby="gnd-iv-competency-title"
    >
      <div className="gnd-iv-competency-head">
        <h2 id="gnd-iv-competency-title" className="gnd-section-title">
          Your competency
        </h2>
        <button type="button" className="gnd-link" onClick={onHistory}>
          Past sessions
        </button>
      </div>

      <div className="gnd-iv-score">
        <span className="gnd-iv-trophy">
          <Trophy aria-hidden="true" />
        </span>
        <div className="gnd-iv-score-text">
          <p className="gnd-iv-points" data-testid="gnd-iv-points">
            {points.toLocaleString('en-GB')} points
          </p>
          <p className="gnd-muted">
            Level {level} · {POINTS_PER_LEVEL - intoLevel} to level {level + 1}
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
        <p className="gnd-muted gnd-iv-empty">
          Finish a practice to start earning points. Every session, answer and
          pass adds to your score.
        </p>
      )}
      {load.status === 'ready' && !empty && (
        <>
          <dl className="gnd-iv-stats">
            <div>
              <dt>Sessions</dt>
              <dd>{load.data.progress.sessions}</dd>
            </div>
            <div>
              <dt>Passed</dt>
              <dd>{load.data.progress.pass}</dd>
            </div>
            <div>
              <dt>Average</dt>
              <dd>
                {load.data.progress.averageScore === null
                  ? '–'
                  : `${Math.round(load.data.progress.averageScore)}%`}
              </dd>
            </div>
          </dl>
          {load.data.tallies.length > 0 && (
            <ul className="gnd-iv-areas" aria-label="Competencies">
              {load.data.tallies.slice(0, 6).map((tally) => {
                const share = tally.answered
                  ? Math.round((tally.passed / tally.answered) * 100)
                  : 0;
                return (
                  <li key={tally.name} className="gnd-iv-area">
                    <div className="gnd-iv-area-row">
                      <span className="gnd-iv-area-name">{tally.name}</span>
                      <span className="gnd-muted">{tally.points} pts</span>
                    </div>
                    <div
                      className="gnd-iv-meter gnd-iv-meter-thin"
                      aria-hidden="true"
                    >
                      <span style={{ width: `${share}%` }} />
                    </div>
                    <button
                      type="button"
                      className="gnd-link gnd-iv-area-go"
                      onClick={() => onPractise(tally.name)}
                    >
                      {share >= 70 ? 'Keep it sharp' : 'Practise this'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** The chosen method's setup: subject, target, time and guidance badges. */
function Setup({
  controller,
  onBack,
  onOpenLocalAi,
}: {
  controller: PrepareController;
  onBack: () => void;
  onOpenLocalAi: () => void;
}) {
  const { values, busy, fieldErrors, editor, targets, notice } = controller;
  const [minutes, setMinutes] = useState<Minutes>(DEFAULT_MINUTES);
  const [badges, setBadges] = useState<BadgeId[]>([]);
  const [note, setNote] = useState(values.additionalGuidance);
  const deepLoop = values.method === 'deep_loop';
  const method = METHODS.find((item) => item.value === values.method)!;
  const locked = busy !== null || editor.kind === 'loading';

  // A draft loads its saved guidance as the typed note.
  useEffect(() => {
    if (editor.kind === 'editing')
      setNote(editor.session.additionalGuidance ?? '');
  }, [editor]);

  // Time and badges are turned into the fields the backend knows about.
  useEffect(() => {
    if (!deepLoop) controller.setField('questionCount', questionsFor(minutes));
    controller.setField(
      'additionalGuidance',
      composeGuidance({ badges, minutes, deepLoop, note }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes, badges, note, deepLoop]);

  function toggle(id: BadgeId) {
    setBadges((current) =>
      current.includes(id) ? current.filter((b) => b !== id) : [...current, id],
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
      <form className="gnd-card gnd-iv-setup" noValidate onSubmit={start}>
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
            <div className="gnd-iv-chips">
              {GUIDANCE_BADGES.map((badge) => (
                <button
                  key={badge.id}
                  type="button"
                  className="gnd-iv-chip"
                  aria-pressed={badges.includes(badge.id)}
                  onClick={() => toggle(badge.id)}
                >
                  {badge.label}
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
