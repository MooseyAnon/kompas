import type { SqliteDatabase } from '../../core/db/connection';
import {
  discoveryRunSchema,
  discoveryRunSummarySchema,
  type DiscoveryRun,
  type DiscoveryRunPage,
  type DiscoveryRunStats,
  type JobDiscoveryConfigurationV1,
  discoveryCandidateSchema,
  type DiscoveryCandidate,
  discoveryCaptureSchema,
  type DiscoveryCapture,
  type PageReadResult,
  jdExtractionSchema,
  type JdExtraction,
  discoveryMatchSchema,
  type DiscoveryMatch,
  type DiscoveryReview,
  type ResolutionDiagnostics,
  resolutionDiagnosticsOutput,
  type WebErrorCode,
} from '../../../shared/contracts';
import type { CandidateObservation } from './collection';
import { jobReference } from '../web/job-reference';

type ApplicationMatch = { id: string; applied: boolean } | null;

const MAX_CAPTURE_BYTES = 2_097_152;

interface RunRow {
  id: string;
  saved_search_id: string | null;
  status: string;
  config_snapshot_json: string;
  query_plan_json: string;
  stats_json: string;
  diagnostics_json: string;
  started_at: string;
  finished_at: string | null;
}

interface CaptureRow {
  id: string;
  source_url: string;
  raw_readpage_json: string;
  captured_at: string;
}

