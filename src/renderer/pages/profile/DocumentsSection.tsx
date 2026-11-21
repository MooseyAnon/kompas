import React, { useEffect, useRef, useState } from 'react';
import type {
  ApplyImportInput,
  CvCandidate,
  CvDraft,
  CvImport,
  Document,
  Experience,
  ExperiencesCreateInput,
  Profile,
} from '../../../shared/contracts';
import {
  CAREER_STAGES,
  EXPERIENCE_CATEGORIES,
  applyImportInputSchema,
  confirmedSkillsSchema,
  experiencesCreateInputSchema,
  isExperienceDateRangeValid,
  normalizeExperienceDate,
  profilePatchSchema,
} from '../../../shared/contracts';
import {
  applyProfileImport,
  cancelCvImport,
  discardCvImport,
  getCvImport,
  importDocument,
  listCvImports,
  listDocuments,
  openDocument,
  removeDocument,
  retryCvImport,
  startCvImport,
} from '../../api';
import {
  Briefcase,
  Calendar,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  GraduationCap,
  Layers,
  Mail,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
} from 'lucide-react';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import { errorText, optional } from './editors';

const CATEGORY_LABELS: Record<Document['category'], string> = {
  cv: 'CV',
  cover_letter: 'Cover letter',
  other: 'Other',
};
function formatLabel(doc: Document) {
  if (doc.mediaType === 'application/pdf') return 'PDF';
  if (doc.mediaType.includes('wordprocessingml')) return 'DOCX';
  return doc.originalName.split('.').pop()?.toUpperCase() || 'FILE';
}
function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
}

