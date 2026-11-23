import React, { type FormEvent } from 'react';
import {
  Ban,
  Pencil,
  Play,
  Repeat,
  Save,
  Settings,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  ADDITIONAL_GUIDANCE_MAX,
  type InterviewMethod,
  type InterviewSession,
  type InterviewSessionSummary,
  type Target,
} from '../../../../shared/contracts';
import { Button } from '../../../presentation/components/Button';
import {
  MethodChoice,
  type MethodChoiceOption,
} from '../../../presentation/components/interviews/MethodChoice';
import {
  RecentSessionsCard,
  type RecentSessionItem,
} from '../../../presentation/components/interviews/RecentSessionsCard';
import {
  guidanceLength,
  quickFireCounts,
  type PrepareField,
} from './prepareForm';
import {
  usePrepareController,
  type OpenSession,
  type PrepareController,
} from './usePrepareController';
import './PrepareTab.css';
import type { PracticePreset } from './preset';

const methodOptions: readonly MethodChoiceOption<InterviewMethod>[] = [
  {
    value: 'quick_fire',
    label: 'Quick-fire',
    description: 'A focused set of questions, answered one after another.',
    detail: '5–10 questions · feedback when you finish',
    icon: Zap,
  },
  {
    value: 'deep_loop',
    label: 'Deep Loop',
    description:
      'A conversation with follow-ups and a review after each answer, plus coaching if you ask.',
    detail: 'No fixed number of questions',
    icon: Repeat,
  },
];

const methodLabels: Record<InterviewMethod, string> = {
  quick_fire: 'Quick-fire',
  deep_loop: 'Deep Loop',
};

const fieldIds: Record<PrepareField, string> = {
  subject: 'prepare-subject',
  careerTargetId: 'prepare-target',
  questionCount: 'prepare-count',
  additionalGuidance: 'prepare-guidance',
};

const updatedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function targetLabel(target: Target) {
  const details = [target.targetLevel, target.sector].filter(Boolean);
  const name = details.length
    ? `${target.roleTitle} · ${details.join(' · ')}`
    : target.roleTitle;
  return target.active ? name : `${name} (inactive)`;
}

export function PrepareTab({
  onOpenSession,
  onOpenLocalAi,
  preset,
}: {
  onOpenSession: OpenSession;
  onOpenLocalAi: () => void;
  preset?: PracticePreset;
}) {
  const controller = usePrepareController(onOpenSession, preset);
  const { values, editor, busy, fieldErrors } = controller;

  const editing = editor.kind === 'editing' ? editor.session : null;
  const formLocked = busy !== null || editor.kind === 'loading';
  const isQuickFire = values.method === 'quick_fire';

  function focusField(field: PrepareField | null) {
    if (field) document.getElementById(fieldIds[field])?.focus();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    focusField(controller.startPractice());
  }

  function describedBy(field: PrepareField, help?: string) {
    return [help, fieldErrors[field] ? `${fieldIds[field]}-error` : null]
      .filter(Boolean)
      .join(' ');
  }

  return (
    <div className="prepare" data-testid="interviews-prepare">
      <div className="prepare-layout">
        <form
          className="prepare-form"
          aria-labelledby="prepare-title"
          aria-busy={formLocked}
          noValidate
          onSubmit={onSubmit}
        >
          <div className="prepare-heading">
            <h2 id="prepare-title">
              {editor.kind === 'new' ? 'Set up a practice' : 'Edit draft'}
            </h2>
            {editor.kind !== 'new' && (
              <Button
                variant="ghost"
                leadingIcon={<X aria-hidden="true" />}
                disabled={busy !== null}
                onClick={controller.cancelEdit}
                data-testid="prepare-cancel-edit"
              >
                New practice instead
              </Button>
            )}
          </div>

          {editor.kind === 'loading' && (
            <p className="prepare-quiet" role="status">
              Loading draft…
            </p>
          )}

          <fieldset className="prepare-fieldset" disabled={formLocked}>
            <MethodChoice
              name="prepare-method"
              legend="Practice method"
              options={methodOptions}
              value={values.method}
              onChange={controller.setMethod}
              disabled={editor.kind !== 'new'}
              note={
                editor.kind === 'new'
                  ? undefined
                  : 'A saved draft keeps its method. Start a new practice to switch.'
              }
            />

            <div className={`prepare-fields${isQuickFire ? ' has-count' : ''}`}>
              <div className="prepare-field prepare-field-subject">
                <label htmlFor={fieldIds.subject}>Subject</label>
                <input
                  id={fieldIds.subject}
                  type="text"
                  autoComplete="off"
                  required
                  placeholder="e.g. System design, product sense, art history"
                  value={values.subject}
                  aria-invalid={fieldErrors.subject ? true : undefined}
                  aria-describedby={describedBy('subject') || undefined}
                  onChange={(event) =>
                    controller.setField('subject', event.target.value)
                  }
                />
                <FieldError
                  id={fieldIds.subject}
                  message={fieldErrors.subject}
                />
              </div>

              <TargetField
                controller={controller}
                editing={editing}
                describedBy={describedBy(
                  'careerTargetId',
                  'prepare-target-help',
                )}
              />

              {isQuickFire && (
                <div className="prepare-field prepare-field-count">
                  <label htmlFor={fieldIds.questionCount}>Questions</label>
                  <select
                    id={fieldIds.questionCount}
                    value={values.questionCount}
                    aria-invalid={fieldErrors.questionCount ? true : undefined}
                    aria-describedby={describedBy('questionCount') || undefined}
                    onChange={(event) =>
                      controller.setField(
                        'questionCount',
                        Number(event.target.value),
                      )
                    }
                  >
                    {quickFireCounts.map((count) => (
                      <option key={count} value={count}>
                        {count} questions
                      </option>
                    ))}
                  </select>
                  <FieldError
                    id={fieldIds.questionCount}
                    message={fieldErrors.questionCount}
                  />
                </div>
              )}
            </div>

            <GuidanceField
              value={values.additionalGuidance}
              error={fieldErrors.additionalGuidance}
              describedBy={describedBy(
                'additionalGuidance',
                'prepare-guidance-help prepare-guidance-count',
              )}
              onChange={(text) =>
                controller.setField('additionalGuidance', text)
              }
            />
          </fieldset>

          <PrepareNotice
            controller={controller}
            onOpenLocalAi={onOpenLocalAi}
          />

          <div className="prepare-actions">
            <Button
              type="submit"
              disabled={formLocked}
              leadingIcon={<Play aria-hidden="true" />}
              data-testid="prepare-start"
            >
              {busy === 'start' ? 'Starting…' : 'Start practice'}
            </Button>
            <Button
              variant="secondary"
              disabled={formLocked || !controller.dirty}
              leadingIcon={<Save aria-hidden="true" />}
              onClick={() => focusField(controller.saveDraft())}
              data-testid="prepare-save"
            >
              {busy === 'save'
                ? 'Saving…'
                : editing
                  ? 'Save changes'
                  : 'Save draft'}
            </Button>
            <span className="prepare-actions-note">
              Starting asks your local model to prepare the first question.
            </span>
          </div>
        </form>

        <RecentSessionsCard
          title="Drafts & unfinished sessions"
          status={controller.recent.status}
          items={
            controller.recent.status === 'ready'
              ? controller.recent.data.map((item) =>
                  recentItem(item, controller, editing),
                )
              : []
          }
          errorMessage={
            controller.recent.status === 'error'
              ? controller.recent.message
              : undefined
          }
          alert={controller.rowError ?? undefined}
          emptyText="Saved drafts and interviews you haven’t finished will appear here."
          onRetry={() => void controller.retryRecent()}
        />
      </div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} className="prepare-field-error">
      {message}
    </p>
  );
}

