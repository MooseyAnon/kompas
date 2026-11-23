import React, { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  FileText,
  Pencil,
  Plus,
} from 'lucide-react';
import {
  createApplicationNote,
  getApplication,
  openDocument,
  removeApplicationNote,
  setApplicationArchived,
  unlinkApplicationDocument,
  updateApplicationNote,
} from '../../../../api';
import { failureNotice, useNotify } from '../../../../app/Notifications';
import { Button } from '../../../components/Button';
import type {
  ApplicationDetail,
  ApplicationDocument,
  ApplicationNote,
} from '../../../../../shared/contracts';
import type { Navigate } from '../../GndPage';
import {
  ApplicationModal,
  AttachFileModal,
  StatusPanel,
} from './ApplicationForms';
import {
  historyFor,
  isClosed,
  practiceFor,
  stageName,
  trackerFor,
  whenText,
} from './applicationsView';
import './ApplicationDetailPage.css';

type Panel =
  | { kind: 'status'; mode: 'update' | 'fix' }
  | { kind: 'edit' }
  | {
      kind: 'file';
      initial: 'submitted_cv' | 'submitted_cover_letter' | 'supporting';
    }
  | null;

const DOC_ROWS = [
  { purpose: 'submitted_cv', label: 'CV' },
  { purpose: 'submitted_cover_letter', label: 'Cover letter' },
  { purpose: 'supporting', label: 'Other files' },
] as const;