type Choice = {
  decision: 'skip' | 'add' | 'keep' | 'replace';
  id: string;
  value: ExperiencesCreateInput;
};
const fields = [
  'displayName',
  'currentRole',
  'location',
  'currentStage',
  'summary',
] as const;
type Field = (typeof fields)[number];
function suggested(candidate: CvCandidate) {
  return candidate.status === 'detected' || candidate.status === 'needs_review'
    ? (candidate.value ?? '')
    : '';
}
function canSelect(field: Field, candidate: CvCandidate) {
  const value = suggested(candidate);
  return Boolean(
    value && profilePatchSchema.safeParse({ [field]: value }).success,
  );
}
function prepare(draft: CvDraft): Choice[] {
  return draft.experiences.map((entry) => {
    const value: ExperiencesCreateInput = {
      category: entry.category,
      roleTitle: suggested(entry.roleTitle),
      organisation: optional(suggested(entry.organisation)),
      startDate: suggested(entry.startDate) || null,
      endDate: suggested(entry.endDate) || null,
      description: suggested(entry.description),
    };
    return {
      decision:
        (entry.roleTitle.status === 'detected' ||
          entry.roleTitle.status === 'needs_review') &&
        experiencesCreateInputSchema.safeParse({
          ...value,
          startDate: null,
          endDate: null,
        }).success
          ? 'add'
          : 'skip',
      id: '',
      value,
    };
  });
}
export function DocumentsSection({
  profile,
  experiences,
  skills,
  onChanged,
  onSettings,
}: {
  profile: Profile;
  experiences: Experience[];
  skills: string[];
  onChanged: () => void;
  onSettings: () => void;
}) {
  const [docs, setDocs] = useState<Document[]>([]);
  const [imports, setImports] = useState<Omit<CvImport, 'draft'>[]>([]);
  const [selected, setSelected] = useState<CvImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [approved, setApproved] = useState<Record<Field, boolean>>({
    displayName: false,
    currentRole: false,
    location: false,
    currentStage: false,
    summary: false,
  });
  const [values, setValues] = useState<Record<Field, string>>({
    displayName: '',
    currentRole: '',
    location: '',
    currentStage: '',
    summary: '',
  });
  const [choices, setChoices] = useState<Choice[]>([]);
  const [skillDraft, setSkillDraft] = useState('');
  const [receipt, setReceipt] = useState<null | boolean>(null);
  const selectionVersion = useRef(0);
  async function refresh() {
    const [documents, drafts] = await Promise.all([
      listDocuments(),
      listCvImports(),
    ]);
    setDocs(documents);
    setImports(drafts);
  }
  useEffect(() => {
    let active = true;
    Promise.all([listDocuments(), listCvImports()])
      .then(([documents, drafts]) => {
        if (active) {
          setDocs(documents);
          setImports(drafts);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
      selectionVersion.current++;
    };
  }, []);
  useEffect(() => {
    if (selected?.status !== 'processing') return;
    const version = selectionVersion.current;
    const timer = window.setInterval(() => {
      void getCvImport(selected.id)
        .then((item) => {
          if (version !== selectionVersion.current) return;
          if (item.draft && item.status !== 'processing') inspect(item);
          else setSelected(item);
          if (item.status !== 'processing') void refresh();
        })
        .catch((e) => {
          if (version === selectionVersion.current) setError(errorText(e));
        });
    }, 800);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.status]);
  function inspect(item: CvImport) {
    selectionVersion.current++;
    setSelected(item);
    setReceipt(null);
    setError('');
    if (!item.draft) return;
    setApproved({
      displayName: canSelect('displayName', item.draft.profile.displayName),
      currentRole: canSelect('currentRole', item.draft.profile.currentRole),
      location: canSelect('location', item.draft.profile.location),
      currentStage: canSelect('currentStage', item.draft.profile.currentStage),
      summary: canSelect('summary', item.draft.profile.summary),
    });
    setValues(
      Object.fromEntries(
        fields.map((field) => [field, suggested(item.draft!.profile[field])]),
      ) as Record<Field, string>,
    );
    setChoices(
      prepare(item.draft).map((choice) => {
        if (choice.decision !== 'add') return choice;
        const match = experiences.find(
          (existing) =>
            existing.category === choice.value.category &&
            existing.roleTitle.trim().toLocaleLowerCase() ===
              choice.value.roleTitle.trim().toLocaleLowerCase() &&
            (existing.organisation ?? '').trim().toLocaleLowerCase() ===
              (choice.value.organisation ?? '').trim().toLocaleLowerCase(),
        );
        return match ? { ...choice, decision: 'keep', id: match.id } : choice;
      }),
    );
    setSkillDraft(
      item.draft.extras.skills
        .map((skill) => suggested(skill))
        .filter((name) => confirmedSkillsSchema.element.safeParse(name).success)
        .join('\n'),
    );
  }
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function updateChoice(index: number, patch: Partial<Choice>) {
    setChoices((current) =>
      current.map((choice, i) =>
        i === index ? { ...choice, ...patch } : choice,
      ),
    );
  }
  async function apply() {
    if (!selected?.draft) return;
    const reviewedExperiences: ApplyImportInput['experiences'] = [];
    for (const [index, choice] of choices.entries()) {
      if (choice.decision === 'skip') continue;
      if (choice.decision === 'keep') {
        reviewedExperiences.push({ decision: 'keep', id: choice.id });
        continue;
      }
      const startDate = choice.value.startDate?.trim()
        ? normalizeExperienceDate(choice.value.startDate)
        : null;
      const endDate = choice.value.endDate?.trim()
        ? normalizeExperienceDate(choice.value.endDate)
        : null;
      if (
        (choice.value.startDate?.trim() && !startDate) ||
        (choice.value.endDate?.trim() && !endDate)
      ) {
        setError(
          `CV entry ${index + 1}: enter a valid year, month and year, or exact date.`,
        );
        return;
      }
      if (!isExperienceDateRangeValid(startDate, endDate)) {
        setError(
          `CV entry ${index + 1}: end date must not precede start date.`,
        );
        return;
      }
      const value = { ...choice.value, startDate, endDate };
      reviewedExperiences.push(
        choice.decision === 'replace'
          ? { decision: 'replace', id: choice.id, value }
          : { decision: 'add', value },
      );
    }
    const patch: ApplyImportInput['profile'] = {};
    for (const field of fields)
      if (approved[field]) {
        if (field === 'currentStage')
          patch.currentStage = (values[field] ||
            null) as Profile['currentStage'];
        else if (field === 'displayName') patch.displayName = values[field];
        else patch[field] = optional(values[field]);
      }
    const input: ApplyImportInput = {
      importId: selected.id,
      profile: patch,
      skills: skillDraft
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean),
      experiences: reviewedExperiences,
    };
    const parsed = applyImportInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    await run(async () => {
      const result = await applyProfileImport(parsed.data);
      setReceipt(result.alreadyApplied);
      setNotice(
        result.alreadyApplied
          ? 'Already confirmed; nothing added twice.'
          : 'Profile, experience and skills confirmed and saved.',
      );
      onChanged();
    });
  }
  return (
    <section className="profile-documents">
      <div className="profile-documents-hero">
        <div className="profile-documents-import">
          <span className="profile-documents-import-icon" aria-hidden="true">
            <UploadCloud size={40} strokeWidth={2} />
          </span>
          <h2>Import CV</h2>
          <p>
            Upload your CV to add it to your documents and enrich your profile.
            PDF and DOCX originals stay stored separately.
          </p>
          <Button
            className="profile-documents-choose"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await importDocument('cv');
                if (result.cancelled) {
                  setNotice('File selection cancelled.');
                  return;
                }
                await refresh();
                inspect(await startCvImport(result.item.id));
                await refresh();
              })
            }
          >
            <Upload size={18} aria-hidden="true" />
            Choose file
          </Button>
        </div>
        <div className="profile-documents-enrich">
          <h3>
            <Sparkles size={22} aria-hidden="true" />
            Enrich your profile with your CV
          </h3>
          <p>
            Parsing uses your selected local model to propose experience, skills
            and profile details for your review. Manual editing remains
            available.
          </p>
          <ul className="profile-documents-tags" aria-label="Extracted areas">
            <li>
              <Briefcase size={16} aria-hidden="true" />
              Experience
            </li>
            <li>
              <Layers size={16} aria-hidden="true" />
              Skills
            </li>
            <li>
              <GraduationCap size={16} aria-hidden="true" />
              Education
            </li>
          </ul>
        </div>
      </div>
      <div className="profile-documents-panel">
        <header className="profile-panel-head">
          <FolderOpen size={30} aria-hidden="true" />
          <h2>Your documents</h2>
        </header>
        {!docs.length && <p>No documents stored yet.</p>}
        <ul className="profile-documents-list">
          {docs.map((doc) => {
            const found = imports.find((item) => item.documentId === doc.id);
            const format = formatLabel(doc);
            return (
              <li className="profile-document-row" key={doc.id}>
                <span
                  className={`profile-document-file is-${format.toLowerCase()}`}
                  aria-hidden="true"
                >
                  <FileText size={26} />
                </span>
                <div className="profile-document-main">
                  <h3>{doc.originalName}</h3>
                  <div className="profile-document-meta">
                    <span className="profile-document-chip">
                      {doc.category === 'cover_letter' ? (
                        <Mail size={15} aria-hidden="true" />
                      ) : doc.category === 'cv' ? (
                        <Briefcase size={15} aria-hidden="true" />
                      ) : (
                        <Folder size={15} aria-hidden="true" />
                      )}
                      {CATEGORY_LABELS[doc.category]}
                    </span>
                    <span
                      className={`profile-document-format is-${format.toLowerCase()}`}
                    >
                      {format}
                    </span>
                    <span className="profile-document-date">
                      <Calendar size={15} aria-hidden="true" />
                      Imported {formatDate(doc.createdAt)}
                    </span>
                    {doc.category === 'cv' && (
                      <span className="profile-document-status">
                        {found ? `Parse ${found.status}` : 'Not parsed'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="profile-actions profile-document-actions">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => openDocument(doc.id))}
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                    Open
                  </Button>
                  {doc.category === 'cv' && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (found) inspect(await getCvImport(found.id));
                          else {
                            inspect(await startCvImport(doc.id));
                            await refresh();
                          }
                        })
                      }
                    >
                      {found ? 'Resume review' : 'Parse CV'}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Remove ${doc.originalName}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${doc.originalName}? The original file will be deleted, but confirmed facts remain.`,
                        )
                      )
                        void run(async () => {
                          await removeDocument(doc.id);
                          await refresh();
                          setNotice('Document removed.');
                        });
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {imports
        .filter((item) => !docs.some((doc) => doc.id === item.documentId))
        .map((item) => (
          <Card key={item.id} variant="subtle">
            <p>Retained CV draft · {item.status} (original unavailable)</p>
            <Button
              variant="secondary"
              onClick={() =>
                void run(async () => inspect(await getCvImport(item.id)))
              }
            >
              Inspect draft
            </Button>
          </Card>
        ))}
      {!selected && error && <p role="alert">{error}</p>}
      {!selected && notice && <p role="status">{notice}</p>}
      {selected && (
        <Card className="profile-review">
          <h2>CV review · {selected.status}</h2>
          {selected.diagnostics.errorCode && (
            <p role="alert">
              Parsing {selected.status}: {selected.diagnostics.errorCode}. Your
              original and any earlier draft are retained. Check Local AI
              settings or edit manually.
            </p>
          )}
          {selected.status === 'processing' && (
            <p role="status">
              Interpreting CV… You may leave this page; return to resume.
            </p>
          )}
          <div className="profile-actions">
            {selected.status === 'processing' && (
              <Button
                variant="secondary"
                onClick={() =>
                  void run(async () => {
                    await cancelCvImport(selected.id);
                    inspect(await getCvImport(selected.id));
                    await refresh();
                  })
                }
              >
                Cancel parse
              </Button>
            )}
            {selected.status !== 'processing' && selected.documentId && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    inspect(await retryCvImport(selected.id));
                    await refresh();
                  })
                }
              >
                Retry parse
              </Button>
            )}
            <Button variant="ghost" onClick={onSettings}>
              Local AI settings
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Discard this CV review draft? Confirmed profile facts and the original document remain.',
                  )
                )
                  void run(async () => {
                    await discardCvImport(selected.id);
                    selectionVersion.current++;
                    setSelected(null);
                    await refresh();
                  });
              }}
            >
              Discard draft
            </Button>
          </div>
          {selected.draft && (
            <>
              <p>
                {selected.status === 'failed' || selected.status === 'cancelled'
                  ? 'Previous draft retained; review it before confirming.'
                  : 'Nothing is written to your profile until you confirm.'}{' '}
                {selected.draft.parserVersion === 'cv-v1'
                  ? 'Historical deterministic draft.'
                  : 'Local-model proposal.'}
              </p>
              {receipt !== null && (
                <p role="status">
                  Identity receipt:{' '}
                  {receipt
                    ? 'Already applied; no new entries.'
                    : 'Applied once.'}
                </p>
              )}
              <h3>Proposed profile fields</h3>
              {fields.map((field) => {
                const candidate = selected.draft!.profile[field];
                return (
                  <div className="profile-proposal" key={field}>
                    <label className="profile-check">
                      <input
                        type="checkbox"
                        checked={approved[field]}
                        onChange={(e) =>
                          setApproved({
                            ...approved,
                            [field]: e.target.checked,
                          })
                        }
                      />
                      Confirm {field} (current:{' '}
                      {String(profile[field] ?? 'not set')})
                    </label>
                    {field === 'currentStage' ? (
                      <select
                        aria-label="Proposed current stage"
                        value={values[field]}
                        onChange={(e) =>
                          setValues({ ...values, [field]: e.target.value })
                        }
                      >
                        <option value="">Not specified</option>
                        {CAREER_STAGES.map((stage) => (
                          <option key={stage} value={stage}>
                            {stage}
                          </option>
                        ))}
                      </select>
                    ) : field === 'summary' ? (
                      <textarea
                        aria-label="Proposed summary"
                        value={values.summary}
                        maxLength={10000}
                        rows={5}
                        onChange={(e) =>
                          setValues({ ...values, summary: e.target.value })
                        }
                      />
                    ) : (
                      <input
                        aria-label={`Proposed ${field}`}
                        value={values[field]}
                        maxLength={field === 'displayName' ? 120 : 200}
                        onChange={(e) =>
                          setValues({ ...values, [field]: e.target.value })
                        }
                      />
                    )}
                    {field === 'summary' &&
                    candidate.reasons.includes('model_generated_summary') ? (
                      <p>
                        Personal summary drafted from CV facts. Review and edit
                        it before confirming.
                      </p>
                    ) : null}
                    <CandidateNote candidate={candidate} />
                  </div>
                );
              })}
              {selected.draft.details?.inferences.map((inference, i) => (
                <p key={i}>
                  Separate inference (not confirmed): {inference.field}:{' '}
                  {inference.value} · {inference.reason}
                </p>
              ))}
              <h3>Proposed experience</h3>
              {choices.map((choice, index) => (
                <fieldset className="profile-proposal" key={index}>
                  <legend>CV entry {index + 1}</legend>
                  <label>
                    Decision
                    <select
                      aria-label={`CV entry ${index + 1} decision`}
                      value={
                        choice.decision === 'keep' ||
                        choice.decision === 'replace'
                          ? `${choice.decision}:${choice.id}`
                          : choice.decision
                      }
                      onChange={(e) => {
                        const [decision, id = ''] = e.target.value.split(':');
                        updateChoice(index, {
                          decision: decision as Choice['decision'],
                          id,
                        });
                      }}
                    >
                      <option value="skip">Leave out</option>
                      <option value="add">Add separately</option>
                      {experiences.map((existing) => (
                        <React.Fragment key={existing.id}>
                          <option value={`keep:${existing.id}`}>
                            Keep existing: {existing.roleTitle}
                          </option>
                          <option value={`replace:${existing.id}`}>
                            Replace existing: {existing.roleTitle}
                          </option>
                        </React.Fragment>
                      ))}
                    </select>
                  </label>
                  <CandidateNote
                    candidate={selected.draft!.experiences[index].roleTitle}
                  />
                  <label>
                    Category
                    <select
                      value={choice.value.category}
                      onChange={(e) =>
                        updateChoice(index, {
                          value: {
                            ...choice.value,
                            category: e.target.value as Experience['category'],
                          },
                        })
                      }
                    >
                      {EXPERIENCE_CATEGORIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  {(
                    [
                      'roleTitle',
                      'organisation',
                      'startDate',
                      'endDate',
                      'description',
                    ] as const
                  ).map((field) => (
                    <label key={field}>
                      {field}
                      <input
                        value={choice.value[field] ?? ''}
                        placeholder={
                          field.endsWith('Date')
                            ? 'e.g. Sept 2023, 2023-09, or 2023'
                            : ''
                        }
                        onChange={(e) =>
                          updateChoice(index, {
                            value: {
                              ...choice.value,
                              [field]:
                                field === 'description' || field === 'roleTitle'
                                  ? e.target.value
                                  : optional(e.target.value),
                            },
                          })
                        }
                      />
                      {field.endsWith('Date') && choice.value[field] && (
                        <small>
                          {normalizeExperienceDate(choice.value[field])
                            ? `Saves as ${normalizeExperienceDate(choice.value[field])}`
                            : 'Unrecognised date; correct or clear before confirming.'}
                        </small>
                      )}
                      <CandidateNote
                        candidate={selected.draft!.experiences[index][field]}
                      />
                    </label>
                  ))}
                  {selected.draft!.details && (
                    <details>
                      <summary>
                        Additional CV context (review before copying)
                      </summary>
                      <p>
                        {JSON.stringify(
                          selected.draft!.details?.[
                            choice.value.category === 'employment'
                              ? 'work'
                              : choice.value.category === 'education'
                                ? 'education'
                                : 'projects'
                          ] ?? [],
                        )}
                      </p>
                    </details>
                  )}
                </fieldset>
              ))}
              <Card variant="subtle">
                <h3>Skills from CV</h3>
                <p>
                  These skills will be added to your confirmed skills when you
                  confirm. Remove any incorrect names before saving.
                </p>
                <label>
                  Proposed skill names (one per line)
                  <textarea
                    value={skillDraft}
                    onChange={(e) => setSkillDraft(e.target.value)}
                    rows={4}
                  />
                </label>
                {!!skills.length && (
                  <p>Already confirmed: {skills.join(', ')}</p>
                )}
                <p>
                  Targets are never inferred from this CV; add them in Targets.
                </p>
                <p>
                  Contact details remain private draft-only:{' '}
                  {selected.draft.extras.email.value || 'No email'} ·{' '}
                  {selected.draft.extras.phone.value || 'No phone'}
                </p>
              </Card>
              {error && <p role="alert">{error}</p>}
              {notice && <p role="status">{notice}</p>}
              <Button
                disabled={
                  busy ||
                  selected.status === 'processing' ||
                  (selected.status !== 'ready' && selected.status !== 'partial')
                }
                onClick={() => void apply()}
              >
                Confirm selected profile, experience and skills
              </Button>
            </>
          )}
          {!selected.draft && error && <p role="alert">{error}</p>}
          {!selected.draft && notice && <p role="status">{notice}</p>}
        </Card>
      )}
    </section>
  );
}
function CandidateNote({ candidate }: { candidate: CvCandidate }) {
  return (
    <small className="profile-candidate">
      CV: {candidate.value || 'not found'} · {candidate.status}
      {candidate.evidence && (
        <details>
          <summary>Source evidence</summary>
          {candidate.evidence}
        </details>
      )}
    </small>
  );
}
