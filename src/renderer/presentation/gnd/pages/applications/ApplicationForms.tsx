import React, { useState } from 'react';
import { Check, AlertCircle, FileText } from 'lucide-react';
import {
  createApplication,
  createApplicationNote,
  importDocument,
  linkApplicationDocument,
  previewApplicationUrl,
  recordApplicationStage,
  updateApplication,
} from '../../../../api';
import { failureNotice } from '../../../../app/Notifications';
import { Button } from '../../../components/Button';
import { Overlay } from '../../components/Overlay';
import {
  createApplicationInput,
  snapshotWithinLimit,
  type Application,
  type ApplicationDetail,
  type Document,
  type ImportPreview,
  type JobSnapshot,
  type StageKind,
} from '../../../../../shared/contracts';
import { stageName } from './applicationsView';
import './ApplicationForms.css';

// --- Shared bits -------------------------------------------------------------

export const STATUS_CHOICES: {
  kind: StageKind;
  label: string;
  hint: string;
}[] = [
  { kind: 'applied', label: 'Applied', hint: 'You’ve sent your application' },
  {
    kind: 'screening',
    label: 'Screening call',
    hint: 'A first chat with a recruiter',
  },
  {
    kind: 'interview',
    label: 'Interview',
    hint: 'Any round: video, phone or in person',
  },
  {
    kind: 'assessment',
    label: 'Task or assessment',
    hint: 'A take-home, test or presentation',
  },
  { kind: 'offer', label: 'Offer', hint: 'They’ve offered you the role' },
  {
    kind: 'rejected',
    label: 'Not successful',
    hint: 'They’ve said no this time',
  },
  {
    kind: 'withdrawn',
    label: 'I withdrew',
    hint: 'You’ve decided not to continue',
  },
];
const labelOf = (kind: StageKind) =>
  STATUS_CHOICES.find((choice) => choice.kind === kind)?.label ?? 'Update';

export const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
/** A local date (and optional time) as an ISO instant. */
export const instantOf = (date: string, time = '') =>
  new Date(`${date}T${time || '00:00'}`).toISOString();

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="gnd-form-field">
      <label className="gnd-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help && <span className="gnd-help">{help}</span>}
    </div>
  );
}

