import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  ExternalLink,
  FileText,
  FolderOpen,
  Info,
  MapPin,
  StickyNote,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import {
  JOB_SNAPSHOT_MAX_BYTES,
  jobSnapshotSchema,
  snapshotWithinLimit,
  stageKindSchema,
  transitionInput,
  updateApplicationInput,
  createNoteInput,
  updateNoteInput,
  linkDocumentInput,
  type ApplicationDetail,
  type ApplicationNote,
  type StageKind,
} from '../../../../shared/contracts/applications';
import type { Document } from '../../../../shared/contracts/documents';
import {
  ApiError,
  captureApplicationSnapshot,
  createApplicationNote,
  getApplication,
  importDocument,
  linkApplicationDocument,
  listDocuments,
  openDocument,
  recordApplicationStage,
  removeApplicationNote,
  setApplicationArchived,
  unlinkApplicationDocument,
  updateApplication,
  updateApplicationNote,
} from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { selectableStageKind, selectableStageKinds, stageLane } from './stages';

const dateTime = (value: string) => new Date(value).toLocaleString();

function SectionTitle({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  return (
    <h3 className="ats-section-title">
      <span className="ats-section-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      {title}
    </h3>
  );
}
const failureMessage = (error: unknown) =>
  error instanceof ApiError
    ? `${error.code}: ${error.message}`
    : 'The action failed. Refresh and try again.';

export function ApplicationDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const back = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  const locked = useRef(false);

  const refresh = useCallback(
    async (keepError = false) => {
      try {
        const item = await getApplication(id);
        if (active.current) {
          setDetail(item);
          if (!keepError) setError('');
        }
      } catch (failure) {
        if (active.current) setError(failureMessage(failure));
      } finally {
        if (active.current) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    active.current = true;
    back.current?.focus();
    void refresh();
    return () => {
      active.current = false;
    };
  }, [refresh]);

  async function mutate(action: () => Promise<unknown>) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      return true;
    } catch (failure) {
      if (active.current) {
        setError(failureMessage(failure));
        if (failure instanceof ApiError && failure.code === 'CONFLICT')
          void refresh(true);
      }
      return false;
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function loadDocuments() {
    try {
      setDocuments(await listDocuments());
    } catch (failure) {
      setError(failureMessage(failure));
    }
  }

  return (
    <div className="ats-detail" data-testid="application-detail">
      <Button
        ref={back}
        variant="ghost"
        className="ats-back"
        leadingIcon={<ArrowLeft size={16} />}
        onClick={onBack}
      >
        Back to Applications
      </Button>
      {loading && <p role="status">Loading application…</p>}
      {error && (
        <p role="alert" className="jobs-error">
          {error}{' '}
          <Button variant="secondary" onClick={() => void refresh()}>
            Refresh details
          </Button>
        </p>
      )}
      {!loading && !detail && <p>Application details are unavailable.</p>}
      {detail && (
        <>
          <header className="ats-detail-heading">
            <span className="ats-detail-logo" aria-hidden="true">
              <Building2 size={34} strokeWidth={1.6} />
            </span>
            <div className="ats-detail-identity">
              <h2>{detail.application.roleTitle}</h2>
              <p className="ats-detail-company">
                {detail.application.companyName}
              </p>
              <div className="ats-detail-facts">
                {detail.application.location && (
                  <p>
                    <MapPin size={16} aria-hidden="true" />
                    {detail.application.location}
                  </p>
                )}
                {detail.application.jobUrl && (
                  <p>
                    <a
                      href={detail.application.jobUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Job URL
                    </a>
                    <ExternalLink size={14} aria-hidden="true" />
                  </p>
                )}
              </div>
              <p className="jobs-meta">
                Added {dateTime(detail.application.createdAt)}
                {detail.application.appliedAt &&
                  ` · Applied ${detail.application.appliedAt}`}
                {detail.application.archivedAt &&
                  ` · Archived ${dateTime(detail.application.archivedAt)}`}
              </p>
            </div>
            <div className="ats-detail-stage">
              <span className="ats-detail-stage-label">Current stage</span>
              <p
                className={`ats-detail-stage-pill ats-stage-${stageLane(detail.application.currentStage.stageKind).toLowerCase()}`}
              >
                {stageLane(detail.application.currentStage.stageKind)} ·{' '}
                {detail.application.currentStage.stageLabel}
              </p>
            </div>
            <div className="ats-detail-updated">
              <CalendarDays size={20} aria-hidden="true" />
              <span>
                Last updated
                <strong>
                  {new Date(detail.application.updatedAt).toLocaleDateString()}
                </strong>
              </span>
            </div>
            <div className="ats-detail-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    detail.application.archivedAt ||
                    window.confirm(
                      'Archive this application? Its history will remain available.',
                    )
                  )
                    void mutate(() =>
                      setApplicationArchived(
                        id,
                        !detail.application.archivedAt,
                      ),
                    );
                }}
              >
                {detail.application.archivedAt
                  ? 'Restore application'
                  : 'Archive application'}
              </Button>
            </div>
          </header>
          <div className="ats-detail-layout">
            <StageTimeline
              key={detail.application.currentStage.id}
              detail={detail}
              busy={busy}
              mutate={mutate}
            />
            <div className="ats-detail-grid">
              <SnapshotCard detail={detail} busy={busy} mutate={mutate} />
              <DocumentsCard
                detail={detail}
                available={documents}
                busy={busy}
                mutate={mutate}
                load={loadDocuments}
              />
              <NotesCard detail={detail} busy={busy} mutate={mutate} />
              <MetadataCard
                key={detail.application.updatedAt}
                detail={detail}
                busy={busy}
                mutate={mutate}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type SectionProps = {
  detail: ApplicationDetail;
  busy: boolean;
  mutate: (action: () => Promise<unknown>) => Promise<boolean>;
};

function StageTimeline({ detail, busy, mutate }: SectionProps) {
  const current = detail.application.currentStage;
  const [correction, setCorrection] = useState(false);
  const [kind, setKind] = useState<StageKind>(
    selectableStageKind(current.stageKind),
  );
  const [label, setLabel] = useState(correction ? current.stageLabel : '');
  const [subtype, setSubtype] = useState('');
  const [occurred, setOccurred] = useState('');
  const [validation, setValidation] = useState('');
  const corrected = new Set(
    detail.stages.map((event) => event.correctsEventId).filter(Boolean),
  );
  function toggle() {
    setCorrection(!correction);
    setKind(selectableStageKind(current.stageKind));
    setLabel(!correction ? current.stageLabel : '');
    setSubtype(!correction ? (current.stageSubtype ?? '') : '');
    setOccurred(!correction ? current.occurredAt.slice(0, 16) : '');
    setValidation('');
  }
  return (
    <Card className="ats-timeline">
      <SectionTitle icon={Waypoints} title="Stage timeline" />
      <p>
        Events are recorded in history. Recording another interview stage keeps
        the Interviewing category.
      </p>
      <ol>
        {detail.stages.map((event) => (
          <li
            key={event.id}
            aria-current={event.id === current.id ? 'step' : undefined}
          >
            <strong>{event.stageLabel}</strong> · {stageLane(event.stageKind)}
            {event.stageKind && ` (${event.stageKind})`}
            {event.stageSubtype && ` · ${event.stageSubtype}`}
            {event.id === current.id && (
              <span className="jobs-badge">Current</span>
            )}
            {corrected.has(event.id) && (
              <span className="jobs-meta"> · Replaced by correction</span>
            )}
            {event.correctsEventId && (
              <span className="jobs-meta"> · Corrects an earlier event</span>
            )}
            <div className="jobs-meta">
              Occurred {dateTime(event.occurredAt)} · Recorded{' '}
              {dateTime(event.recordedAt)} · Source: {event.source}
            </div>
          </li>
        ))}
      </ol>
      <h4>{correction ? 'Correct current event' : 'Add stage event'}</h4>
      <p className="jobs-meta">
        {correction
          ? 'Correction appends an event replacing only the current entry.'
          : 'An event is a record, not an interview booking or automatic application submission.'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = {
            applicationId: detail.application.id,
            stageKind: kind,
            stageLabel: label,
            stageSubtype: subtype.trim() || null,
            ...(occurred
              ? { occurredAt: new Date(occurred).toISOString() }
              : {}),
          };
          const parsed = transitionInput.safeParse(input);
          if (!parsed.success) {
            setValidation(
              parsed.error.issues.map((issue) => issue.message).join('; '),
            );
            return;
          }
          setValidation('');
          void mutate(() =>
            recordApplicationStage(parsed.data, correction),
          ).then((ok) => {
            if (ok) {
              setLabel('');
              setSubtype('');
              setOccurred('');
              setCorrection(false);
            }
          });
        }}
      >
        <div className="ats-fields">
          <label className="jobs-field">
            Category
            <select
              value={kind}
              onChange={(event) =>
                setKind(stageKindSchema.parse(event.target.value))
              }
            >
              {selectableStageKinds.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="jobs-field">
            Specific stage label *
            <input
              required
              maxLength={200}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Technical Round 2"
            />
          </label>
          <label className="jobs-field">
            Subtype (optional)
            <input
              maxLength={120}
              value={subtype}
              onChange={(event) => setSubtype(event.target.value)}
            />
          </label>
          <label className="jobs-field">
            Occurred at (optional)
            <input
              type="datetime-local"
              value={occurred}
              onChange={(event) => setOccurred(event.target.value)}
            />
          </label>
        </div>
        {validation && (
          <p role="alert" className="jobs-error">
            {validation}
          </p>
        )}
        <div className="jobs-actions">
          <Button type="submit" disabled={busy}>
            {correction ? 'Save correction' : 'Record stage event'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={toggle}>
            {correction ? 'Cancel correction' : 'Correct current event'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function MetadataCard({ detail, busy, mutate }: SectionProps) {
  const app = detail.application;
  const [company, setCompany] = useState(app.companyName);
  const [role, setRole] = useState(app.roleTitle);
  const [location, setLocation] = useState(app.location ?? '');
  const [url, setUrl] = useState(app.jobUrl ?? '');
  const [applied, setApplied] = useState(app.appliedAt ?? '');
  const [validation, setValidation] = useState('');
  return (
    <Card>
      <SectionTitle icon={Info} title="Application details" />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = updateApplicationInput.safeParse({
            id: app.id,
            patch: {
              companyName: company,
              roleTitle: role,
              location: location || null,
              jobUrl: url || null,
              appliedAt: applied || null,
            },
          });
          if (!parsed.success) {
            setValidation(
              parsed.error.issues.map((issue) => issue.message).join('; '),
            );
            return;
          }
          setValidation('');
          void mutate(() => updateApplication(parsed.data));
        }}
      >
        <div className="ats-fields">
          <label className="jobs-field">
            Company *
            <input
              required
              maxLength={200}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </label>
          <label className="jobs-field">
            Role *
            <input
              required
              maxLength={200}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </label>
          <label className="jobs-field">
            Location
            <input
              maxLength={200}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
          <label className="jobs-field">
            Job URL
            <input
              type="url"
              maxLength={2048}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="jobs-field">
            Applied date (if known)
            <input
              type="date"
              value={applied}
              onChange={(e) => setApplied(e.target.value)}
            />
          </label>
        </div>
        {validation && (
          <p role="alert" className="jobs-error">
            {validation}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          Save details
        </Button>
      </form>
    </Card>
  );
}

function SnapshotCard({ detail, busy, mutate }: SectionProps) {
  const [text, setText] = useState('');
  const [validation, setValidation] = useState('');
  const snapshot = detail.snapshot;
  return (
    <Card>
      <SectionTitle icon={FileText} title="Original job description" />
      {snapshot ? (
        <>
          <p className="jobs-meta">
            Immutable {snapshot.source} snapshot · Captured{' '}
            {dateTime(snapshot.capturedAt)} ·{' '}
            {new TextEncoder().encode(JSON.stringify(snapshot)).length} bytes
          </p>
          {snapshot.sourceUrl && (
            <p>
              Source URL:{' '}
              <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">
                {snapshot.sourceUrl}
              </a>
            </p>
          )}
          {[snapshot.title, snapshot.company, snapshot.location].some(
            Boolean,
          ) && (
            <p>
              {[snapshot.title, snapshot.company, snapshot.location]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <details>
            <summary>Read full saved JD</summary>
            <div className="ats-jd-content">
              {snapshot.descriptionText && <p>{snapshot.descriptionText}</p>}
              {snapshot.contentBlocks.map((block, index) => (
                <div key={index}>
                  <strong>{block.type}</strong>
                  <p>{block.text}</p>
                </div>
              ))}
            </div>
          </details>
        </>
      ) : (
        <>
          <p>
            No JD snapshot saved. The job URL does not replace an offline copy.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = jobSnapshotSchema.safeParse({
                schemaVersion: 1,
                source: 'manual',
                sourceUrl: detail.application.jobUrl,
                capturedAt: new Date().toISOString(),
                title: detail.application.roleTitle,
                company: detail.application.companyName,
                location: detail.application.location,
                descriptionText: text,
                contentBlocks: [],
              });
              if (!parsed.success || !snapshotWithinLimit(parsed.data)) {
                setValidation(
                  `Enter a complete description within ${JOB_SNAPSHOT_MAX_BYTES / 1024} KiB.`,
                );
                return;
              }
              setValidation('');
              void mutate(() =>
                captureApplicationSnapshot(detail.application.id, parsed.data),
              );
            }}
          >
            <label className="jobs-field">
              Manually capture original JD (one time only, 48 KiB JSON limit)
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
              />
            </label>
            {validation && (
              <p role="alert" className="jobs-error">
                {validation}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              Capture JD once
            </Button>
          </form>
        </>
      )}
    </Card>
  );
}

function DocumentsCard({
  detail,
  available,
  busy,
  mutate,
  load,
}: SectionProps & { available: Document[]; load: () => Promise<void> }) {
  const [documentId, setDocumentId] = useState('');
  const [purpose, setPurpose] = useState<
    'submitted_cv' | 'submitted_cover_letter' | 'supporting'
  >('submitted_cv');
  const [submitted, setSubmitted] = useState('');
  const [validation, setValidation] = useState('');
  useEffect(() => {
    void load();
  }, []); // Load only on entering the detail workspace.
  const existing = new Set(available.map((document) => document.id));
  return (
    <Card>
      <SectionTitle icon={FolderOpen} title="Documents" />
      <p>
        Links refer to independent managed documents. A link alone does not mean
        submitted.
      </p>
      <ul className="ats-record-list">
        {detail.documents.map((link) => (
          <li key={link.id}>
            <strong>{link.originalName}</strong> · {link.category} ·{' '}
            {link.purpose}
            <p className="jobs-meta">
              Linked {dateTime(link.linkedAt)}
              {link.submittedAt
                ? ` · Submitted ${dateTime(link.submittedAt)}`
                : ' · Not marked submitted'}
              {link.unlinkedAt && ` · Unlinked ${dateTime(link.unlinkedAt)}`}
              {link.unlinkReason && ` · Reason: ${link.unlinkReason}`}
            </p>
            {link.unavailable && (
              <p className="jobs-meta">
                Original removed; copied metadata retained.
              </p>
            )}
            <div className="jobs-actions">
              <Button
                variant="secondary"
                disabled={
                  busy || !link.documentId || !existing.has(link.documentId)
                }
                onClick={() => {
                  if (link.documentId)
                    void mutate(() => openDocument(link.documentId!));
                }}
              >
                Open original
              </Button>
              {!link.unlinkedAt && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Unlink this document? Its copied metadata remains in history.',
                      )
                    )
                      void mutate(() =>
                        unlinkApplicationDocument(
                          detail.application.id,
                          link.id,
                          'Removed by user',
                        ),
                      );
                  }}
                >
                  Unlink
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = linkDocumentInput.safeParse({
            applicationId: detail.application.id,
            documentId,
            purpose,
            ...(submitted
              ? { submittedAt: new Date(submitted).toISOString() }
              : {}),
          });
          if (!parsed.success) {
            setValidation('Select a document and check its submission time.');
            return;
          }
          setValidation('');
          void mutate(() =>
            linkApplicationDocument(
              detail.application.id,
              documentId,
              purpose,
              parsed.data.submittedAt ?? undefined,
            ),
          ).then((ok) => {
            if (ok) {
              setDocumentId('');
              setSubmitted('');
            }
          });
        }}
      >
        <div className="ats-fields">
          <label className="jobs-field">
            Managed document
            <select
              value={documentId}
              onFocus={() => void load()}
              onChange={(e) => setDocumentId(e.target.value)}
            >
              <option value="">Select document</option>
              {available.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.originalName} · {doc.category}
                </option>
              ))}
            </select>
          </label>
          <label className="jobs-field">
            Purpose
            <select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as typeof purpose)}
            >
              <option value="submitted_cv">CV</option>
              <option value="submitted_cover_letter">Cover letter</option>
              <option value="supporting">Supporting</option>
            </select>
          </label>
          <label className="jobs-field">
            Submitted at (only if actually sent)
            <input
              type="datetime-local"
              value={submitted}
              onChange={(e) => setSubmitted(e.target.value)}
            />
          </label>
        </div>
        {validation && (
          <p role="alert" className="jobs-error">
            {validation}
          </p>
        )}
        <div className="jobs-actions">
          <Button type="submit" disabled={busy || !documentId}>
            Link document
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void mutate(async () => {
                const result = await importDocument(
                  purpose === 'submitted_cv'
                    ? 'cv'
                    : purpose === 'submitted_cover_letter'
                      ? 'cover_letter'
                      : 'other',
                );
                if (!result.cancelled) {
                  await load();
                  setDocumentId(result.item.id);
                }
              })
            }
          >
            Import document…
          </Button>
          <Button variant="ghost" onClick={() => void load()}>
            Refresh documents
          </Button>
        </div>
      </form>
    </Card>
  );
}

function NotesCard({ detail, busy, mutate }: SectionProps) {
  const [editing, setEditing] = useState<ApplicationNote | null>(null);
  const [body, setBody] = useState('');
  const [source, setSource] =
    useState<ApplicationNote['source']>('self_reported');
  const [validation, setValidation] = useState('');
  return (
    <Card>
      <SectionTitle icon={StickyNote} title="Notes" />
      <ul className="ats-record-list">
        {detail.notes.map((note) => (
          <li key={note.id}>
            <p className="ats-note-body">{note.body}</p>
            <p className="jobs-meta">
              {note.source} · Created {dateTime(note.createdAt)} · Updated{' '}
              {dateTime(note.updatedAt)}
              {note.observedAt && ` · Observed ${dateTime(note.observedAt)}`}
              {note.stageEventId &&
                ` · Linked stage: ${detail.stages.find((event) => event.id === note.stageEventId)?.stageLabel ?? 'Unknown'}`}
            </p>
            <div className="jobs-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(note);
                  setBody(note.body);
                  setSource(note.source);
                }}
              >
                Edit note
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Remove this note permanently?'))
                    void mutate(() =>
                      removeApplicationNote(detail.application.id, note.id),
                    );
                }}
              >
                Remove note
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = { applicationId: detail.application.id, body, source };
          const parsed = editing
            ? updateNoteInput.safeParse({
                applicationId: detail.application.id,
                id: editing.id,
                patch: { body, source },
              })
            : createNoteInput.safeParse(data);
          if (!parsed.success) {
            setValidation('Enter a note of at most 10,000 characters.');
            return;
          }
          setValidation('');
          void mutate(() =>
            editing
              ? updateApplicationNote(detail.application.id, editing.id, {
                  body,
                  source,
                })
              : createApplicationNote(data),
          ).then((ok) => {
            if (ok) {
              setEditing(null);
              setBody('');
            }
          });
        }}
      >
        <label className="jobs-field">
          {editing ? 'Edit note' : 'New note'}
          <textarea
            rows={4}
            maxLength={10000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <label className="jobs-field">
          Source
          <select
            value={source}
            onChange={(e) =>
              setSource(e.target.value as ApplicationNote['source'])
            }
          >
            <option value="self_reported">Self reported</option>
            <option value="recruiter_feedback">Recruiter feedback</option>
            <option value="other">Other</option>
          </select>
        </label>
        {validation && (
          <p role="alert" className="jobs-error">
            {validation}
          </p>
        )}
        <div className="jobs-actions">
          <Button type="submit" disabled={busy}>
            {editing ? 'Save note' : 'Add note'}
          </Button>
          {editing && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setBody('');
              }}
            >
              Cancel edit
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
