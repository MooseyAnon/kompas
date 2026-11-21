import {
  TELEMETRY_RUNS_DEFAULT_LIMIT,
  TELEMETRY_RUNS_MAX_LIMIT,
  type OperationOutcome,
  type OperationRun,
} from '../../../shared/contracts';
import type { JsonlLogger } from './jsonl-log';
import type { TelemetryRepository } from './telemetry.repository';

/** Only non-sensitive primitives are permitted in telemetry detail. */
export type SafeDetail = Record<string, string | number | boolean | null>;

/** A safe run projection plus its parsed, re-validated safe detail. */
export type OperationRunWithDetail = OperationRun & {
  detail: SafeDetail | null;
};

export interface RecordRunInput {
  moduleId: string;
  operation: string;
  outcome: OperationOutcome;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorCode?: string | null;
  correlationId?: string;
  detail?: SafeDetail;
}

export interface TelemetryServiceDeps {
  repository?: TelemetryRepository;
  logger?: JsonlLogger;
  /** Max rows retained in operation_runs. */
  retentionCap?: number;
}

const DEFAULT_RETENTION_CAP = 2000;
const MAX_DETAIL_BYTES = 2048;

/**
 * Records observable operation outcomes to SQLite and a bounded JSONL log.
 * Recording is best-effort and must never throw into or fail a user operation:
 * a telemetry failure is swallowed. Only safe metadata (timings, codes, counts)
 * is persisted — never profile text, document contents, prompts or secrets.
 */
export class TelemetryService {
  private readonly repository?: TelemetryRepository;
  private readonly logger?: JsonlLogger;
  private readonly retentionCap: number;

  constructor(deps: TelemetryServiceDeps = {}) {
    this.repository = deps.repository;
    this.logger = deps.logger;
    this.retentionCap = deps.retentionCap ?? DEFAULT_RETENTION_CAP;
  }

  record(input: RecordRunInput): void {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    const durationMs = normaliseDuration(input, startedAt, finishedAt);
    const errorCode = input.errorCode ?? null;
    const detailJson = serialiseDetail(input.detail);

    try {
      this.repository?.insert({
        id: globalThis.crypto.randomUUID(),
        moduleId: input.moduleId,
        operation: input.operation,
        outcome: input.outcome,
        startedAt,
        finishedAt,
        durationMs,
        errorCode,
        detailJson,
      });
      this.repository?.pruneToCap(this.retentionCap);
    } catch {
      // Best-effort: never let telemetry persistence break a user operation.
    }

    this.logger?.write({
      ts: finishedAt,
      module: input.moduleId,
      operation: input.operation,
      outcome: input.outcome,
      durationMs,
      errorCode,
      correlationId: input.correlationId,
    });
  }

  /** Record application boot / migration outcome. */
  recordBoot(
    outcome: OperationOutcome,
    extra: {
      durationMs?: number;
      errorCode?: string | null;
      detail?: SafeDetail;
    } = {},
  ): void {
    this.record({
      moduleId: 'system',
      operation: 'boot',
      outcome,
      durationMs: extra.durationMs,
      errorCode: extra.errorCode ?? null,
      detail: extra.detail,
    });
  }

  /** Record a sanitised IPC dispatch failure (no payload contents). */
  recordIpcFailure(info: {
    correlationId: string;
    module: string;
    action: string;
    code: string;
  }): void {
    this.record({
      moduleId: info.module,
      operation: info.action,
      outcome: 'failure',
      errorCode: info.code,
      correlationId: info.correlationId,
    });
  }

  list(limit?: number): OperationRun[] {
    if (!this.repository) {
      return [];
    }
    const effective = clampLimit(limit);
    try {
      return this.repository.list(effective);
    } catch {
      return [];
    }
  }

  /**
   * Return recent runs for one module with each run's safe detail parsed back
   * into primitives. Used by domain modules (e.g. inference diagnostics) to
   * project their own allowlisted metadata without a second analytics stack.
   */
  listByModule(moduleId: string, limit?: number): OperationRunWithDetail[] {
    if (!this.repository) {
      return [];
    }
    const effective = clampLimit(limit);
    try {
      return this.repository
        .listByModule(moduleId, effective)
        .map((run) => ({ ...run, detail: parseDetail(run.detailJson) }));
    } catch {
      return [];
    }
  }
}

function parseDetail(detailJson: string | null): SafeDetail | null {
  if (!detailJson) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const safe: SafeDetail = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

function clampLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return TELEMETRY_RUNS_DEFAULT_LIMIT;
  }
  return Math.min(limit, TELEMETRY_RUNS_MAX_LIMIT);
}

function normaliseDuration(
  input: RecordRunInput,
  startedAt: string,
  finishedAt: string,
): number {
  if (typeof input.durationMs === 'number' && input.durationMs >= 0) {
    return Math.round(input.durationMs);
  }
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (Number.isFinite(start) && Number.isFinite(finish) && finish >= start) {
    return finish - start;
  }
  return 0;
}

function serialiseDetail(detail?: SafeDetail): string | null {
  if (!detail) {
    return null;
  }
  const json = JSON.stringify(detail);
  if (Buffer.byteLength(json, 'utf8') > MAX_DETAIL_BYTES) {
    return null;
  }
  return json;
}