interface AttemptRow {
  id: string;
  run_id: string;
  source_id: string;
  provider: string;
  discovered_url: string;
  sequence: number;
  status: string;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

interface SearchRow {
  id: string;
  ordinal: number;
  query: string;
  status: string;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
}

interface ResultRow {
  ordinal: number;
  url: string;
  disposition: string;
  reason: string | null;
  capture_id: string | null;
}

interface EligibilityRow {
  review_decision: string;
  application_id: string | null;
  canonical_url: string | null;
  canonical_verified_at: string | null;
  resolution_attempts: number;
  capture_id: string | null;
}

/** Where an observation landed: its source row and owning opportunity. */
interface ObservedIdentity {
  sourceId: string;
  opportunityId: string;
  /** A brand-new opportunity not tied to an application may skip eligibility. */
  freshAdmissible: boolean;
}

type WorkflowEvidence = {
  sourceId: string;
  observedAt: string;
  outcome: string;
  errorCode: string | null;
  verifiedAt: string | null;
  extractionId: string | null;
  extractionStatus: string | null;
  extractionError: string | null;
  extractionDiagnostics: string[];
  extractionAt: string | null;
  extractionAttempts: number;
  match: DiscoveryMatch | null;
};

function comparable(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function possibleLocation(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;

  const clean = (location: string) =>
    comparable(location).replace(/^(?:hybrid work|remote|on site) in /, '');
  const left = clean(a);
  const right = clean(b);

  return (
    left === right ||
    left.startsWith(`${right} `) ||
    right.startsWith(`${left} `)
  );
}

/** Total attempts allowed by the run snapshot: the first try plus retries. */
function maxAttempts(run: DiscoveryRun): number {
  return 1 + run.configSnapshot.run.maxTransientRetries;
}

function budgetExhausted(run: DiscoveryRun): boolean {
  const { stats } = run;
  const limits = run.configSnapshot.run;
  return (
    stats.inspectedCandidates >= limits.maxInspectedCandidates ||
    stats.newCandidates >= limits.maxNewCandidates
  );
}

function initialReviewDecision(application: ApplicationMatch): string {
  if (!application) return 'new';
  return application.applied ? 'applied' : 'saved';
}

function summary(row: RunRow) {
  return discoveryRunSummarySchema.parse({
    id: row.id,
    savedSearchId: row.saved_search_id,
    status: row.status,
    stats: JSON.parse(row.stats_json),
    diagnostics: JSON.parse(row.diagnostics_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function detail(row: RunRow): DiscoveryRun {
  return discoveryRunSchema.parse({
    ...summary(row),
    configSnapshot: JSON.parse(row.config_snapshot_json),
    queryPlan: JSON.parse(row.query_plan_json),
  });
}

function candidateFromRow(
  row: Record<string, string | null>,
  run: DiscoveryRun,
): DiscoveryCandidate {
  const listingMeta = JSON.parse(row.listing_meta_json!) as {
    postingAge: string | null;
  };
  const retryAvailable =
    row.canonical_url === null &&
    run.status !== 'running' &&
    Number(row.resolution_attempts) < maxAttempts(run);

  return discoveryCandidateSchema.parse({
    id: row.id,
    sourceId: row.source_id,
    provider: row.provider,
    sourceKey: row.source_key,
    discoveredUrl: row.discovered_url,
    collectionUrl: row.collection_url,
    title: row.title,
    company: row.company,
    location: row.location,
    postingAge: listingMeta.postingAge ?? null,
    canonicalUrl: row.canonical_url,
    resolutionStatus: row.resolution_status,
    resolutionReason: row.resolution_reason,
    resolutionAttempts: row.resolution_attempts,
    retryAvailable,
  });
}

function captureFromRow(row: CaptureRow): DiscoveryCapture {
  return discoveryCaptureSchema.parse({
    id: row.id,
    sourceUrl: row.source_url,
    rawReadPage: JSON.parse(row.raw_readpage_json),
    capturedAt: row.captured_at,
  });
}

function extractionFromRow(row: Record<string, string | null>): JdExtraction {
  return jdExtractionSchema.parse({
    id: row.id,
    captureId: row.capture_id,
    status: row.status,
    errorCode: row.error_code,
    jd: row.extracted_jd_json ? JSON.parse(row.extracted_jd_json) : null,
    diagnostics: JSON.parse(row.diagnostics_json!),
    provenance: row.inference_meta_json
      ? JSON.parse(row.inference_meta_json)
      : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function resultFromRow(result: ResultRow) {
  return {
    ordinal: result.ordinal,
    url: result.url,
    disposition: result.disposition,
    reason: result.reason,
    captureId: result.capture_id,
  };
}

function workflowEvidenceFromRow(
  row: Record<string, string | number | null>,
): WorkflowEvidence {
  return {
    sourceId: row.source_id as string,
    observedAt: row.observed_at as string,
    outcome: row.outcome as string,
    errorCode: row.error_code as string | null,
    verifiedAt: row.canonical_verified_at as string | null,
    extractionId: row.extraction_id as string | null,
    extractionStatus: row.extraction_status as string | null,
    extractionError: row.extraction_error as string | null,
    extractionDiagnostics: row.extraction_diagnostics
      ? JSON.parse(row.extraction_diagnostics as string)
      : [],
    extractionAt: row.extraction_at as string | null,
    extractionAttempts: row.extraction_attempts as number,
    match: row.match_json
      ? discoveryMatchSchema.parse(JSON.parse(row.match_json as string))
      : null,
  };
}

export class DiscoveryRunsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  hasRunning(): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM job_discovery_runs
      WHERE profile_id = 'local' AND status = 'running'`)
      .get();
  }

  insert(
    id: string,
    searchId: string,
    config: JobDiscoveryConfigurationV1,
    plan: string[],
    stats: DiscoveryRunStats,
    now: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO job_discovery_runs\n' +
          '      (id, profile_id, saved_search_id, status, config_snapshot_json,' +
          ' query_plan_json, stats_json, started_at)\n' +
          "      VALUES (?, 'local', ?, 'running', ?, ?, ?, ?)",
      )
      .run(
        id,
        searchId,
        JSON.stringify(config),
        JSON.stringify(plan),
        JSON.stringify(stats),
        now,
      );
  }

  get(id: string): DiscoveryRun | null {
    const row = this.db
      .prepare(`SELECT * FROM job_discovery_runs
      WHERE id = ? AND profile_id = 'local'`)
      .get(id) as RunRow | undefined;
    return row ? detail(row) : null;
  }

  list(limit: number, cursor?: string): DiscoveryRunPage {
    const previous = cursor ? this.get(cursor) : null;
    if (cursor && !previous) return { items: [], nextCursor: null };

    const rows = this.db
      .prepare(
        'SELECT * FROM job_discovery_runs\n' +
          "      WHERE profile_id = 'local' AND (? IS NULL OR started_at < ?" +
          ' OR (started_at = ? AND id < ?))\n' +
          '      ORDER BY started_at DESC, id DESC LIMIT ?',
      )
      .all(
        previous?.startedAt ?? null,
        previous?.startedAt ?? null,
        previous?.startedAt ?? null,
        cursor ?? null,
        limit + 1,
      ) as RunRow[];
    const items = rows.slice(0, limit).map(summary);

    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  cancel(id: string, at: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE job_discovery_runs\n' +
          "      SET status='cancelled', finished_at=?,\n" +
          "          diagnostics_json=json_insert(diagnostics_json, '$[#]'," +
          " json_object('code','CANCELLED_BY_USER','at',?))\n" +
          "      WHERE id=? AND profile_id='local' AND status='running'",
      )
      .run(at, at, id);
    return result.changes === 1;
  }

  /**
   * Atomic progress + identity observation; repeat observations still consume
   * inspection budget.
   */
  observe(
    runId: string,
    observation: CandidateObservation,
    at: string,
    applicationLookup: () => ApplicationMatch = () => null,
  ): DiscoveryCandidate | null {
    return this.transaction(() => {
      const run = this.get(runId);
      if (!run || run.status !== 'running') return null;
      if (budgetExhausted(run)) return null;

      const { stats } = run;
      stats.inspectedCandidates++;

      const identity = this.observeIdentity(
        runId,
        observation,
        at,
        applicationLookup,
      );
      const admitted = this.isAdmissible(runId, identity, run);
      this.insertRunItem(runId, identity.sourceId, admitted, at);

      if (admitted) {
        stats.newCandidates++;
        this.updateProgress(runId, stats);
        return this.admitted(runId, identity.sourceId);
      }

      this.updateProgress(runId, stats);
      return null;
    });
  }

  updateProgress(id: string, stats: DiscoveryRunStats): void {
    this.db
      .prepare(
        'UPDATE job_discovery_runs SET stats_json=? WHERE id=?' +
          " AND profile_id='local' AND status='running'",
      )
      .run(JSON.stringify(stats), id);
  }

  appendDiagnostic(
    id: string,
    code: DiscoveryRun['diagnostics'][number]['code'],
    at: string,
  ): void {
    this.db
      .prepare(
        'UPDATE job_discovery_runs\n' +
          "      SET diagnostics_json=json_insert(diagnostics_json, '$[#]'," +
          " json_object('code',?, 'at',?))\n" +
          "      WHERE id=? AND profile_id='local' AND status='running'",
      )
      .run(code, at, id);
  }

  finish(
    id: string,
    status: 'completed' | 'partial' | 'failed',
    at: string,
  ): void {
    this.db
      .prepare(`UPDATE job_discovery_runs SET status=?, finished_at=?
      WHERE id=? AND profile_id='local' AND status='running'`)
      .run(status, at, id);
  }

  /** Fence claimed attempts synchronously when a workflow is cancelled. */
  cancelWorkflowAttempts(id: string, at: string): void {
    this.transaction(() => {
      this.interruptResolutionHistory(id, 'cancelled', at);

      this.db
        .prepare(
          "UPDATE job_jd_extractions SET status='failed', error_code='CANCELLED'," +
            ' finished_at=?\n' +
            "        WHERE run_id=? AND status='running'",
        )
        .run(at, id);

      this.db
        .prepare(
          "UPDATE job_opportunities SET resolution_status='extraction_failed'," +
            ' updated_at=?\n' +
            '        WHERE id IN (SELECT opportunity_id FROM job_jd_extractions\n' +
            "          WHERE run_id=? AND status='failed' AND error_code='CANCELLED'" +
            ' AND finished_at=?)',
        )
        .run(at, id, at);

      this.db
        .prepare(
          "UPDATE job_opportunities SET resolution_reason='cancelled', updated_at=?\n" +
            "        WHERE canonical_url IS NULL AND resolution_status='unresolved'\n" +
            '        AND id IN (SELECT s.opportunity_id' +
            ' FROM job_discovery_run_items i\n' +
            '          JOIN job_opportunity_sources s ON s.id=i.source_id\n' +
            '          WHERE i.run_id=? AND i.admitted=1' +
            " AND i.error_code='RESOLUTION_IN_PROGRESS')",
        )
        .run(at, id);

      this.db
        .prepare(
          'UPDATE job_discovery_run_items SET outcome=' +
            "'cancelled',error_code='CANCELLED',updated_at=?\n" +
            "        WHERE run_id=? AND error_code='RESOLUTION_IN_PROGRESS'",
        )
        .run(at, id);
    });
  }

  candidates(id: string): DiscoveryCandidate[] {
    const run = this.get(id);
    if (!run) return [];

    const rows = this.db
      .prepare(
        'SELECT o.id, s.id AS source_id, s.provider, s.source_key,\n' +
          '       s.discovered_url, s.collection_url, o.title, o.company,' +
          ' o.location, s.listing_meta_json,\n' +
          '       o.canonical_url, o.resolution_status, o.resolution_reason,' +
          ' o.resolution_attempts\n' +
          '      FROM job_discovery_run_items i' +
          ' JOIN job_opportunity_sources s ON s.id=i.source_id\n' +
          '      JOIN job_opportunities o ON' +
          " o.id=s.opportunity_id AND o.profile_id='local'\n" +
          "      WHERE i.run_id=? AND i.admitted=1 AND s.profile_id='local'\n" +
          '      ORDER BY i.observed_at, i.id LIMIT 10',
      )
      .all(id) as Array<Record<string, string | null>>;
    return rows.map((row) => candidateFromRow(row, run));
  }

  admitted(runId: string, sourceId: string): DiscoveryCandidate | null {
    return (
      this.candidates(runId).find((item) => item.sourceId === sourceId) ?? null
    );
  }

  /**
   * Resolve an opportunity to one admitted source without trusting a renderer
   * run ID.
   */
  handoffSource(
    opportunityId: string,
  ): { id: string; sourceId: string } | null {
    const row = this.db
      .prepare(
        'SELECT i.run_id AS id,i.source_id AS sourceId\n' +
          '      FROM job_discovery_run_items i\n' +
          '      JOIN job_opportunity_sources s ON' +
          " s.id=i.source_id AND s.profile_id='local'\n" +
          '      JOIN job_opportunities o ON' +
          " o.id=s.opportunity_id AND o.profile_id='local'\n" +
          "      JOIN job_discovery_runs r ON r.id=i.run_id AND r.profile_id='local'\n" +
          '      WHERE o.id=? AND i.admitted=1' +
          ' ORDER BY i.observed_at DESC,i.id DESC LIMIT 1',
      )
      .get(opportunityId) as { id: string; sourceId: string } | undefined;
    return row ?? null;
  }

  review(
    runId: string,
    sourceId: string,
  ): Pick<DiscoveryReview, 'decision' | 'applicationId'> | null {
    const candidate = this.admitted(runId, sourceId);
    if (!candidate) return null;

    const row = this.db
      .prepare(`SELECT review_decision, application_id FROM job_opportunities
      WHERE id=? AND profile_id='local'`)
      .get(candidate.id) as
      | {
          review_decision: DiscoveryReview['decision'];
          application_id: string | null;
        }
      | undefined;
    return row
      ? { decision: row.review_decision, applicationId: row.application_id }
      : null;
  }

  decide(
    runId: string,
    sourceId: string,
    decision: 'new' | 'saved' | 'dismissed',
    at: string,
  ): void {
    const candidate = this.admitted(runId, sourceId);
    if (!candidate) return;

    this.db
      .prepare(`UPDATE job_opportunities SET review_decision=?, updated_at=?
      WHERE id=? AND profile_id='local' AND application_id IS NULL`)
      .run(decision, at, candidate.id);
  }

  linkApplication(
    runId: string,
    sourceId: string,
    applicationId: string,
    at: string,
  ): void {
    const candidate = this.admitted(runId, sourceId);
    if (!candidate) return;

    this.db
      .prepare(
        'UPDATE job_opportunities SET application_id=?,' +
          " review_decision='saved', updated_at=?\n" +
          "      WHERE id=? AND profile_id='local'" +
          ' AND (application_id IS NULL OR application_id=?)',
      )
      .run(applicationId, at, candidate.id, applicationId);
  }

  /**
   * Claim an attempt before any Web operation; retries survive crashes and
   * cannot exceed the snapshot.
   */
  claimResolution(runId: string, sourceId: string): DiscoveryCandidate | null {
    return this.transaction(() => {
      const candidate = this.admitted(runId, sourceId);
      const run = this.get(runId);
      const canClaim =
        candidate &&
        run &&
        !candidate.canonicalUrl &&
        candidate.resolutionAttempts < maxAttempts(run);
      if (!canClaim) return null;

      this.db
        .prepare(
          'UPDATE job_opportunities SET resolution_attempts=resolution_attempts+1,\n' +
            "        resolution_status='unresolved', resolution_reason=NULL" +
            " WHERE id=? AND profile_id='local'",
        )
        .run(candidate.id);

      this.db
        .prepare(
          'UPDATE job_discovery_run_items SET' +
            " error_code='RESOLUTION_IN_PROGRESS', updated_at=?\n" +
            '        WHERE run_id=? AND source_id=? AND admitted=1',
        )
        .run(new Date().toISOString(), runId, sourceId);

      const item = this.db
        .prepare(`SELECT id FROM job_discovery_run_items
        WHERE run_id=? AND source_id=? AND admitted=1`)
        .get(runId, sourceId) as { id: string };

      this.db
        .prepare(
          'INSERT INTO job_resolution_attempts\n' +
            '        (id,run_item_id,sequence,status,started_at)' +
            " VALUES (?,?,?,'running',?)",
        )
        .run(
          crypto.randomUUID(),
          item.id,
          candidate.resolutionAttempts + 1,
          new Date().toISOString(),
        );

      return this.admitted(runId, sourceId);
    });
  }

  resolutionProgress(
    runId: string,
    field: 'targetedSearches' | 'targetedPagesRead',
  ): void {
    const run = this.get(runId);
    if (!run) return;

    const stats = { ...run.stats, [field]: run.stats[field] + 1 };
    this.writeStats(runId, stats);
  }

  /** The opportunity a run's candidate source belongs to. */
  opportunityOfSource(sourceId: string): string | null {
    const row = this.db
      .prepare('SELECT opportunity_id FROM job_opportunity_sources WHERE id=?')
      .get(sourceId) as { opportunity_id: string } | undefined;
    return row?.opportunity_id ?? null;
  }

  beginResolutionSearch(
    runId: string,
    sourceId: string,
    ordinal: number,
    query: string,
    at: string,
  ): string {
    const attempt = this.activeResolution(runId, sourceId);
    if (!attempt) throw new Error('No active resolution attempt.');

    const id = crypto.randomUUID();
    this.db
      .prepare(
        'INSERT INTO job_resolution_searches\n' +
          '      (id,attempt_id,ordinal,query,status,started_at)' +
          " VALUES (?,?,?,?,'running',?)",
      )
      .run(id, attempt.id, ordinal, query, at);
    return id;
  }

  finishResolutionSearch(
    id: string,
    status: 'completed' | 'failed' | 'cancelled',
    code: WebErrorCode | 'WEB_FAILED' | null,
    at: string,
  ): void {
    this.db
      .prepare(
        'UPDATE job_resolution_searches SET status=?,error_code=?,finished_at=?\n' +
          "      WHERE id=? AND status='running'",
      )
      .run(status, code, at, id);
  }

  addResolutionResults(searchId: string, urls: string[]): string[] {
    return urls.map((url, index) => {
      const id = crypto.randomUUID();
      this.db
        .prepare(`INSERT INTO job_resolution_results
        (id,search_id,ordinal,url,disposition) VALUES (?,?,?,?, 'seen')`)
        .run(id, searchId, index + 1, url);
      return id;
    });
  }

  resolutionResultDecision(
    id: string,
    disposition:
      | 'reading'
      | 'not_opened'
      | 'read_failed'
      | 'rejected'
      | 'interrupted',
    reason: string | null = null,
  ): void {
    this.db
      .prepare(`UPDATE job_resolution_results SET disposition=?,reason=?
      WHERE id=? AND disposition IN ('seen','reading')`)
      .run(disposition, reason, id);
  }

  /** Complete remaining seen rows without claiming they were opened. */
  settleResolutionResults(
    searchId: string,
    reason: 'budget' | 'accepted_earlier' | 'stopped',
  ): void {
    this.db
      .prepare(
        "UPDATE job_resolution_results SET disposition='not_opened',reason=?\n" +
          "      WHERE search_id=? AND disposition='seen'",
      )
      .run(reason, searchId);
  }

  resolutionDiagnostics(candidate: DiscoveryCandidate): ResolutionDiagnostics {
    const attempts = this.db
      .prepare(
        'SELECT a.id,i.run_id,i.source_id,s.provider,s.discovered_url,' +
          'a.sequence,a.status,a.reason,a.started_at,a.finished_at\n' +
          '      FROM job_resolution_attempts a' +
          ' JOIN job_discovery_run_items i ON i.id=a.run_item_id\n' +
          '      JOIN job_opportunity_sources s ON' +
          " s.id=i.source_id AND s.profile_id='local'\n" +
          '      WHERE s.opportunity_id=? AND i.admitted=1 ORDER BY a.sequence LIMIT 2',
      )
      .all(candidate.id) as AttemptRow[];

    return resolutionDiagnosticsOutput.parse({
      source: {
        opportunityId: candidate.id,
        sourceId: candidate.sourceId,
        provider: candidate.provider,
        discoveredUrl: candidate.discoveredUrl,
      },
      totalAttempts: candidate.resolutionAttempts,
      attempts: attempts.map((attempt) => this.attemptDiagnostics(attempt)),
    });
  }

  capture(
    candidate: DiscoveryCandidate,
    page: PageReadResult,
    at: string,
  ): string | null {
    const raw = JSON.stringify(page);
    if (Buffer.byteLength(raw, 'utf8') > MAX_CAPTURE_BYTES) return null;

    const id = crypto.randomUUID();
    this.db
      .prepare(`INSERT INTO job_opportunity_captures
      (id,opportunity_id,source_url,reader_schema_version,raw_readpage_json,captured_at)
      VALUES (?,?,?,?,?,?)`)
      .run(
        id,
        candidate.id,
        page.url,
        page.structured?.schemaVersion ?? null,
        raw,
        at,
      );
    return id;
  }

  captures(runId: string, sourceId: string): DiscoveryCapture[] | null {
    const candidate = this.admitted(runId, sourceId);
    if (!candidate) return null;

    const rows = this.db
      .prepare(
        'SELECT id, source_url, raw_readpage_json, captured_at\n' +
          '      FROM job_opportunity_captures WHERE opportunity_id=?' +
          ' ORDER BY captured_at DESC, id DESC LIMIT 12',
      )
      .all(candidate.id) as CaptureRow[];
    return rows.map(captureFromRow);
  }

  verifiedCapture(runId: string, sourceId: string): DiscoveryCapture | null {
    const candidate = this.admitted(runId, sourceId);
    if (!candidate?.canonicalUrl) return null;

    const row = this.db
      .prepare(
        'SELECT c.id, c.source_url, c.raw_readpage_json, c.captured_at\n' +
          '      FROM job_opportunities o JOIN job_opportunity_captures c\n' +
          "        ON c.id=json_extract(o.resolution_evidence_json,'$.captureId')" +
          ' AND c.opportunity_id=o.id\n' +
          "      WHERE o.id=? AND o.profile_id='local'" +
          ' AND o.canonical_verified_at IS NOT NULL AND c.source_url=o.canonical_url',
      )
      .get(candidate.id) as CaptureRow | undefined;
    return row ? captureFromRow(row) : null;
  }

  extractions(runId: string, sourceId: string): JdExtraction[] | null {
    const candidate = this.admitted(runId, sourceId);
    if (!candidate) return null;

    const rows = this.db
      .prepare(
        'SELECT * FROM job_jd_extractions WHERE opportunity_id=?' +
          ' ORDER BY started_at DESC, id DESC LIMIT 20',
      )
      .all(candidate.id) as Array<Record<string, string | null>>;
    return rows.map(extractionFromRow);
  }

  /** Only the successful interpretation of the currently verified capture. */
  currentExtraction(runId: string, sourceId: string): JdExtraction | null {
    const capture = this.verifiedCapture(runId, sourceId);
    if (!capture) return null;

    const current = this.extractions(runId, sourceId)?.find(
      (item) => item.captureId === capture.id && item.status === 'extracted',
    );
    return current ?? null;
  }

  matches(runId: string): DiscoveryMatch[] {
    if (!this.get(runId)) return [];

    const rows = this.db
      .prepare(
        'SELECT o.match_json FROM job_discovery_run_items i\n' +
          '      JOIN job_opportunity_sources s ON' +
          " s.id=i.source_id AND s.profile_id='local'\n" +
          '      JOIN job_opportunities o ON' +
          " o.id=s.opportunity_id AND o.profile_id='local'\n" +
          '      WHERE i.run_id=? AND i.admitted=1 AND o.match_json IS NOT NULL\n' +
          '      ORDER BY i.observed_at, i.id LIMIT 10',
      )
      .all(runId) as { match_json: string }[];
    return rows.map((row) =>
      discoveryMatchSchema.parse(JSON.parse(row.match_json)),
    );
  }

  saveMatch(runId: string, sourceId: string, match: DiscoveryMatch): void {
    const candidate = this.admitted(runId, sourceId);
    if (!candidate || candidate.id !== match.opportunityId) return;

    this.db
      .prepare(`UPDATE job_opportunities SET match_json=?, match_computed_at=?
      WHERE id=? AND profile_id='local'`)
      .run(
        JSON.stringify(discoveryMatchSchema.parse(match)),
        match.computedAt,
        candidate.id,
      );
  }

  claimExtraction(
    runId: string,
    sourceId: string,
    captureId: string,
    at: string,
  ): JdExtraction | null {
    return this.transaction(() => {
      const candidate = this.admitted(runId, sourceId);
      const capture = this.verifiedCapture(runId, sourceId);
      const run = this.get(runId);
      if (!candidate || !capture || capture.id !== captureId || !run)
        return null;

      const attempts = this.db
        .prepare(
          `SELECT count(*) AS count FROM job_jd_extractions WHERE capture_id=?`,
        )
        .get(captureId) as { count: number };
      if (attempts.count >= maxAttempts(run)) return null;

      const hasActiveOrSuccessful = this.db
        .prepare(
          'SELECT 1 FROM job_jd_extractions WHERE capture_id=?' +
            " AND status IN ('running','extracted')",
        )
        .get(captureId);
      if (hasActiveOrSuccessful) return null;

      const id = crypto.randomUUID();
      this.db
        .prepare(
          'INSERT INTO job_jd_extractions' +
            ' (id,opportunity_id,capture_id,run_id,status,started_at)\n' +
            "        VALUES (?,?,?,?, 'running',?)",
        )
        .run(id, candidate.id, captureId, runId, at);

      return this.extractions(runId, sourceId)!.find((item) => item.id === id)!;
    });
  }

  finishExtraction(
    runId: string,
    sourceId: string,
    id: string,
    result: {
      jd: JdExtraction['jd'];
      provenance: JdExtraction['provenance'];
      diagnostics: string[];
      errorCode: JdExtraction['errorCode'];
    },
    at: string,
    requireRunning = false,
  ): void {
    this.transaction(() => {
      const candidate = this.admitted(runId, sourceId);
      if (!candidate) return;

      const changed = this.db
        .prepare(
          'UPDATE job_jd_extractions SET status=?, extracted_jd_json=?,' +
            ' inference_meta_json=?, diagnostics_json=?, error_code=?,' +
            ' finished_at=?\n' +
            '        WHERE id=? AND opportunity_id=?' +
            " AND run_id=? AND status='running'\n" +
            '        AND (?=0 OR EXISTS (SELECT 1 FROM job_discovery_runs' +
            " WHERE id=? AND status='running'))",
        )
        .run(
          result.jd ? 'extracted' : 'failed',
          result.jd ? JSON.stringify(result.jd) : null,
          result.provenance ? JSON.stringify(result.provenance) : null,
          JSON.stringify(result.diagnostics),
          result.errorCode,
          at,
          id,
          candidate.id,
          runId,
          requireRunning ? 1 : 0,
          runId,
        );
      if (!changed.changes) return;

      this.db
        .prepare(
          'UPDATE job_opportunities SET resolution_status=?, updated_at=?' +
            " WHERE id=? AND profile_id='local' AND canonical_verified_at IS NOT NULL",
        )
        .run(result.jd ? 'extracted' : 'extraction_failed', at, candidate.id);

      const stats = this.get(runId)!.stats;
      stats.extractions++;
      this.writeStats(runId, stats);
    });
  }

  resolutionResult(
    runId: string,
    sourceId: string,
    reason: DiscoveryCandidate['resolutionReason'],
    evidence: object | null,
    canonicalUrl: string | null,
    at: string,
    requireRunning = false,
    acceptedResultId?: string,
  ): void {
    this.transaction(() => {
      const candidate = this.admitted(runId, sourceId);
      if (!candidate || candidate.canonicalUrl) return;
      if (requireRunning && this.get(runId)?.status !== 'running') return;

      const attempt = this.activeResolution(runId, sourceId);
      if (canonicalUrl && acceptedResultId && attempt) {
        const captureId = (evidence as { captureId: string }).captureId;
        this.acceptResolutionResult(acceptedResultId, attempt.id, captureId);
      }

      this.recordResolutionOutcome(
        candidate.id,
        reason,
        evidence,
        canonicalUrl,
        at,
      );
      this.recordRunItemResolution(runId, sourceId, reason, canonicalUrl, at);
      if (attempt) this.finishAttempt(runId, attempt.id, reason, at);
    });
  }

  /** Called once on application storage open, never during a dispatcher request. */
  reconcile(at: string): number {
    return this.transaction(() => {
      this.interruptResolutionHistory(null, 'interrupted', at);

      // A claim is not evidence of a failed verification. Consume the attempt,
      // but mark the abandoned run item before changing its parent run status.
      this.db
        .prepare(
          "UPDATE job_discovery_run_items SET outcome='failed'," +
            " error_code='INTERRUPTED', updated_at=?\n" +
            "        WHERE error_code='RESOLUTION_IN_PROGRESS'",
        )
        .run(at);

      this.db
        .prepare(
          'UPDATE job_opportunities SET resolution_reason=NULL, updated_at=?\n' +
            '        WHERE canonical_url IS NULL AND' +
            ' resolution_reason IS NULL AND id IN (\n' +
            '          SELECT s.opportunity_id FROM job_opportunity_sources s' +
            ' JOIN job_discovery_run_items i ON i.source_id=s.id\n' +
            "          WHERE i.error_code='INTERRUPTED' AND i.updated_at=?)",
        )
        .run(at, at);

      this.db
        .prepare(
          "UPDATE job_jd_extractions SET status='failed',error_code='INTERRUPTED'," +
            "finished_at=? WHERE status='running'",
        )
        .run(at);

      const result = this.db
        .prepare(
          'UPDATE job_discovery_runs\n' +
            "      SET status='interrupted', finished_at=?,\n" +
            "          diagnostics_json=json_insert(diagnostics_json, '$[#]'," +
            " json_object('code','INTERRUPTED_ON_RESTART','at',?))\n" +
            "      WHERE status='running'",
        )
        .run(at, at);
      return result.changes;
    });
  }

  /** Small, content-free evidence projection for frequent polling. */
  workflowEvidence(runId: string): Array<WorkflowEvidence> {
    const rows = this.db
      .prepare(
        'SELECT i.source_id, i.observed_at, i.outcome, i.error_code,\n' +
          '      o.canonical_verified_at, o.match_json,\n' +
          '      e.id AS extraction_id, e.status AS extraction_status,' +
          ' e.error_code AS extraction_error,\n' +
          '      e.diagnostics_json AS extraction_diagnostics,' +
          ' e.finished_at AS extraction_at,\n' +
          '      (SELECT count(*) FROM job_jd_extractions' +
          " WHERE capture_id=json_extract(o.resolution_evidence_json,'$.captureId'))" +
          ' AS extraction_attempts\n' +
          '      FROM job_discovery_run_items i' +
          ' JOIN job_opportunity_sources s ON s.id=i.source_id\n' +
          '      JOIN job_opportunities o ON' +
          " o.id=s.opportunity_id AND o.profile_id='local'\n" +
          '      LEFT JOIN job_jd_extractions e' +
          ' ON e.id=(SELECT id FROM job_jd_extractions\n' +
          '        WHERE opportunity_id=o.id' +
          " AND capture_id=json_extract(o.resolution_evidence_json,'$.captureId')\n" +
          '        ORDER BY started_at DESC, id DESC LIMIT 1)\n' +
          '      WHERE i.run_id=? AND i.admitted=1' +
          ' ORDER BY i.observed_at,i.id LIMIT 10',
      )
      .all(runId) as Array<Record<string, string | number | null>>;
    return rows.map(workflowEvidenceFromRow);
  }

  /** Find or create the source and opportunity for an observation. */
  private observeIdentity(
    runId: string,
    observation: CandidateObservation,
    at: string,
    applicationLookup: () => ApplicationMatch,
  ): ObservedIdentity {
    const existing = this.db
      .prepare(`SELECT id FROM job_opportunity_sources
        WHERE profile_id='local' AND provider=? AND source_key=?`)
      .get(observation.provider, observation.key) as { id: string } | undefined;

    if (existing) {
      const opportunityId = this.touchExistingSource(existing.id, at);
      return { sourceId: existing.id, opportunityId, freshAdmissible: false };
    }

    return this.registerNewSource(runId, observation, at, applicationLookup);
  }

  private touchExistingSource(sourceId: string, at: string): string {
    this.db
      .prepare(
        'UPDATE job_opportunity_sources SET last_seen_at=?' +
          " WHERE id=? AND profile_id='local'",
      )
      .run(at, sourceId);

    const row = this.db
      .prepare(
        'SELECT opportunity_id FROM job_opportunity_sources' +
          " WHERE id=? AND profile_id='local'",
      )
      .get(sourceId) as { opportunity_id: string };
    return row.opportunity_id;
  }

  private registerNewSource(
    runId: string,
    observation: CandidateObservation,
    at: string,
    applicationLookup: () => ApplicationMatch,
  ): ObservedIdentity {
    const reference = jobReference(observation.discoveredUrl);
    const alias = this.findAliasSource(observation.provider, reference);
    const verified =
      !alias && reference?.startsWith('url:')
        ? this.findVerifiedOpportunity(reference)
        : undefined;

    const application = alias || verified ? null : applicationLookup();
    const linked = application && this.findLinkedOpportunity(application.id);

    const opportunityId =
      alias?.opportunity_id ??
      verified?.id ??
      linked?.id ??
      crypto.randomUUID();
    const isNewOpportunity = !alias && !verified && !linked;
    const possibleDuplicate =
      isNewOpportunity && this.hasPossibleDuplicate(observation, opportunityId);

    const sourceId = crypto.randomUUID();
    if (isNewOpportunity)
      this.insertOpportunity(opportunityId, observation, application, at);
    this.insertSource(
      sourceId,
      opportunityId,
      observation,
      possibleDuplicate,
      at,
    );
    if (possibleDuplicate) this.notePossibleDuplicate(runId, at);

    return {
      sourceId,
      opportunityId,
      freshAdmissible: isNewOpportunity && !application,
    };
  }

  /**
   * Only exact public URL identities may attach a new alias to an existing
   * opportunity. Similar listing text is diagnostic evidence, not identity.
   */
  private findAliasSource(
    provider: string,
    reference: ReturnType<typeof jobReference>,
  ) {
    const sources = this.db
      .prepare(
        'SELECT s.id, s.discovered_url, s.opportunity_id\n' +
          '          FROM job_opportunity_sources s' +
          " WHERE s.profile_id='local' AND s.provider=?",
      )
      .all(provider) as Array<{
      id: string;
      discovered_url: string;
      opportunity_id: string;
    }>;

    if (!reference) return undefined;
    return sources.find((s) => jobReference(s.discovered_url) === reference);
  }

  private findVerifiedOpportunity(reference: string) {
    const opportunities = this.db
      .prepare(
        'SELECT id, canonical_url FROM job_opportunities\n' +
          "                  WHERE profile_id='local' AND canonical_url IS NOT NULL" +
          ' AND canonical_verified_at IS NOT NULL',
      )
      .all() as Array<{ id: string; canonical_url: string }>;
    return opportunities.find(
      (item) => jobReference(item.canonical_url) === reference,
    );
  }

  private findLinkedOpportunity(applicationId: string) {
    return this.db
      .prepare(`SELECT id FROM job_opportunities
          WHERE profile_id='local' AND application_id=? LIMIT 1`)
      .get(applicationId) as { id: string } | undefined;
  }

  private hasPossibleDuplicate(
    observation: CandidateObservation,
    opportunityId: string,
  ): boolean {
    if (!observation.company || !observation.location) return false;

    const rows = this.db
      .prepare(
        `SELECT o.title, o.location FROM job_opportunities o
           WHERE o.profile_id='local' AND lower(trim(o.company))=lower(trim(?))
           AND o.id<>?`,
      )
      .all(observation.company, opportunityId) as Array<{
      title: string;
      location: string | null;
    }>;
    return rows.some(
      (item) =>
        comparable(item.title) === comparable(observation.title) &&
        possibleLocation(item.location, observation.location),
    );
  }

  private insertOpportunity(
    opportunityId: string,
    observation: CandidateObservation,
    application: ApplicationMatch,
    at: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO job_opportunities\n' +
          '          (id,profile_id,title,company,location,review_decision,' +
          'application_id,created_at,updated_at)\n' +
          "          VALUES (?,'local',?,?,?,?,?,?,?)",
      )
      .run(
        opportunityId,
        observation.title,
        observation.company,
        observation.location,
        initialReviewDecision(application),
        application?.id ?? null,
        at,
        at,
      );
  }

  private insertSource(
    sourceId: string,
    opportunityId: string,
    observation: CandidateObservation,
    possibleDuplicate: boolean,
    at: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO job_opportunity_sources\n' +
          '          (id,profile_id,opportunity_id,provider,source_key,' +
          'discovered_url,collection_url,' +
          'listing_meta_json,first_seen_at,last_seen_at)\n' +
          "          VALUES (?,'local',?,?,?,?,?,?,?,?)",
      )
      .run(
        sourceId,
        opportunityId,
        observation.provider,
        observation.key,
        observation.discoveredUrl,
        observation.collectionUrl,
        JSON.stringify({
          postingAge: observation.postingAge,
          possibleDuplicate,
        }),
        at,
        at,
      );
  }

  /** Records at most one POSSIBLE_DUPLICATE diagnostic per run. */
  private notePossibleDuplicate(runId: string, at: string): void {
    this.db
      .prepare(
        'UPDATE job_discovery_runs SET\n' +
          "          diagnostics_json=json_insert(diagnostics_json, '$[#]'," +
          " json_object('code','POSSIBLE_DUPLICATE','at',?))\n" +
          "          WHERE id=? AND profile_id='local'" +
          ' AND json_array_length(diagnostics_json)<20\n' +
          '          AND NOT EXISTS (SELECT 1 FROM json_each(diagnostics_json)' +
          " WHERE json_extract(value,'$.code')='POSSIBLE_DUPLICATE')",
      )
      .run(at, runId);
  }

  private isAdmissible(
    runId: string,
    identity: ObservedIdentity,
    run: DiscoveryRun,
  ): boolean {
    const alreadyObserved = !!this.db
      .prepare(`SELECT 1 FROM job_discovery_run_items
        WHERE run_id=? AND source_id=?`)
      .get(runId, identity.sourceId);
    if (alreadyObserved) return false;

    const opportunityAlreadyAdmitted = !!this.db
      .prepare(`SELECT 1 FROM job_discovery_run_items i
          JOIN job_opportunity_sources s ON s.id=i.source_id
          WHERE i.run_id=? AND i.admitted=1 AND s.opportunity_id=?`)
      .get(runId, identity.opportunityId);
    if (opportunityAlreadyAdmitted) return false;

    return (
      identity.freshAdmissible ||
      this.eligibleOpportunity(identity.opportunityId, run)
    );
  }

  private insertRunItem(
    runId: string,
    sourceId: string,
    admitted: boolean,
    at: string,
  ): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO job_discovery_run_items
        (id,run_id,source_id,admitted,outcome,observed_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`)
      .run(
        crypto.randomUUID(),
        runId,
        sourceId,
        admitted ? 1 : 0,
        admitted ? 'admitted' : 'duplicate',
        at,
        at,
      );
  }

  /**
   * Existing evidence and opportunity-scoped attempts, never a new per-run
   * retry allowance.
   */
  private eligibleOpportunity(id: string, run: DiscoveryRun): boolean {
    const row = this.db
      .prepare(`SELECT o.review_decision, o.application_id,
        o.canonical_url, o.canonical_verified_at, o.resolution_attempts,
        json_extract(o.resolution_evidence_json,'$.captureId') AS capture_id
      FROM job_opportunities o WHERE o.id=? AND o.profile_id='local'`)
      .get(id) as EligibilityRow;
    if (row.application_id || row.review_decision !== 'new') return false;
    if (!row.canonical_url) return row.resolution_attempts < maxAttempts(run);
    if (!row.canonical_verified_at || !row.capture_id) return false;

    const capture = this.db
      .prepare(`SELECT 1 FROM job_opportunity_captures
      WHERE id=? AND opportunity_id=? AND source_url=?`)
      .get(row.capture_id, id, row.canonical_url);
    if (!capture) return false;

    const attempts = this.db
      .prepare(`SELECT count(*) AS count,
      count(*) FILTER (WHERE status IN ('running','extracted')) AS complete
      FROM job_jd_extractions WHERE capture_id=?`)
      .get(row.capture_id) as { count: number; complete: number };
    return attempts.complete === 0 && attempts.count < maxAttempts(run);
  }

  private writeStats(runId: string, stats: DiscoveryRunStats): void {
    this.db
      .prepare(
        'UPDATE job_discovery_runs SET stats_json=?' +
          " WHERE id=? AND profile_id='local'",
      )
      .run(JSON.stringify(stats), runId);
  }

  /** The current claimed attempt is unique per admitted run/source. */
  private activeResolution(
    runId: string,
    sourceId: string,
  ): { id: string } | undefined {
    return this.db
      .prepare(`SELECT a.id FROM job_resolution_attempts a
      JOIN job_discovery_run_items i ON i.id=a.run_item_id
      WHERE i.run_id=? AND i.source_id=? AND a.status='running'
      ORDER BY a.sequence DESC LIMIT 1`)
      .get(runId, sourceId) as { id: string } | undefined;
  }

  private interruptResolutionHistory(
    runId: string | null,
    status: 'cancelled' | 'interrupted',
    at: string,
  ): void {
    const scope = runId === null ? '' : 'AND i.run_id=?';
    const args = runId === null ? [] : [runId];

    this.db
      .prepare(
        "UPDATE job_resolution_results SET disposition='interrupted',reason=NULL\n" +
          "      WHERE disposition='reading' AND search_id IN" +
          ' (SELECT q.id FROM job_resolution_searches q\n' +
          '        JOIN job_resolution_attempts a ON a.id=q.attempt_id\n' +
          '        JOIN job_discovery_run_items i ON i.id=a.run_item_id' +
          ` WHERE a.status='running' ${scope})`,
      )
      .run(...args);

    this.db
      .prepare(
        "UPDATE job_resolution_results SET disposition='not_opened',reason='stopped'\n" +
          "      WHERE disposition='seen' AND search_id IN" +
          ' (SELECT q.id FROM job_resolution_searches q\n' +
          '        JOIN job_resolution_attempts a ON a.id=q.attempt_id\n' +
          '        JOIN job_discovery_run_items i ON i.id=a.run_item_id' +
          ` WHERE a.status='running' ${scope})`,
      )
      .run(...args);

    this.db
      .prepare(
        'UPDATE job_resolution_searches SET status=?,finished_at=?' +
          " WHERE status='running'\n" +
          '      AND attempt_id IN (SELECT a.id FROM job_resolution_attempts a\n' +
          '        JOIN job_discovery_run_items i ON i.id=a.run_item_id' +
          ` WHERE a.status='running' ${scope})`,
      )
      .run(status, at, ...args);

    this.db
      .prepare(
        'UPDATE job_resolution_attempts SET status=?,finished_at=?' +
          " WHERE status='running'\n" +
          '      AND run_item_id IN (SELECT i.id FROM job_discovery_run_items i' +
          ` WHERE 1=1 ${scope})`,
      )
      .run(status, at, ...args);
  }

  private attemptDiagnostics(attempt: AttemptRow) {
    const searches = this.db
      .prepare(
        'SELECT id,ordinal,query,status,error_code,started_at,finished_at\n' +
          '          FROM job_resolution_searches WHERE attempt_id=?' +
          ' ORDER BY ordinal LIMIT 2',
      )
      .all(attempt.id) as SearchRow[];

    return {
      id: attempt.id,
      runId: attempt.run_id,
      sourceId: attempt.source_id,
      provider: attempt.provider,
      discoveredUrl: attempt.discovered_url,
      sequence: attempt.sequence,
      status: attempt.status,
      reason: attempt.reason,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      searches: searches.map((search) => this.searchDiagnostics(search)),
    };
  }

  private searchDiagnostics(search: SearchRow) {
    const results = this.db
      .prepare(
        'SELECT ordinal,url,disposition,reason,capture_id\n' +
          '            FROM job_resolution_results WHERE search_id=?' +
          ' ORDER BY ordinal LIMIT 20',
      )
      .all(search.id) as ResultRow[];

    return {
      ordinal: search.ordinal,
      query: search.query,
      status: search.status,
      errorCode: search.error_code,
      startedAt: search.started_at,
      finishedAt: search.finished_at,
      results: results.map(resultFromRow),
    };
  }

  private acceptResolutionResult(
    resultId: string,
    attemptId: string,
    captureId: string,
  ): void {
    const changed = this.db
      .prepare(
        "UPDATE job_resolution_results SET disposition='accepted'," +
          'reason=NULL,capture_id=?\n' +
          "        WHERE id=? AND disposition='reading' AND search_id IN\n" +
          '          (SELECT id FROM job_resolution_searches WHERE attempt_id=?)',
      )
      .run(captureId, resultId, attemptId);
    if (changed.changes !== 1)
      throw new Error('Accepted result must be read and captured.');
  }

  private recordResolutionOutcome(
    opportunityId: string,
    reason: DiscoveryCandidate['resolutionReason'],
    evidence: object | null,
    canonicalUrl: string | null,
    at: string,
  ): void {
    this.db
      .prepare(
        'UPDATE job_opportunities SET resolution_status=?, resolution_reason=?,' +
          ' resolution_evidence_json=?,\n' +
          '      canonical_url=?, canonical_verified_at=?, updated_at=?' +
          " WHERE id=? AND profile_id='local' AND canonical_url IS NULL",
      )
      .run(
        canonicalUrl ? 'resolved' : 'unresolved',
        reason,
        evidence ? JSON.stringify(evidence) : null,
        canonicalUrl,
        canonicalUrl ? at : null,
        at,
        opportunityId,
      );
  }

  private recordRunItemResolution(
    runId: string,
    sourceId: string,
    reason: DiscoveryCandidate['resolutionReason'],
    canonicalUrl: string | null,
    at: string,
  ): void {
    this.db
      .prepare(
        'UPDATE job_discovery_run_items SET outcome=?, error_code=?,' +
          ' updated_at=? WHERE run_id=? AND source_id=? AND admitted=1',
      )
      .run(
        canonicalUrl ? 'resolved' : 'unresolved',
        canonicalUrl ? null : reason,
        at,
        runId,
        sourceId,
      );
  }

  private finishAttempt(
    runId: string,
    attemptId: string,
    reason: DiscoveryCandidate['resolutionReason'],
    at: string,
  ): void {
    this.db
      .prepare(
        'UPDATE job_resolution_attempts SET status=?,reason=?,finished_at=?' +
          " WHERE id=? AND status='running'",
      )
      .run(
        reason === 'cancelled' ? 'cancelled' : 'completed',
        this.attemptReason(runId, reason),
        at,
        attemptId,
      );
  }

  /** A no-match under a zero search budget is reported as a budget outcome. */
  private attemptReason(
    runId: string,
    reason: DiscoveryCandidate['resolutionReason'],
  ) {
    if (reason !== 'no_match') return reason;

    const searchBudget =
      this.get(runId)?.configSnapshot.run.maxTargetedSearchesPerCandidate;
    return searchBudget === 0 ? 'search_budget_zero' : reason;
  }
}
