import type { SqliteDatabase } from '../../core/db/connection';
import type { OperationOutcome, OperationRun } from '../../../shared/contracts';

export interface OperationRunRecord {
  id: string;
  moduleId: string;
  operation: string;
  outcome: OperationOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  errorCode: string | null;
  /** Sanitised JSON string (already validated by the caller) or null. */
  detailJson: string | null;
}

interface OperationRunRow {
  id: string;
  module_id: string;
  operation: string;
  outcome: OperationOutcome;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error_code: string | null;
}

interface OperationRunDetailRow extends OperationRunRow {
  detail_json: string | null;
}

/** A safe run projection plus its raw (already-sanitised) detail JSON string. */
export interface OperationRunWithDetailJson extends OperationRun {
  detailJson: string | null;
}

/**
 * Domain-owned repository for the telemetry `operation_runs` table. Owns all
 * SQL for that table; no raw database handle is exposed outside this module.
 */
export class TelemetryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: OperationRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO operation_runs
           (id, module_id, operation, outcome, started_at, finished_at,
            duration_ms, error_code, detail_json)
         VALUES
           (@id, @moduleId, @operation, @outcome, @startedAt, @finishedAt,
            @durationMs, @errorCode, @detailJson)`,
      )
      .run(record);
  }

  /** Return the most recent runs as the safe public shape (no detail_json). */
  list(limit: number): OperationRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, module_id, operation, outcome, started_at, finished_at,
                duration_ms, error_code
         FROM operation_runs
         ORDER BY started_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as OperationRunRow[];
    return rows.map(mapRow);
  }

  /**
   * Return the most recent runs for one module, including each run's
   * already-sanitised `detail_json` string so a domain module can project its
   * own safe metadata fields. The caller is responsible for parsing and
   * re-validating the detail into a safe shape.
   */
  listByModule(moduleId: string, limit: number): OperationRunWithDetailJson[] {
    const rows = this.db
      .prepare(
        `SELECT id, module_id, operation, outcome, started_at, finished_at,
                duration_ms, error_code, detail_json
         FROM operation_runs
         WHERE module_id = ?
         ORDER BY started_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(moduleId, limit) as OperationRunDetailRow[];
    return rows.map((row) => ({ ...mapRow(row), detailJson: row.detail_json }));
  }

  /** Enforce a conservative local retention cap on the runs table. */
  pruneToCap(cap: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM operation_runs
         WHERE id NOT IN (
           SELECT id FROM operation_runs
           ORDER BY started_at DESC, rowid DESC
           LIMIT ?
         )`,
      )
      .run(cap);
    return result.changes;
  }
}

function mapRow(row: OperationRunRow): OperationRun {
  return {
    id: row.id,
    moduleId: row.module_id,
    operation: row.operation,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    errorCode: row.error_code,
  };
}
