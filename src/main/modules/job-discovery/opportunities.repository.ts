import type { SqliteDatabase } from '../../core/db/connection';
import {
  discoveryMatchSchema,
  jdExtractionSchema,
  opportunityDetailSchema,
  opportunitySummarySchema,
  type OpportunitySummary,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';

type Row = {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  review_decision: OpportunitySummary['decision'];
  application_id: string | null;
  canonical_url: string | null;
  canonical_verified_at: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  source_id: string | null;
  provider: string | null;
  discovered_url: string | null;
  collection_url: string | null;
  listing_meta_json: string | null;
  first_seen_at: string | null;
  source_last_seen_at: string | null;
  capture_id: string | null;
  raw_readpage_json: string | null;
  extraction_id: string | null;
  extraction_status: string | null;
  extraction_error: string | null;
  extracted_jd_json: string | null;
  diagnostics_json: string | null;
  inference_meta_json: string | null;
  extraction_started_at: string | null;
  extraction_finished_at: string | null;
  match_json: string | null;
};

const MAX_DETAIL_SOURCES = 50;
const MAX_POSTING_TEXT_CHARS = 32768;

const DETAIL_EXTRACTION_COLUMNS =
  'e.extracted_jd_json,e.diagnostics_json,e.inference_meta_json';
const SUMMARY_EXTRACTION_COLUMNS =
  'NULL AS extracted_jd_json,NULL AS diagnostics_json,' +
  'NULL AS inference_meta_json';

// Select one source, one verified capture and the latest attempt for that capture.
// The large page JSON is selected only for detail, never for list cards.
const projection = (detail: boolean) =>
  'SELECT o.*,\n' +
  '  (SELECT max(last_seen_at) FROM job_opportunity_sources' +
  " WHERE opportunity_id=o.id AND profile_id='local') AS last_seen_at,\n" +
  '  s.id AS source_id,s.provider,s.discovered_url,s.collection_url,' +
  's.listing_meta_json,\n' +
  '  s.first_seen_at,s.last_seen_at AS source_last_seen_at,\n' +
  `  c.id AS capture_id,${detail ? 'c.raw_readpage_json' : 'NULL'}` +
  ' AS raw_readpage_json,\n' +
  '  e.id AS extraction_id,e.status AS extraction_status,' +
  'e.error_code AS extraction_error,\n' +
  `  ${detail ? DETAIL_EXTRACTION_COLUMNS : SUMMARY_EXTRACTION_COLUMNS},\n` +
  '  e.started_at AS extraction_started_at,' +
  'e.finished_at AS extraction_finished_at\n' +
  '  FROM job_opportunities o\n' +
  '  LEFT JOIN job_opportunity_sources s' +
  ' ON s.id=(SELECT id FROM job_opportunity_sources\n' +
  "    WHERE opportunity_id=o.id AND profile_id='local'" +
  ' ORDER BY last_seen_at DESC,id DESC LIMIT 1)\n' +
  '  LEFT JOIN job_opportunity_captures c' +
  " ON c.id=json_extract(o.resolution_evidence_json,'$.captureId')\n" +
  '    AND c.opportunity_id=o.id AND c.source_url=o.canonical_url' +
  ' AND o.canonical_verified_at IS NOT NULL\n' +
  '  LEFT JOIN job_jd_extractions e' +
  ' ON e.id=(SELECT id FROM job_jd_extractions\n' +
  '    WHERE opportunity_id=o.id AND capture_id=c.id\n' +
  "    ORDER BY (status='extracted') DESC,started_at DESC,id DESC LIMIT 1)";

function source(row: Row) {
  if (!row.source_id) return null;

  return {
    id: row.source_id,
    provider: row.provider!,
    discoveredUrl: row.discovered_url!,
    collectionUrl: row.collection_url,
    postingAge:
      (JSON.parse(row.listing_meta_json!) as { postingAge?: string })
        .postingAge ?? null,
    firstSeenAt: row.first_seen_at!,
    lastSeenAt: row.source_last_seen_at!,
  };
}

function parseMatch(row: Row) {
  return row.match_json
    ? discoveryMatchSchema.parse(JSON.parse(row.match_json))
    : null;
}

function matchStatusOf(row: Row, match: ReturnType<typeof parseMatch>): string {
  if (!match) return 'missing';

  const hasCurrentExtraction =
    row.capture_id && row.extraction_status === 'extracted';
  if (!hasCurrentExtraction || match.extractionId !== row.extraction_id)
    return 'stale_extraction';

  return match.status;
}

function extractionStatusOf(row: Row): string | null {
  if (!row.capture_id) return 'no_verified_capture';
  if (!row.extraction_id) return 'missing';
  if (row.extraction_status === 'extracted') return 'ready';
  return row.extraction_status;
}

function summary(row: Row): OpportunitySummary {
  const match = parseMatch(row);
  const matchStatus = matchStatusOf(row, match);

  return opportunitySummarySchema.parse({
    opportunityId: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    latestSource: source(row),
    decision: row.review_decision,
    applicationId: row.application_id,
    verified: !!row.capture_id,
    extractionStatus: extractionStatusOf(row),
    matchStatus,
    coverage: matchStatus === 'scored' ? match!.coverage : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  });
}

function extractionOf(row: Row) {
  if (!row.extraction_id) return null;

  return jdExtractionSchema.parse({
    id: row.extraction_id,
    captureId: row.capture_id,
    status: row.extraction_status,
    errorCode: row.extraction_error,
    jd: row.extracted_jd_json ? JSON.parse(row.extracted_jd_json) : null,
    diagnostics: JSON.parse(row.diagnostics_json!),
    provenance: row.inference_meta_json
      ? JSON.parse(row.inference_meta_json)
      : null,
    startedAt: row.extraction_started_at,
    finishedAt: row.extraction_finished_at,
  });
}

function capturedPage(row: Row) {
  if (!row.raw_readpage_json) return null;

  return JSON.parse(row.raw_readpage_json) as {
    text?: string;
    truncated?: { text?: boolean };
  };
}

function skillFreshnessOf(
  match: ReturnType<typeof parseMatch>,
  matchStatus: string,
) {
  if (!match) return null;
  return matchStatus === 'stale_extraction' ? 'stale_extraction' : 'unknown';
}

export class OpportunitiesRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(decision: string, limit: number, before?: { at: string; id: string }) {
    const rows = this.db
      .prepare(`${projection(false)} WHERE o.profile_id='local'
      AND (?='all' OR (o.review_decision=? AND o.application_id IS NULL))
      AND (? IS NULL OR o.created_at < ? OR (o.created_at=? AND o.id < ?))
      ORDER BY o.created_at DESC,o.id DESC LIMIT ?`)
      .all(
        decision,
        decision,
        before?.at ?? null,
        before?.at ?? null,
        before?.at ?? null,
        before?.id ?? null,
        limit + 1,
      ) as Row[];

    return {
      items: rows.slice(0, limit).map(summary),
      hasMore: rows.length > limit,
    };
  }

  get(id: string) {
    const row = this.db
      .prepare(`${projection(true)} WHERE o.id=? AND o.profile_id='local'`)
      .get(id) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Opportunity not found.');

    const sources = this.db
      .prepare(`SELECT id AS source_id,provider,discovered_url,collection_url,
      listing_meta_json,first_seen_at,last_seen_at AS source_last_seen_at
      FROM job_opportunity_sources WHERE opportunity_id=? AND profile_id='local'
      ORDER BY last_seen_at DESC,id DESC LIMIT 51`)
      .all(id) as Row[];

    const page = capturedPage(row);
    const text = page?.text ?? null;
    const isTextTruncated =
      !!text &&
      (text.length > MAX_POSTING_TEXT_CHARS || !!page?.truncated?.text);

    const extraction = extractionOf(row);
    const match = parseMatch(row);
    const base = summary(row);

    return opportunityDetailSchema.parse({
      ...base,
      sources: sources.slice(0, MAX_DETAIL_SOURCES).map(source),
      sourcesTruncated: sources.length > MAX_DETAIL_SOURCES,
      canonicalUrl: row.capture_id ? row.canonical_url : null,
      verifiedCaptureId: row.capture_id,
      verifiedAt: row.capture_id ? row.canonical_verified_at : null,
      postingText: text?.slice(0, MAX_POSTING_TEXT_CHARS) ?? null,
      postingTextTruncated: isTextTruncated,
      extraction,
      match,
      skillFreshness: skillFreshnessOf(match, base.matchStatus),
    });
  }

  decide(id: string, decision: 'new' | 'saved' | 'dismissed', at: string) {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT review_decision,application_id FROM job_opportunities
        WHERE id=? AND profile_id='local'`)
        .get(id) as
        | { review_decision: string; application_id: string | null }
        | undefined;
      if (!existing) throw new AppError('NOT_FOUND', 'Opportunity not found.');

      const isTrackedApplication =
        existing.application_id || existing.review_decision === 'applied';
      if (isTrackedApplication)
        throw new AppError(
          'CONFLICT',
          'This opportunity is already tracked as an application.',
        );

      if (existing.review_decision !== decision)
        this.db
          .prepare(
            'UPDATE job_opportunities\n' +
              '        SET review_decision=?,updated_at=?' +
              " WHERE id=? AND profile_id='local'" +
              ' AND application_id IS NULL',
          )
          .run(decision, at, id);

      return summary(
        this.db
          .prepare(`${projection(false)} WHERE o.id=? AND o.profile_id='local'`)
          .get(id) as Row,
      );
    })();
  }
}