/** Round name, date and time for an interview. */
function InterviewFields({
  round,
  date,
  time,
  onChange,
}: {
  round: string;
  date: string;
  time: string;
  onChange: (next: { round?: string; date?: string; time?: string }) => void;
}) {
  return (
    <div className="gnd-form-sub">
      <Field
        id="gnd-round"
        label="Which round?"
        help="This becomes the interview’s name, e.g. Portfolio review, First round, Final"
      >
        <input
          id="gnd-round"
          className="gnd-input"
          value={round}
          maxLength={200}
          placeholder="e.g. Portfolio review"
          onChange={(e) => onChange({ round: e.target.value })}
        />
      </Field>
      <div className="gnd-form-two">
        <Field id="gnd-int-date" label="Date">
          <input
            id="gnd-int-date"
            type="date"
            className="gnd-input"
            value={date}
            onChange={(e) => onChange({ date: e.target.value })}
          />
        </Field>
        <Field id="gnd-int-time" label="Time (optional)">
          <input
            id="gnd-int-time"
            type="time"
            className="gnd-input"
            value={time}
            onChange={(e) => onChange({ time: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

// --- Update status / Fix the last update ---------------------------------------

export function StatusPanel({
  application,
  mode,
  onClose,
  onSaved,
  onFix,
}: {
  application: Application;
  mode: 'update' | 'fix';
  onClose: () => void;
  onSaved: () => void;
  onFix?: () => void;
}) {
  const current = application.currentStage;
  const choices =
    mode === 'fix'
      ? STATUS_CHOICES
      : STATUS_CHOICES.filter((choice) => choice.kind !== 'applied');
  const [kind, setKind] = useState<StageKind>(
    mode === 'fix' ? (current.stageKind ?? 'applied') : 'interview',
  );
  const [round, setRound] = useState(
    mode === 'fix' && current.stageKind === 'interview'
      ? current.stageLabel
      : '',
  );
  const [date, setDate] = useState(
    mode === 'fix' ? current.occurredAt.slice(0, 10) : today(),
  );
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!date) {
      setError('Choose a date.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const stage = await recordApplicationStage(
        {
          applicationId: application.id,
          stageKind: kind,
          stageLabel:
            kind === 'interview' ? round.trim() || 'Interview' : labelOf(kind),
          occurredAt: instantOf(date, kind === 'interview' ? time : ''),
        },
        mode === 'fix',
      );
      if (note.trim())
        await createApplicationNote({
          applicationId: application.id,
          body: note.trim(),
          source: 'self_reported',
          stageEventId: stage.id,
        });
      onSaved();
    } catch (failure) {
      setError(failureNotice(failure, 'Couldn’t save that update.').message);
      setBusy(false);
    }
  }

  return (
    <Overlay
      variant="drawer"
      title={mode === 'fix' ? 'Fix the last update' : 'What’s happened?'}
      subtitle={`${application.roleTitle} · ${application.companyName}`}
      onClose={onClose}
    >
      <form className="gnd-form" onSubmit={save}>
        {mode === 'fix' && (
          <div className="gnd-form-current">
            <span className="gnd-muted">You recorded</span>
            <strong>{stageName(current)}</strong>
          </div>
        )}
        <fieldset className="gnd-choices">
          <legend className="gnd-label">
            {mode === 'fix'
              ? 'What should it have been?'
              : 'Choose the latest step'}
          </legend>
          {choices.map((choice) => (
            <label
              key={choice.kind}
              className={`gnd-choice${kind === choice.kind ? ' is-on' : ''}`}
            >
              <input
                type="radio"
                name="gnd-stage"
                checked={kind === choice.kind}
                onChange={() => setKind(choice.kind)}
              />
              <span className="gnd-choice-radio" aria-hidden="true" />
              <span className="gnd-choice-text">
                <strong>{choice.label}</strong>
                <span className="gnd-muted">{choice.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {kind === 'interview' ? (
          <InterviewFields
            round={round}
            date={date}
            time={time}
            onChange={(next) => {
              if (next.round !== undefined) setRound(next.round);
              if (next.date !== undefined) setDate(next.date);
              if (next.time !== undefined) setTime(next.time);
            }}
          />
        ) : (
          <Field id="gnd-stage-date" label="Date">
            <input
              id="gnd-stage-date"
              type="date"
              className="gnd-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        )}
        {mode === 'update' && (
          <Field id="gnd-stage-note" label="Add a note (optional)">
            <input
              id="gnd-stage-note"
              className="gnd-input"
              value={note}
              maxLength={10000}
              placeholder="e.g. With the Head of Design, 45 minutes"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        )}
        {mode === 'fix' && (
          <p className="gnd-help">
            Your history keeps the original, marked as corrected. Only the
            latest update can be fixed.
          </p>
        )}
        {error && (
          <p className="gnd-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="gnd-actions-row">
          <Button type="submit" disabled={busy}>
            {mode === 'fix' ? 'Save fix' : 'Save update'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {mode === 'update' && onFix && (
          <p className="gnd-form-foot">
            Got the last update wrong?{' '}
            <button type="button" className="gnd-text-link" onClick={onFix}>
              Fix it instead
            </button>
          </p>
        )}
      </form>
    </Overlay>
  );
}

// --- Add an application / Edit details ---------------------------------------

type Details = {
  role: string;
  company: string;
  location: string;
  appliedAt: string;
  kind: StageKind;
  round: string;
  date: string;
  time: string;
  description: string;
};

export function ApplicationModal({
  edit,
  onClose,
  onDone,
}: {
  /** Edit these details instead of adding a new application. */
  edit?: Application;
  onClose: () => void;
  onDone: (detail?: ApplicationDetail) => void;
}) {
  const [step, setStep] = useState<'link' | 'details'>(
    edit ? 'details' : 'link',
  );
  const [url, setUrl] = useState(edit?.jobUrl ?? '');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [fields, setFields] = useState<Details>({
    role: edit?.roleTitle ?? '',
    company: edit?.companyName ?? '',
    location: edit?.location ?? '',
    appliedAt: edit?.appliedAt ?? today(),
    kind: 'applied',
    round: '',
    date: today(),
    time: '',
    description: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<Details>) =>
    setFields((current) => ({ ...current, ...patch }));

  async function read(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const link = url.trim();
    if (!/^https?:\/\/\S+$/iu.test(link)) {
      setError('Paste the full link, starting with https://');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await previewApplicationUrl(link);
      setPreview(result);
      const ok =
        result.extractionSucceeded &&
        !!(result.roleTitle || result.companyName);
      setReadFailed(!ok);
      set({
        role: result.roleTitle ?? '',
        company: result.companyName ?? '',
        location: result.location ?? '',
      });
    } catch {
      setReadFailed(true);
    } finally {
      setBusy(false);
      setStep('details');
    }
  }

  function snapshot(): JobSnapshot | undefined {
    if (preview?.snapshotAvailable && preview.snapshot) return preview.snapshot;
    const text = fields.description.trim();
    if (!text) return undefined;
    return {
      schemaVersion: 1,
      source: 'manual',
      sourceUrl: url.trim() || null,
      capturedAt: new Date().toISOString(),
      title: fields.role.trim() || null,
      company: fields.company.trim() || null,
      location: fields.location.trim() || null,
      descriptionText: text,
      contentBlocks: [],
    };
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!fields.role.trim() || !fields.company.trim()) {
      setError('Add the role and the company.');
      return;
    }
    setBusy(true);
    try {
      if (edit) {
        await updateApplication({
          id: edit.id,
          patch: {
            roleTitle: fields.role.trim(),
            companyName: fields.company.trim(),
            location: fields.location.trim() || null,
            jobUrl: url.trim() || null,
            appliedAt: fields.appliedAt || null,
          },
        });
        onDone();
        return;
      }
      const snap = snapshot();
      const data = {
        roleTitle: fields.role.trim(),
        companyName: fields.company.trim(),
        location: fields.location.trim() || null,
        jobUrl: url.trim() || null,
        appliedAt: fields.appliedAt || null,
        initialStage: {
          stageKind: fields.kind,
          stageLabel:
            fields.kind === 'interview'
              ? fields.round.trim() || 'Interview'
              : labelOf(fields.kind),
          occurredAt:
            fields.kind === 'interview'
              ? instantOf(fields.date, fields.time)
              : instantOf(fields.appliedAt || today()),
        },
        ...(snap && snapshotWithinLimit(snap) ? { snapshot: snap } : {}),
      };
      const valid = createApplicationInput.safeParse(data);
      if (!valid.success) {
        setError('Check the details: something isn’t quite right.');
        setBusy(false);
        return;
      }
      onDone(await createApplication(valid.data));
    } catch (failure) {
      setError(
        failureNotice(failure, 'Couldn’t save the application.').message,
      );
      setBusy(false);
    }
  }

  const title = edit ? 'Edit details' : 'Add an application';
  const subtitle = edit
    ? undefined
    : 'For a role you applied to outside Kompas.';

  if (step === 'link')
    return (
      <Overlay title={title} subtitle={subtitle} onClose={onClose}>
        <form className="gnd-form" onSubmit={read}>
          <Field
            id="gnd-app-url"
            label="Link to the job"
            help="We’ll read the listing and fill in the details for you."
          >
            <div className="gnd-form-inline">
              <input
                id="gnd-app-url"
                className="gnd-input"
                type="url"
                value={url}
                maxLength={2048}
                placeholder="Paste the link, e.g. https://jobs.example.com/designer"
                onChange={(e) => setUrl(e.target.value)}
                data-autofocus
              />
              <Button type="submit" disabled={busy}>
                {busy ? 'Reading…' : 'Continue'}
              </Button>
            </div>
          </Field>
          {error && (
            <p className="gnd-form-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="gnd-text-link gnd-form-start"
            onClick={() => {
              setError('');
              setStep('details');
            }}
          >
            No link? Enter the details yourself
          </button>
        </form>
      </Overlay>
    );

  return (
    <Overlay title={title} subtitle={subtitle} onClose={onClose}>
      <form className="gnd-form" onSubmit={save}>
        {preview && !readFailed && (
          <p className="gnd-form-ok">
            <Check aria-hidden="true" />
            {preview.snapshotAvailable
              ? 'We read the listing and saved a copy of the job description.'
              : 'We read the listing. Check the details below.'}
          </p>
        )}
        {readFailed && (
          <p className="gnd-form-warn">
            <AlertCircle aria-hidden="true" />
            We couldn’t read that page. It may need you to sign in. Fill in the
            details below; the link is still saved.
          </p>
        )}
        <div className="gnd-form-two">
          <Field id="gnd-app-role" label="Role">
            <input
              id="gnd-app-role"
              className="gnd-input"
              value={fields.role}
              maxLength={200}
              placeholder="e.g. Senior Product Designer"
              onChange={(e) => set({ role: e.target.value })}
            />
          </Field>
          <Field id="gnd-app-company" label="Company">
            <input
              id="gnd-app-company"
              className="gnd-input"
              value={fields.company}
              maxLength={200}
              placeholder="e.g. Plaid"
              onChange={(e) => set({ company: e.target.value })}
            />
          </Field>
        </div>
        <div className="gnd-form-two">
          <Field id="gnd-app-location" label="Location (optional)">
            <input
              id="gnd-app-location"
              className="gnd-input"
              value={fields.location}
              maxLength={200}
              placeholder="e.g. London"
              onChange={(e) => set({ location: e.target.value })}
            />
          </Field>
          <Field id="gnd-app-applied" label="Date you applied">
            <input
              id="gnd-app-applied"
              type="date"
              className="gnd-input"
              value={fields.appliedAt}
              onChange={(e) => set({ appliedAt: e.target.value })}
            />
          </Field>
        </div>
        {edit ? (
          <Field id="gnd-app-url2" label="Link to the job (optional)">
            <input
              id="gnd-app-url2"
              className="gnd-input"
              type="url"
              value={url}
              maxLength={2048}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field id="gnd-app-status" label="Where are you with it?">
              <select
                id="gnd-app-status"
                className="gnd-input gnd-select"
                value={fields.kind}
                onChange={(e) => set({ kind: e.target.value as StageKind })}
              >
                {STATUS_CHOICES.map((choice) => (
                  <option key={choice.kind} value={choice.kind}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Field>
            {fields.kind === 'interview' && (
              <InterviewFields
                round={fields.round}
                date={fields.date}
                time={fields.time}
                onChange={(next) => set(next)}
              />
            )}
            {!(preview?.snapshotAvailable && preview.snapshot) && (
              <details className="gnd-form-sub">
                <summary className="gnd-label">
                  Add the job description (optional)
                </summary>
                <textarea
                  className="gnd-input gnd-textarea"
                  aria-label="Job description"
                  value={fields.description}
                  maxLength={40000}
                  placeholder="Paste the description so you can reread it before an interview"
                  onChange={(e) => set({ description: e.target.value })}
                />
              </details>
            )}
          </>
        )}
        {error && (
          <p className="gnd-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="gnd-actions-row">
          <Button type="submit" disabled={busy}>
            {edit ? 'Save details' : 'Add application'}
          </Button>
          {edit ? (
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setError('');
                setStep('link');
              }}
            >
              Back
            </Button>
          )}
        </div>
      </form>
    </Overlay>
  );
}

// --- Add a file -----------------------------------------------------------

const FILE_KINDS = [
  { value: 'submitted_cv', label: 'CV', category: 'cv' },
  {
    value: 'submitted_cover_letter',
    label: 'Cover letter',
    category: 'cover_letter',
  },
  { value: 'supporting', label: 'Other', category: 'other' },
] as const;
type FileKind = (typeof FILE_KINDS)[number]['value'];

export function AttachFileModal({
  application,
  initialKind = 'submitted_cv',
  onClose,
  onAdded,
}: {
  application: Application;
  initialKind?: FileKind;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<FileKind>(initialKind);
  const [file, setFile] = useState<Document | null>(null);
  const [sent, setSent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose() {
    setBusy(true);
    setError('');
    try {
      const category = FILE_KINDS.find((k) => k.value === kind)!.category;
      const result = await importDocument(category);
      if (!result.cancelled) setFile(result.item);
    } catch (failure) {
      setError(failureNotice(failure, 'Couldn’t add that file.').message);
    } finally {
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    try {
      await linkApplicationDocument(
        application.id,
        file.id,
        kind,
        sent ? instantOf(sent) : undefined,
      );
      onAdded();
    } catch (failure) {
      setError(failureNotice(failure, 'Couldn’t add that file.').message);
      setBusy(false);
    }
  }

  return (
    <Overlay
      title="Add a file"
      subtitle={`${application.roleTitle} · ${application.companyName}`}
      onClose={onClose}
    >
      <form className="gnd-form" onSubmit={add}>
        <div className="gnd-file-drop">
          <span className="gnd-file-icon" aria-hidden="true">
            <FileText />
          </span>
          <span className="gnd-file-name">
            {file ? (
              <>
                <strong>{file.originalName}</strong>
                <span className="gnd-muted">
                  {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
                </span>
              </>
            ) : (
              <span className="gnd-muted">No file chosen yet</span>
            )}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void choose()}
          >
            {file ? 'Choose another' : 'Choose file'}
          </Button>
        </div>
        <Field id="gnd-file-kind" label="What is this?">
          <select
            id="gnd-file-kind"
            className="gnd-input gnd-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as FileKind)}
          >
            {FILE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="gnd-file-sent" label="When did you send it? (optional)">
          <input
            id="gnd-file-sent"
            type="date"
            className="gnd-input"
            value={sent}
            onChange={(e) => setSent(e.target.value)}
          />
        </Field>
        <p className="gnd-help">The file stays on this computer.</p>
        {error && (
          <p className="gnd-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="gnd-actions-row">
          <Button type="submit" disabled={!file || busy}>
            Add file
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Overlay>
  );
}