function TargetField({
  controller,
  editing,
  describedBy,
}: {
  controller: PrepareController;
  editing: InterviewSession | null;
  describedBy: string;
}) {
  const { targets, values, fieldErrors } = controller;
  const items = targets.status === 'ready' ? targets.data : [];
  // A draft may point at a target that is no longer listed; keep it selectable.
  const missingLinked =
    editing?.careerTargetId &&
    targets.status !== 'loading' &&
    !items.some((target) => target.id === editing.careerTargetId)
      ? { id: editing.careerTargetId, role: editing.targetSnapshot?.role }
      : null;

  return (
    <div className="prepare-field prepare-field-target">
      <label htmlFor={fieldIds.careerTargetId}>Career target</label>
      <select
        id={fieldIds.careerTargetId}
        value={values.careerTargetId}
        disabled={targets.status === 'loading'}
        aria-invalid={fieldErrors.careerTargetId ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) =>
          controller.setField('careerTargetId', event.target.value)
        }
      >
        <option value="">
          {targets.status === 'loading' ? 'Loading targets…' : 'No target'}
        </option>
        {missingLinked && (
          <option value={missingLinked.id}>
            {missingLinked.role ?? 'Saved target'} (saved with draft)
          </option>
        )}
        {items.map((target) => (
          <option key={target.id} value={target.id}>
            {targetLabel(target)}
          </option>
        ))}
      </select>
      <p id="prepare-target-help" className="prepare-help">
        {targets.status === 'error'
          ? 'Your career targets couldn’t be loaded; you can still practise without one.'
          : targets.status === 'ready' && items.length === 0
            ? 'Optional. Add a career target in your profile to frame questions around it.'
            : 'Optional. Frames questions around your approved target.'}
      </p>
      <FieldError
        id={fieldIds.careerTargetId}
        message={fieldErrors.careerTargetId}
      />
    </div>
  );
}

