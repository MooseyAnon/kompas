import {
  createApplicationInput,
  updateApplicationInput,
  listApplicationsInput,
  jobSnapshotSchema,
  stageEventSchema,
  snapshotWithinLimit,
  transitionInput,
  createNoteInput,
  updateNoteInput,
  linkDocumentInput,
  unlinkDocumentInput,
  type Application,
  type ApplicationDetail,
  type ApplicationDocument,
  type ApplicationNote,
  type CreateApplicationInput,
  type JobSnapshot,
  type JobSnapshotInput,
  type ListApplicationsInput,
  type StageEvent,
  type TransitionInput,
  type UpdateApplicationInput,
  type Document,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { ApplicationsRepository } from './applications.repository';
import { jobReference } from '../web/job-reference';

type StageFields = Pick<
  TransitionInput,
  'stageLabel' | 'stageKind' | 'stageSubtype' | 'occurredAt'
>;

/** Provenance for a stage event; renderer-originated events are always `user` with no ref or evidence. */
interface StageProvenance {
  source: StageEvent['source'];
  sourceRef: string | null;
  evidence: StageEvent['sourceEvidence'];
  correctsEventId: string | null;
}

const USER_PROVENANCE: StageProvenance = {
  source: 'user',
  sourceRef: null,
  evidence: null,
  correctsEventId: null,
};
const MAX_SOURCE_REF_LENGTH = 256;
const MAX_SOURCE_EVIDENCE_BYTES = 8192;

/** Only the Documents domain resolves ownership and authoritative file metadata. */
export interface ApplicationDocumentsReader {
  getMetadata(id: string): { profileId: string; document: Document } | null;
}

export class ApplicationsService {
  constructor(
    private readonly repo: ApplicationsRepository,
    private readonly documents: ApplicationDocumentsReader,
  ) {}

  /** Read-only, exact public-job identity lookup for in-process Discovery. */
  findByJobReference(url: string): { id: string; applied: boolean } | null {
    const reference = jobReference(url);
    if (!reference) return null;
    const match = this.repo
      .jobReferences()
      .find((row) =>
        [row.jobUrl, row.snapshotUrl].some(
          (candidate) => candidate && jobReference(candidate) === reference,
        ),
      );
    return match
      ? { id: match.id, applied: match.stageKind === 'applied' }
      : null;
  }

  private require(id: string): Application {
    const app = this.repo.get(id);
    if (!app) throw new AppError('NOT_FOUND', 'Application not found.');
    return app;
  }

  /** Correlation is trusted main-process authority, never an IPC create field. */
  create(
    raw: CreateApplicationInput,
    discoveryOpportunityId?: string,
  ): ApplicationDetail {
    const input = parse(createApplicationInput, raw);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const initial = input.initialStage ?? {
      stageLabel: 'Saved',
      stageKind: 'saved' as const,
    };
    return this.repo.transaction(() => {
      this.repo.insertApplication({
        id,
        companyName: input.companyName,
        roleTitle: input.roleTitle,
        location: input.location ?? null,
        jobUrl: input.jobUrl ?? null,
        appliedAt: input.appliedAt ?? null,
        now,
        discoveryOpportunityId,
      });
      this.append(
        id,
        { ...initial, occurredAt: initial.occurredAt ?? now },
        USER_PROVENANCE,
      );
      if (input.snapshot) this.capture(id, input.snapshot);
      return this.get(id);
    });
  }

  findByDiscoveryOpportunity(opportunityId: string): ApplicationDetail | null {
    const id = this.repo.findByDiscoveryOpportunity(opportunityId);
    return id ? this.get(id) : null;
  }

  update(raw: UpdateApplicationInput): Application {
    const input = parse(updateApplicationInput, raw);
    const old = this.require(input.id);
    const { patch } = input;
    // Required fields ignore null; nullable fields treat null as "clear" and undefined as "keep".
    this.repo.updateApplication(
      input.id,
      {
        companyName: patch.companyName ?? old.companyName,
        roleTitle: patch.roleTitle ?? old.roleTitle,
        location: keepIfUndefined(patch.location, old.location),
        jobUrl: keepIfUndefined(patch.jobUrl, old.jobUrl),
        appliedAt: keepIfUndefined(patch.appliedAt, old.appliedAt),
      },
      new Date().toISOString(),
    );
    return this.require(input.id);
  }

  list(raw: Partial<ListApplicationsInput> = {}): {
    items: Application[];
    nextCursor: string | null;
  } {
    return this.repo.list(parse(listApplicationsInput, raw));
  }

  get(id: string): ApplicationDetail {
    const application = this.require(id);
    return {
      application,
      snapshot: this.repo.snapshot(id),
      stages: this.repo.stages(id),
      notes: this.repo.notes(id),
      documents: this.repo.documents(id),
    };
  }

  archive(id: string, archived: boolean): Application {
    const app = this.require(id);
    if (Boolean(app.archivedAt) !== archived)
      this.repo.setArchived(
        id,
        archived ? new Date().toISOString() : null,
        new Date().toISOString(),
      );
    return this.require(id);
  }

  /** Trusted in-process capture for a future normalised WebService adapter. */
  capture(id: string, raw: JobSnapshotInput): JobSnapshot {
    this.require(id);
    const snapshot = parse(jobSnapshotSchema, raw);
    if (!snapshotWithinLimit(snapshot))
      throw new AppError(
        'INVALID_INPUT',
        'Job description exceeds the 48 KiB limit.',
      );
    // The pre-check gives a fast answer; the conditional write still guards a concurrent capture.
    if (this.repo.snapshot(id))
      throw new AppError(
        'CONFLICT',
        'This job description has already been captured.',
      );
    if (!this.repo.capture(id, snapshot))
      throw new AppError(
        'CONFLICT',
        'This job description has already been captured.',
      );
    return snapshot;
  }

  /** Trusted in-process source/ref/evidence; renderer commands never forward these. */
  record(
    raw: TransitionInput,
    source: StageEvent['source'] = 'user',
    sourceRef: string | null = null,
    evidence: StageEvent['sourceEvidence'] = null,
  ): StageEvent {
    const input = parse(transitionInput, raw);
    this.require(input.applicationId);
    return this.repo.transaction(() =>
      this.append(input.applicationId, input, {
        source,
        sourceRef,
        evidence,
        correctsEventId: null,
      }),
    );
  }

  /** Appends a user correction of the current stage; rejects if the stage changed since it was read. */
  correct(raw: TransitionInput): StageEvent {
    const input = parse(transitionInput, raw);
    const current = this.require(input.applicationId).currentStage;
    return this.repo.transaction(() => {
      if (this.require(input.applicationId).currentStage.id !== current.id)
        throw new AppError(
          'CONFLICT',
          'The current stage changed. Refresh and try again.',
        );
      return this.append(input.applicationId, input, {
        ...USER_PROVENANCE,
        correctsEventId: current.id,
      });
    });
  }

  /** Inserts a stage event and makes it current; callers own the surrounding transaction. */
  private append(
    applicationId: string,
    input: StageFields,
    { source, sourceRef, evidence, correctsEventId }: StageProvenance,
  ): StageEvent {
    if (
      sourceRef !== null &&
      (sourceRef.trim().length < 1 || sourceRef.length > MAX_SOURCE_REF_LENGTH)
    )
      throw new AppError(
        'INVALID_INPUT',
        'Source reference must be 1–256 characters.',
      );
    if (
      evidence &&
      utf8ByteLength(JSON.stringify(evidence)) > MAX_SOURCE_EVIDENCE_BYTES
    )
      throw new AppError('INVALID_INPUT', 'Source evidence is too large.');
    if (
      sourceRef &&
      this.repo.sourceRefExists(applicationId, source, sourceRef)
    )
      throw new AppError('CONFLICT', 'This source event was already recorded.');
    const now = new Date().toISOString();
    const item = parse(stageEventSchema, {
      id: crypto.randomUUID(),
      applicationId,
      stageLabel: input.stageLabel,
      stageKind: input.stageKind ?? null,
      stageSubtype: input.stageSubtype ?? null,
      occurredAt: input.occurredAt ?? now,
      recordedAt: now,
      source,
      sourceRef,
      sourceEvidence: evidence,
      correctsEventId,
    });
    this.repo.insertStage(item);
    // The first `applied` stage backfills applied_at (date only); the repo never overwrites it.
    this.repo.setCurrent(
      applicationId,
      item.id,
      now,
      item.stageKind === 'applied' ? item.occurredAt.slice(0, 10) : null,
    );
    return item;
  }

  private checkStage(
    applicationId: string,
    stageId: string | null | undefined,
  ): void {
    if (stageId && this.repo.getStage(stageId)?.applicationId !== applicationId)
      throw new AppError(
        'INVALID_INPUT',
        'Choose a stage from this application.',
      );
  }

  createNote(
    raw: Parameters<typeof createNoteInput.parse>[0],
  ): ApplicationNote {
    const input = parse(createNoteInput, raw);
    this.require(input.applicationId);
    this.checkStage(input.applicationId, input.stageEventId);
    const now = new Date().toISOString();
    const note: ApplicationNote = {
      id: crypto.randomUUID(),
      applicationId: input.applicationId,
      body: input.body,
      source: input.source,
      stageEventId: input.stageEventId ?? null,
      observedAt: input.observedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertNote(note);
    return note;
  }

  updateNote(
    raw: Parameters<typeof updateNoteInput.parse>[0],
  ): ApplicationNote {
    const input = parse(updateNoteInput, raw);
    this.require(input.applicationId);
    const old = this.repo
      .notes(input.applicationId)
      .find((item) => item.id === input.id);
    if (!old) throw new AppError('NOT_FOUND', 'Note not found.');
    this.checkStage(input.applicationId, input.patch.stageEventId);
    const note: ApplicationNote = {
      ...old,
      ...input.patch,
      updatedAt: new Date().toISOString(),
    };
    this.repo.updateNote(note);
    return note;
  }

  removeNote(applicationId: string, id: string): void {
    this.require(applicationId);
    if (!this.repo.removeNote(applicationId, id))
      throw new AppError('NOT_FOUND', 'Note not found.');
  }

  /** Links a local-profile document, snapshotting its metadata so the link survives document deletion. */
  link(
    raw: Parameters<typeof linkDocumentInput.parse>[0],
  ): ApplicationDocument {
    const input = parse(linkDocumentInput, raw);
    this.require(input.applicationId);
    const metadata = this.documents.getMetadata(input.documentId);
    if (!metadata || metadata.profileId !== 'local')
      throw new AppError('NOT_FOUND', 'Document not found for this profile.');
    const document = metadata.document;
    const item: ApplicationDocument = {
      id: crypto.randomUUID(),
      applicationId: input.applicationId,
      documentId: document.id,
      originalName: document.originalName,
      category: document.category,
      mediaType: document.mediaType,
      sha256: document.sha256,
      purpose: input.purpose,
      linkedAt: new Date().toISOString(),
      submittedAt: input.submittedAt ?? null,
      unlinkedAt: null,
      unlinkReason: null,
      unavailable: false,
    };
    this.repo.insertDocument(item);
    return item;
  }

  unlink(raw: Parameters<typeof unlinkDocumentInput.parse>[0]): void {
    const input = parse(unlinkDocumentInput, raw);
    this.require(input.applicationId);
    if (
      !this.repo.unlinkDocument(
        input.applicationId,
        input.id,
        input.reason ?? null,
        new Date().toISOString(),
      )
    )
      throw new AppError('NOT_FOUND', 'Active document link not found.');
  }
}

function keepIfUndefined<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Validates trusted or untrusted input, hiding schema details behind one user-facing message. */
function parse<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new AppError(
      'INVALID_INPUT',
      'Please check the application fields and try again.',
    );
  return result.data;
}
