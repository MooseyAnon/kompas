import type { SqliteDatabase } from '../../core/db/connection';
import type {
  Application,
  ApplicationDocument,
  ApplicationNote,
  JobSnapshot,
  StageEvent,
  ListApplicationsInput,
} from '../../../shared/contracts';

type Row = Record<string, unknown>;

interface JobReferenceRow {
  id: string;
  jobUrl: string | null;
  snapshotUrl: string | null;
  stageKind: string | null;
}

interface CursorRow {
  updated_at: string;
  id: string;
}

const stageColumns = `id, application_id, stage_label, stage_kind, stage_subtype,
  occurred_at, recorded_at, source, source_ref, source_evidence_json, corrects_event_id`;

function stage(row: Row): StageEvent {
  return {
    id: row.id as string,
    applicationId: row.application_id as string,
    stageLabel: row.stage_label as string,
    stageKind: row.stage_kind as StageEvent['stageKind'],
    stageSubtype: row.stage_subtype as string | null,
    occurredAt: row.occurred_at as string,
    recordedAt: row.recorded_at as string,
    source: row.source as StageEvent['source'],
    sourceRef: row.source_ref as string | null,
    sourceEvidence: row.source_evidence_json
      ? JSON.parse(row.source_evidence_json as string)
      : null,
    correctsEventId: row.corrects_event_id as string | null,
  };
}