function GuidanceField({
  value,
  error,
  describedBy,
  onChange,
}: {
  value: string;
  error?: string;
  describedBy: string;
  onChange: (text: string) => void;
}) {
  const length = guidanceLength(value);
  const over = length > ADDITIONAL_GUIDANCE_MAX;

  return (
    <div className="prepare-field prepare-field-guidance">
      <div className="prepare-guidance-label">
        <label htmlFor={fieldIds.additionalGuidance}>
          Additional guidance <span>(optional)</span>
        </label>
        <span
          id="prepare-guidance-count"
          className={`prepare-count${over ? ' is-over' : ''}`}
          data-testid="prepare-guidance-count"
        >
          {length.toLocaleString()} / {ADDITIONAL_GUIDANCE_MAX.toLocaleString()}
        </span>
      </div>
      <textarea
        id={fieldIds.additionalGuidance}
        rows={3}
        value={value}
        placeholder="e.g. Ask STAR questions based on my latest approved role"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id="prepare-guidance-help" className="prepare-help">
        Shapes the questions only, not how answers are assessed. Try “Ask STAR
        questions based on my latest approved role” or “Focus on Apple interview
        topics”. Naming a company doesn’t look anything up online: questions
        come from your local model’s general knowledge and your approved
        profile.
      </p>
      <FieldError id={fieldIds.additionalGuidance} message={error} />
    </div>
  );
}

function PrepareNotice({
  controller,
  onOpenLocalAi,
}: {
  controller: PrepareController;
  onOpenLocalAi: () => void;
}) {
  const { notice, busy } = controller;
  if (!notice) return null;

  if (notice.tone === 'success')
    return (
      <p
        className="prepare-notice is-success"
        role="status"
        data-testid="prepare-notice"
      >
        {notice.message}
      </p>
    );

  return (
    <div
      className="prepare-notice is-error"
      role="alert"
      data-testid="prepare-notice"
      data-stage={notice.stage}
    >
      <p>
        <strong>
          {notice.stage === 'draft'
            ? 'Your setup wasn’t saved.'
            : 'The interview didn’t start.'}
        </strong>{' '}
        {notice.message}
      </p>
      {(notice.openSettings || notice.canClearPreview) && (
        <div className="prepare-notice-actions">
          {notice.openSettings && (
            <Button
              variant="secondary"
              leadingIcon={<Settings aria-hidden="true" />}
              onClick={onOpenLocalAi}
              data-testid="prepare-open-settings"
            >
              Open Local AI settings
            </Button>
          )}
          {notice.canClearPreview && (
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={controller.clearPreview}
              data-testid="prepare-clear-preview"
            >
              {busy === 'clear-preview' ? 'Clearing…' : 'Clear preview'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function recentItem(
  item: InterviewSessionSummary,
  controller: PrepareController,
  editing: InterviewSession | null,
): RecentSessionItem {
  const isDraft = item.status === 'draft';
  const locked = controller.busy !== null;
  const resuming =
    controller.rowBusy?.sessionId === item.id &&
    controller.rowBusy.action === 'resume';
  const confirming =
    controller.confirming?.sessionId === item.id
      ? controller.confirming.action
      : null;

  const meta = [
    item.targetRole,
    item.questionCount ? `${item.questionCount} questions` : null,
    `Updated ${updatedFormat.format(new Date(item.updatedAt))}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    id: item.id,
    title: item.subject,
    meta,
    statusLabel: isDraft ? 'Draft' : 'In progress',
    statusTone: isDraft ? 'draft' : 'active',
    methodIcon: item.method === 'quick_fire' ? Zap : Repeat,
    methodLabel: methodLabels[item.method],
    current: editing?.id === item.id,
    actions: isDraft
      ? [
          {
            id: 'edit',
            label: 'Edit',
            icon: Pencil,
            variant: 'secondary',
            disabled: locked || editing?.id === item.id,
            accessibleLabel: `Edit draft: ${item.subject}`,
            onClick: () => void controller.editDraft(item.id),
          },
          {
            id: 'delete',
            label: 'Delete',
            icon: Trash2,
            disabled: locked,
            accessibleLabel: `Delete draft: ${item.subject}`,
            onClick: () => controller.requestConfirm(item.id, 'delete'),
          },
        ]
      : [
          {
            id: 'resume',
            label: resuming ? 'Opening…' : 'Resume',
            icon: Play,
            variant: 'primary',
            disabled: locked,
            accessibleLabel: `Resume interview: ${item.subject}`,
            onClick: () => controller.resumeSession(item.id),
          },
          {
            id: 'abandon',
            label: 'Abandon',
            icon: Ban,
            disabled: locked,
            accessibleLabel: `Abandon interview: ${item.subject}`,
            onClick: () => controller.requestConfirm(item.id, 'abandon'),
          },
        ],
    confirmation: confirming
      ? {
          message:
            confirming === 'delete'
              ? 'Delete this draft? This can’t be undone.'
              : 'Abandon this interview? It ends now and can’t be resumed.',
          confirmLabel: confirming === 'delete' ? 'Delete draft' : 'Abandon',
          busy: locked,
          onConfirm: controller.confirmRow,
          onCancel: controller.cancelConfirm,
        }
      : null,
  };
}