/** One application: where it stands, what happened, what was sent. */
export function ApplicationDetailPage({
  applicationId,
  onBack,
  onNavigate,
  onChanged,
}: {
  applicationId: string;
  onBack: () => void;
  onNavigate: Navigate;
  onChanged?: () => void;
}) {
  const notify = useNotify();
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<Panel>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getApplication(applicationId));
      setError('');
    } catch (e) {
      setError(failureNotice(e, 'Couldn’t load this application.').message);
    }
  }, [applicationId]);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => {
    setPanel(null);
    void load();
    onChanged?.();
  };

  if (!detail)
    return (
      <section className="gnd-app-detail">
        <button type="button" className="gnd-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> Your applications
        </button>
        <p className="gnd-state" role={error ? 'alert' : 'status'}>
          {error || 'Loading…'}
        </p>
      </section>
    );

  const app = detail.application;
  const current = app.currentStage;
  const tracker = trackerFor(detail.stages);
  const closed = isClosed(app);
  const atInterview = current.stageKind === 'interview';
  const upcoming =
    atInterview && Date.parse(current.occurredAt) > Date.now() - 3600_000;
  const firstSeen = detail.stages.reduce(
    (min, stage) => Math.min(min, Date.parse(stage.occurredAt)),
    Date.parse(app.createdAt),
  );

  async function archive(archived: boolean) {
    try {
      await setApplicationArchived(app.id, archived);
      onChanged?.();
      if (archived) onBack();
      else void load();
    } catch (e) {
      notify(failureNotice(e, 'Couldn’t change that.'));
    }
  }

  const practise = (method: 'quick_fire' | 'deep_loop') =>
    onNavigate('interviews', { practice: practiceFor(app, method) });

  return (
    <section className="gnd-app-detail" aria-labelledby="gnd-app-title">
      <button type="button" className="gnd-back" onClick={onBack}>
        <ArrowLeft aria-hidden="true" /> Your applications
      </button>

      <header className="gnd-app-head">
        <div className="gnd-app-head-text">
          <p className="gnd-eyebrow">
            {[app.companyName, app.location].filter(Boolean).join(' · ')}
          </p>
          <h1 id="gnd-app-title" className="gnd-page-title">
            {app.roleTitle}
          </h1>
          <p className="gnd-app-pillrow">
            <span className={`gnd-badge${closed ? ' is-grey' : ''}`}>
              {stageName(current)}
            </span>
            <span className="gnd-muted">
              Tracked since{' '}
              {new Date(firstSeen).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </p>
        </div>
        <div className="gnd-app-head-links">
          <button
            type="button"
            className="gnd-link"
            onClick={() => setPanel({ kind: 'edit' })}
          >
            <Pencil aria-hidden="true" /> Edit details
          </button>
          {app.jobUrl && (
            <a
              className="gnd-link"
              href={app.jobUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View job listing <ExternalLink aria-hidden="true" />
            </a>
          )}
        </div>
      </header>

      {upcoming && (
        <section className="gnd-app-interview" aria-label="Your interview">
          <div>
            <p className="gnd-eyebrow">{stageName(current)}</p>
            <p className="gnd-app-interview-when">
              {whenText(current.occurredAt)}
            </p>
          </div>
          <button
            type="button"
            className="gnd-app-interview-change"
            onClick={() => setPanel({ kind: 'status', mode: 'fix' })}
          >
            Change date
          </button>
        </section>
      )}
      {closed && (
        <section className="gnd-card gnd-app-closed" aria-label="Closed">
          <div>
            <p className="gnd-app-closed-title">Not this time</p>
            <p className="gnd-muted">
              Add what they told you. It shapes your next practice and stays
              with this application.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => document.getElementById('gnd-note-body')?.focus()}
          >
            <Plus aria-hidden="true" /> Add their feedback
          </Button>
        </section>
      )}

      <section className="gnd-card gnd-app-where" aria-labelledby="gnd-where">
        <div className="gnd-app-where-head">
          <h2 id="gnd-where" className="gnd-section-title">
            Where you are
          </h2>
          <span className="gnd-muted">
            Change it whenever something happens
          </span>
        </div>
        <ol className="gnd-tracker" aria-label="Application stages">
          {tracker.steps.map((step) => (
            <li
              key={step.label}
              className={`is-${step.state}${tracker.closed ? ' is-closed' : ''}`}
              aria-current={step.state === 'now' ? 'step' : undefined}
            >
              <span className="gnd-tracker-knob" aria-hidden="true">
                {step.state === 'done' && <Check />}
              </span>
              <span className="gnd-tracker-name">{step.label}</span>
              {step.date && (
                <span className="gnd-tracker-date">{step.date}</span>
              )}
            </li>
          ))}
        </ol>
        <div className="gnd-actions-row">
          {closed ? (
            <>
              <Button
                variant="outline"
                onClick={() => setPanel({ kind: 'status', mode: 'fix' })}
              >
                Correct the status
              </Button>
              {!app.archivedAt && (
                <Button variant="outline" onClick={() => void archive(true)}>
                  Archive
                </Button>
              )}
            </>
          ) : atInterview ? (
            <>
              <Button onClick={() => practise('deep_loop')}>
                Practise interview <ArrowRight aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                onClick={() => setPanel({ kind: 'status', mode: 'update' })}
              >
                Update status
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => setPanel({ kind: 'status', mode: 'update' })}
              >
                Update status
              </Button>
              <Button variant="outline" onClick={() => practise('quick_fire')}>
                Practise for this role
              </Button>
            </>
          )}
        </div>
      </section>

      <div className="gnd-app-grid">
        <div className="gnd-app-col">
          <section className="gnd-card" aria-labelledby="gnd-history">
            <h2 id="gnd-history" className="gnd-section-title">
              History
            </h2>
            <ul className="gnd-history">
              {historyFor(detail.stages).map((item) => (
                <li
                  key={item.id}
                  className={item.corrected ? 'is-corrected' : ''}
                >
                  <span className="gnd-history-pin" aria-hidden="true" />
                  <span className="gnd-history-text">
                    <strong>{item.title}</strong>
                    <span className="gnd-muted">{item.detail}</span>
                  </span>
                  <span className="gnd-muted">{item.date}</span>
                </li>
              ))}
            </ul>
          </section>
          <Notes detail={detail} onChanged={() => void load()} />
        </div>

        <aside className="gnd-app-col">
          <section className="gnd-card" aria-labelledby="gnd-sent">
            <h2 id="gnd-sent" className="gnd-section-title">
              What you sent
            </h2>
            {DOC_ROWS.map((row) => {
              const docs = detail.documents.filter(
                (doc) => doc.purpose === row.purpose && !doc.unlinkedAt,
              );
              return (
                <div key={row.purpose} className="gnd-doc-row">
                  <span
                    className={`gnd-doc-icon${docs.length ? '' : ' is-empty'}`}
                    aria-hidden="true"
                  >
                    <FileText />
                  </span>
                  <div className="gnd-doc-text">
                    <strong>{row.label}</strong>
                    {docs.length ? (
                      docs.map((doc) => (
                        <DocLine
                          key={doc.id}
                          doc={doc}
                          applicationId={app.id}
                          onChanged={() => void load()}
                        />
                      ))
                    ) : (
                      <span className="gnd-muted">Not added</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="gnd-link"
                    onClick={() =>
                      setPanel({ kind: 'file', initial: row.purpose })
                    }
                  >
                    <Plus aria-hidden="true" /> Add
                  </button>
                </div>
              );
            })}
          </section>

          <section className="gnd-card" aria-labelledby="gnd-jd">
            <h2 id="gnd-jd" className="gnd-section-title">
              Job description
            </h2>
            {detail.snapshot ? (
              <>
                <p className="gnd-muted gnd-jd-saved">
                  Saved {whenText(detail.snapshot.capturedAt)}, so you can
                  reread it even if the job is taken down.
                </p>
                <details className="gnd-jd">
                  <summary>
                    <span className="gnd-jd-text">
                      {detail.snapshot.descriptionText ||
                        detail.snapshot.contentBlocks
                          .map((block) => block.text)
                          .join('\n\n')}
                    </span>
                    <span className="gnd-link gnd-jd-more">
                      Show full description
                    </span>
                  </summary>
                </details>
              </>
            ) : (
              <p className="gnd-muted">
                No description saved. Edit the details to add the job link.
              </p>
            )}
          </section>

          {app.archivedAt ? (
            <button
              type="button"
              className="gnd-link gnd-app-archive"
              onClick={() => void archive(false)}
            >
              <Archive aria-hidden="true" /> Move back to your applications
            </button>
          ) : (
            <button
              type="button"
              className="gnd-link gnd-app-archive"
              onClick={() => void archive(true)}
            >
              <Archive aria-hidden="true" /> Archive this application
            </button>
          )}
        </aside>
      </div>

      {panel?.kind === 'status' && (
        <StatusPanel
          key={panel.mode}
          application={app}
          mode={panel.mode}
          onClose={() => setPanel(null)}
          onSaved={changed}
          onFix={() => setPanel({ kind: 'status', mode: 'fix' })}
        />
      )}
      {panel?.kind === 'edit' && (
        <ApplicationModal
          edit={app}
          onClose={() => setPanel(null)}
          onDone={changed}
        />
      )}
      {panel?.kind === 'file' && (
        <AttachFileModal
          application={app}
          initialKind={panel.initial}
          onClose={() => setPanel(null)}
          onAdded={changed}
        />
      )}
    </section>
  );
}

function DocLine({
  doc,
  applicationId,
  onChanged,
}: {
  doc: ApplicationDocument;
  applicationId: string;
  onChanged: () => void;
}) {
  const notify = useNotify();
  return (
    <span className="gnd-doc-line">
      <span className="gnd-muted">
        {doc.originalName ?? 'File'}
        {doc.submittedAt ? ` · ${whenText(doc.submittedAt)}` : ''}
      </span>
      {doc.documentId && (
        <button
          type="button"
          className="gnd-link"
          onClick={() =>
            void openDocument(doc.documentId!).catch((e) =>
              notify(failureNotice(e, 'Couldn’t open that file.')),
            )
          }
        >
          View
        </button>
      )}
      <button
        type="button"
        className="gnd-link gnd-link-quiet"
        onClick={() =>
          void unlinkApplicationDocument(applicationId, doc.id)
            .then(onChanged)
            .catch((e) =>
              notify(failureNotice(e, 'Couldn’t remove that file.')),
            )
        }
      >
        Remove
      </button>
    </span>
  );
}

function Notes({
  detail,
  onChanged,
}: {
  detail: ApplicationDetail;
  onChanged: () => void;
}) {
  const notify = useNotify();
  const [body, setBody] = useState('');
  const [source, setSource] =
    useState<ApplicationNote['source']>('self_reported');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appId = detail.application.id;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      if (editing)
        await updateApplicationNote(appId, editing, {
          body: body.trim(),
          source,
        });
      else
        await createApplicationNote({
          applicationId: appId,
          body: body.trim(),
          source,
        });
      setBody('');
      setEditing(null);
      setSource('self_reported');
      onChanged();
    } catch (e) {
      notify(failureNotice(e, 'Couldn’t save that note.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gnd-card gnd-notes" aria-labelledby="gnd-notes">
      <div className="gnd-app-where-head">
        <h2 id="gnd-notes" className="gnd-section-title">
          Notes
        </h2>
        <span className="gnd-muted">Only on this device</span>
      </div>
      <form className="gnd-notes-form" onSubmit={save}>
        <label className="gnd-label" htmlFor="gnd-note-body">
          {editing ? 'Edit note' : 'Add a note'}
        </label>
        <textarea
          id="gnd-note-body"
          className="gnd-input gnd-textarea"
          value={body}
          maxLength={10000}
          placeholder="What did they say? Who did you speak to? Anything to remember for next time."
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="gnd-notes-actions">
          <div className="gnd-seg" role="radiogroup" aria-label="Note type">
            {(
              [
                ['self_reported', 'My note'],
                ['recruiter_feedback', 'Recruiter feedback'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={source === value}
                className="gnd-seg-option"
                onClick={() => setSource(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="gnd-actions-row">
            {editing && (
              <button
                type="button"
                className="gnd-text-link"
                onClick={() => {
                  setEditing(null);
                  setBody('');
                }}
              >
                Cancel
              </button>
            )}
            <Button
              type="submit"
              variant="outline"
              disabled={!body.trim() || busy}
            >
              Save note
            </Button>
          </div>
        </div>
      </form>
      {[...detail.notes]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((note) => (
          <article key={note.id} className="gnd-note-card">
            <div className="gnd-note-card-head">
              <span className="gnd-badge is-grey">
                {note.source === 'recruiter_feedback'
                  ? 'Recruiter feedback'
                  : note.source === 'self_reported'
                    ? 'My note'
                    : 'Note'}
              </span>
              <span className="gnd-muted">{whenText(note.createdAt)}</span>
            </div>
            <p>{note.body}</p>
            <div className="gnd-note-card-actions">
              <button
                type="button"
                className="gnd-link"
                onClick={() => {
                  setEditing(note.id);
                  setBody(note.body);
                  setSource(note.source);
                  document.getElementById('gnd-note-body')?.focus();
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="gnd-link gnd-link-quiet"
                onClick={() =>
                  void removeApplicationNote(appId, note.id)
                    .then(onChanged)
                    .catch((e) =>
                      notify(failureNotice(e, 'Couldn’t delete that note.')),
                    )
                }
              >
                Delete
              </button>
            </div>
          </article>
        ))}
    </section>
  );
}