function applicationNote(row: Row): ApplicationNote {
  return {
    id: row.id as string,
    applicationId: row.application_id as string,
    stageEventId: row.stage_event_id as string | null,
    body: row.body as string,
    source: row.source as ApplicationNote['source'],
    observedAt: row.observed_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Metadata is snapshotted at link time; a null document_id means the source document was deleted. */
function applicationDocument(row: Row): ApplicationDocument {
  return {
    id: row.id as string,
    applicationId: row.application_id as string,
    documentId: row.document_id as string | null,
    purpose: row.purpose as ApplicationDocument['purpose'],
    originalName: row.original_name_snapshot as string,
    category: row.category_snapshot as ApplicationDocument['category'],
    mediaType: row.media_type_snapshot as string,
    sha256: row.sha256_snapshot as string,
    linkedAt: row.linked_at as string,
    submittedAt: row.submitted_at as string | null,
    unlinkedAt: row.unlinked_at as string | null,
    unlinkReason: row.unlink_reason as string | null,
    unavailable: row.document_id === null,
  };
}

/** Domain-owned SQL for Applications; every application query is scoped to the local profile. */
export class ApplicationsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  get(id: string): Application | null {
    const row = this.db
      .prepare(
        `SELECT * FROM job_applications WHERE id = ? AND profile_id = 'local'`,
      )
      .get(id) as Row | undefined;
    if (!row) return null;
    const current = row.current_stage_event_id
      ? this.getStage(row.current_stage_event_id as string)
      : null;
    if (!current) throw new Error('Application has no current stage');
    return this.mapApplication(row, current);
  }

  /** Local profile only, including archived applications and immutable snapshot origins. */
  jobReferences(): JobReferenceRow[] {
    return this.db
      .prepare(`SELECT a.id, a.job_url AS jobUrl,
      json_extract(a.job_snapshot_json, '$.sourceUrl') AS snapshotUrl,
      e.stage_kind AS stageKind FROM job_applications a
      LEFT JOIN application_stage_events e ON e.id=a.current_stage_event_id
      WHERE a.profile_id='local' AND (a.job_url IS NOT NULL OR a.job_snapshot_json IS NOT NULL)`)
      .all() as JobReferenceRow[];
  }

  findByDiscoveryOpportunity(opportunityId: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM job_applications
      WHERE profile_id='local' AND discovery_opportunity_id=?`)
      .get(opportunityId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private mapApplication(row: Row, currentStage: StageEvent): Application {
    return {
      id: row.id as string,
      companyName: row.company_name as string,
      roleTitle: row.role_title as string,
      location: row.location as string | null,
      jobUrl: row.job_url as string | null,
      appliedAt: row.applied_at as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      archivedAt: row.archived_at as string | null,
      currentStage,
    };
  }

  list(input: ListApplicationsInput): {
    items: Application[];
    nextCursor: string | null;
  } {
    const cursor = input.cursor ? this.findCursor(input.cursor) : undefined;
    // An unknown cursor (e.g. the row was deleted) ends pagination rather than restarting it.
    if (input.cursor && !cursor) return { items: [], nextCursor: null };
    const rows = this.db
      .prepare(`SELECT a.*, e.stage_kind AS current_kind FROM job_applications a
      JOIN application_stage_events e ON e.id = a.current_stage_event_id AND e.application_id = a.id
      WHERE a.profile_id = 'local' AND (a.archived_at IS NOT NULL) = @archived
        AND (@kind IS NULL OR e.stage_kind = @kind)
        AND (@search IS NULL OR a.company_name LIKE @search ESCAPE '\\' OR a.role_title LIKE @search ESCAPE '\\')
        AND (@cursorTime IS NULL OR a.updated_at < @cursorTime OR (a.updated_at = @cursorTime AND a.id < @cursorId))
      ORDER BY a.updated_at DESC, a.id DESC LIMIT @limit`)
      .all({
        archived: input.archived ? 1 : 0,
        kind: input.kind ?? null,
        search: input.search
          ? `%${input.search.replace(/[\\%_]/g, '\\$&')}%`
          : null,
        cursorTime: cursor?.updated_at ?? null,
        cursorId: cursor?.id ?? null,
        limit: input.limit + 1,
      }) as Row[];
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) =>
        this.mapApplication(
          row,
          this.getStage(row.current_stage_event_id as string)!,
        ),
      ),
      nextCursor:
        rows.length > input.limit ? (page[page.length - 1].id as string) : null,
    };
  }

  private findCursor(id: string): CursorRow | undefined {
    return this.db
      .prepare(
        `SELECT updated_at, id FROM job_applications WHERE id = ? AND profile_id = 'local'`,
      )
      .get(id) as CursorRow | undefined;
  }

  insertApplication(row: {
    id: string;
    companyName: string;
    roleTitle: string;
    location: string | null;
    jobUrl: string | null;
    appliedAt: string | null;
    now: string;
    discoveryOpportunityId?: string;
  }): void {
    this.db
      .prepare(`INSERT INTO job_applications (id,profile_id,company_name,role_title,location,job_url,applied_at,created_at,updated_at,discovery_opportunity_id)
      VALUES (@id,'local',@companyName,@roleTitle,@location,@jobUrl,@appliedAt,@now,@now,@discoveryOpportunityId)`)
      .run({
        ...row,
        discoveryOpportunityId: row.discoveryOpportunityId ?? null,
      });
  }

  updateApplication(
    id: string,
    data: {
      companyName: string;
      roleTitle: string;
      location: string | null;
      jobUrl: string | null;
      appliedAt: string | null;
    },
    now: string,
  ): void {
    this.db
      .prepare(`UPDATE job_applications SET company_name=@companyName,role_title=@roleTitle,
      location=@location,job_url=@jobUrl,applied_at=@appliedAt,updated_at=@now WHERE id=@id AND profile_id='local'`)
      .run({ ...data, id, now });
  }

  setArchived(id: string, at: string | null, now: string): void {
    this.db
      .prepare(
        `UPDATE job_applications SET archived_at=?, updated_at=? WHERE id=? AND profile_id='local'`,
      )
      .run(at, now, id);
  }

  snapshot(id: string): JobSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT job_snapshot_json FROM job_applications WHERE id=? AND profile_id='local'`,
      )
      .get(id) as { job_snapshot_json: string | null } | undefined;
    return row?.job_snapshot_json
      ? (JSON.parse(row.job_snapshot_json) as JobSnapshot)
      : null;
  }

  capture(id: string, snapshot: JobSnapshot): boolean {
    return (
      this.db
        .prepare(`UPDATE job_applications SET job_snapshot_json=?,job_snapshot_captured_at=?,job_snapshot_source=?,updated_at=?
      WHERE id=? AND profile_id='local' AND job_snapshot_json IS NULL`)
        .run(
          JSON.stringify(snapshot),
          snapshot.capturedAt,
          snapshot.source,
          new Date().toISOString(),
          id,
        ).changes === 1
    );
  }

  insertStage(item: StageEvent): void {
    this.db
      .prepare(`INSERT INTO application_stage_events (${stageColumns})
      VALUES (@id,@applicationId,@stageLabel,@stageKind,@stageSubtype,@occurredAt,@recordedAt,@source,@sourceRef,@sourceEvidenceJson,@correctsEventId)`)
      .run({
        ...item,
        sourceEvidenceJson: item.sourceEvidence
          ? JSON.stringify(item.sourceEvidence)
          : null,
      });
  }

  setCurrent(
    applicationId: string,
    eventId: string,
    now: string,
    appliedDate: string | null,
  ): void {
    this.db
      .prepare(`UPDATE job_applications SET current_stage_event_id=@eventId, updated_at=@now,
      applied_at=COALESCE(applied_at,@appliedDate)
      WHERE id=@applicationId AND profile_id='local'`)
      .run({ applicationId, eventId, now, appliedDate });
  }

  getStage(id: string): StageEvent | null {
    const row = this.db
      .prepare(
        `SELECT ${stageColumns} FROM application_stage_events WHERE id=?`,
      )
      .get(id) as Row | undefined;
    return row ? stage(row) : null;
  }

  sourceRefExists(
    applicationId: string,
    source: StageEvent['source'],
    ref: string,
  ): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM application_stage_events WHERE application_id=? AND source=? AND source_ref=?`,
      )
      .get(applicationId, source, ref);
  }

  stages(applicationId: string): StageEvent[] {
    return (
      this.db
        .prepare(
          `SELECT ${stageColumns} FROM application_stage_events WHERE application_id=? ORDER BY occurred_at,recorded_at,id`,
        )
        .all(applicationId) as Row[]
    ).map(stage);
  }

  notes(applicationId: string): ApplicationNote[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM application_notes WHERE application_id=? ORDER BY created_at DESC,id DESC`,
        )
        .all(applicationId) as Row[]
    ).map(applicationNote);
  }

  insertNote(note: ApplicationNote): void {
    this.db
      .prepare(`INSERT INTO application_notes (id,application_id,stage_event_id,body,source,observed_at,created_at,updated_at)
      VALUES (@id,@applicationId,@stageEventId,@body,@source,@observedAt,@createdAt,@updatedAt)`)
      .run(note);
  }

  updateNote(note: ApplicationNote): void {
    this.db
      .prepare(
        `UPDATE application_notes SET stage_event_id=@stageEventId,body=@body,source=@source,observed_at=@observedAt,updated_at=@updatedAt WHERE id=@id AND application_id=@applicationId`,
      )
      .run(note);
  }

  removeNote(applicationId: string, id: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM application_notes WHERE application_id=? AND id=?`,
        )
        .run(applicationId, id).changes === 1
    );
  }

  documents(applicationId: string): ApplicationDocument[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM application_documents WHERE application_id=? ORDER BY linked_at DESC,id DESC`,
        )
        .all(applicationId) as Row[]
    ).map(applicationDocument);
  }

  insertDocument(item: ApplicationDocument): void {
    this.db
      .prepare(`INSERT INTO application_documents (id,application_id,document_id,purpose,original_name_snapshot,category_snapshot,media_type_snapshot,sha256_snapshot,linked_at,submitted_at)
      VALUES (@id,@applicationId,@documentId,@purpose,@originalName,@category,@mediaType,@sha256,@linkedAt,@submittedAt)`)
      .run(item);
  }

  unlinkDocument(
    applicationId: string,
    id: string,
    reason: string | null,
    now: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE application_documents SET unlinked_at=?,unlink_reason=? WHERE application_id=? AND id=? AND unlinked_at IS NULL`,
        )
        .run(now, reason, applicationId, id).changes === 1
    );
  }
}
