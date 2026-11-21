import {
  WEB_LIMITS,
  webReadPageInputSchema,
  webSearchInputSchema,
  type PageReadResult,
  type SearchAttempt,
  type WebBrowsersListOutput,
  type WebCapability,
  type WebSearchOutput,
} from '../../../shared/contracts';
import type { TelemetryService } from '../telemetry/telemetry.service';
import type { AdapterRegistry } from './adapter-registry';
import { CAPABILITY_PREFERENCES } from './preferences';
import { normalizePage } from './page-normalizer';
import { resolveCapability } from './resolver';
import { isWebError, WebError } from './web.error';
import { SearchQueue, type SearchQueueDeps } from './search-queue';
import { SEARCH_POLICY, type SearchPolicy } from './search-policy';
import type { CapabilityContext } from './capabilities';

type WebOperation = 'search' | 'readPage';

type TelemetryDetail = Record<string, string | number | boolean | null>;

export interface WebServiceDeps {
  registry: AdapterRegistry;
  /** Per-capability preference order; defaults to the central static policy. */
  preferences?: Record<WebCapability, readonly string[]>;
  telemetry?: TelemetryService;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Trusted application-level search policy and deterministic test dependencies. */
  searchPolicy?: SearchPolicy;
  queueDeps?: Omit<SearchQueueDeps, 'policy'>;
  /** Overridable total page-read time budget. */
  readPageTimeoutMs?: number;
  /**
   * Diagnostic browser inventory for `web.browsers.list`. Supplied by
   * composition from the Playwright adapter; absent in search-only setups.
   */
  browserInventory?: () => Promise<WebBrowsersListOutput>;
  /** Release the browser engine when the app quits. */
  shutdownBrowser?: () => Promise<void>;
}

export interface WebSearchOptions {
  signal?: AbortSignal;
  /** Trusted in-process attribution for Discovery progress; never a public policy input. */
  ownerId?: string;
  /** Outer workflow deadline, including queue wait; Web never sets this policy. */
  deadline?: number;
}

/**
 * Shared, domain-independent Web facade. In-process callers and the narrow
 * `web` IPC use the same typed API. The service owns validation, ordering,
 * bounded orchestration and safe telemetry; it never imports a concrete
 * provider library or names a particular adapter outside telemetry provenance.
 *
 * `readPage` is a reserved capability (Stage 009.2) and is deliberately not
 * exposed here until a real adapter implements it.
 */
export class WebService {
  private readonly registry: AdapterRegistry;
  private readonly preferences: Record<WebCapability, readonly string[]>;
  private readonly telemetry?: TelemetryService;
  private readonly now: () => number;
  private readonly searchQueue: SearchQueue;
  private readonly searchPolicy: SearchPolicy;
  private readonly readPageTimeoutMs: number;
  private readonly browserInventory?: () => Promise<WebBrowsersListOutput>;
  private readonly shutdownBrowser?: () => Promise<void>;

  constructor(deps: WebServiceDeps) {
    this.registry = deps.registry;
    this.preferences = deps.preferences ?? CAPABILITY_PREFERENCES;
    this.telemetry = deps.telemetry;
    this.now = deps.now ?? Date.now;
    this.searchPolicy = deps.searchPolicy ?? SEARCH_POLICY;
    this.searchQueue = new SearchQueue({
      ...deps.queueDeps,
      now: this.now,
      policy: this.searchPolicy,
    });
    this.readPageTimeoutMs =
      deps.readPageTimeoutMs ?? WEB_LIMITS.readPageTimeoutMs;
    this.browserInventory = deps.browserInventory;
    this.shutdownBrowser = deps.shutdownBrowser;
  }

  async search(
    query: string,
    options: WebSearchOptions = {},
  ): Promise<WebSearchOutput> {
    const startedAt = new Date().toISOString();
    const queueStats = new QueueStats();

    const parsed = webSearchInputSchema.safeParse({ query });
    if (!parsed.success) {
      this.recordInvalidInput('search', startedAt, queueStats.detail());
      throw new WebError('INVALID_INPUT');
    }

    try {
      const resolved = await resolveCapability(
        'search',
        this.registry,
        this.preferences.search,
        (adapter, ctx) => adapter.search!(parsed.data.query, ctx),
        {
          signal: options.signal,
          timeoutMs: this.searchPolicy.attemptTimeoutMs,
          maxAttempts: WEB_LIMITS.maxAttempts,
          now: this.now,
          runAttempt: (_adapter, run) =>
            this.queueSearchAttempt(run, options, queueStats),
        },
      );

      const results = resolved.value;
      const attempts = finalizeAttempts(resolved.attempts, results.length);
      this.record('search', 'success', startedAt, {
        adapterId: resolved.providerId,
        resultCount: results.length,
        attempts: attempts.length,
        retries: countRetries(attempts),
        ...queueStats.detail(),
      });

      return {
        providerId: resolved.providerId,
        results,
        ...(attempts.length > 0 ? { attempts } : {}),
      };
    } catch (error) {
      throw this.recordFailure('search', startedAt, error, queueStats.detail());
    }
  }

  async readPage(
    url: string,
    options: WebSearchOptions = {},
  ): Promise<PageReadResult> {
    const startedAt = new Date().toISOString();

    const parsed = webReadPageInputSchema.safeParse({ url });
    if (!parsed.success) {
      this.recordInvalidInput('readPage', startedAt);
      throw new WebError('INVALID_INPUT');
    }

    try {
      const resolved = await resolveCapability<PageReadResult>(
        'readPage',
        this.registry,
        this.preferences.readPage,
        (adapter, ctx) =>
          adapter.readPage!(parsed.data.url, ctx) as Promise<PageReadResult>,
        {
          signal: options.signal,
          timeoutMs: this.readPageTimeoutMs,
          maxAttempts: WEB_LIMITS.maxAttempts,
          now: this.now,
        },
      );

      const raw = resolved.value;
      const result = withStructure(raw);
      this.record('readPage', 'success', startedAt, {
        adapterId: resolved.providerId,
        browserId: raw.browserId,
        status: raw.status,
        htmlTruncated: raw.truncated.html,
        textTruncated: raw.truncated.text,
        attempts: resolved.attempts.length,
        retries: countRetries(resolved.attempts),
      });

      return result;
    } catch (error) {
      throw this.recordFailure('readPage', startedAt, error);
    }
  }

  /** Diagnostic: installed-browser inventory. Empty when no reader is wired. */
  async listBrowsers(): Promise<WebBrowsersListOutput> {
    if (!this.browserInventory) {
      return { browsers: [] };
    }
    return this.browserInventory();
  }

  async shutdown(): Promise<void> {
    await this.shutdownBrowser?.();
  }

  searchProgress(ownerId: string) {
    return this.searchQueue.progress(ownerId);
  }

  /** Run one search attempt through the shared FIFO, accumulating queue stats. */
  private queueSearchAttempt<T>(
    run: (ctx: CapabilityContext) => Promise<T>,
    options: WebSearchOptions,
    queueStats: QueueStats,
  ): Promise<T> {
    queueStats.queuedAttempts++;

    return this.searchQueue.runAttempt(run, {
      signal: options.signal,
      ownerId: options.ownerId,
      deadline: options.deadline,
      onStart: (wait, depth) => {
        queueStats.queueWaitMs += wait;
        queueStats.observeDepth(depth);
      },
      onWaitEnd: (wait) => {
        queueStats.queueWaitMs += wait;
      },
      onQueued: (depth) => queueStats.observeDepth(depth),
    });
  }

  private recordInvalidInput(
    operation: WebOperation,
    startedAt: string,
    queueDetail?: TelemetryDetail,
  ): void {
    this.record(
      operation,
      'failure',
      startedAt,
      failureDetail('none', [], queueDetail),
      'INVALID_INPUT',
    );
  }

  /** Record a failed/cancelled operation and return the error to rethrow. */
  private recordFailure(
    operation: WebOperation,
    startedAt: string,
    error: unknown,
    queueDetail?: TelemetryDetail,
  ): WebError {
    const webError = isWebError(error) ? error : new WebError('INTERNAL_ERROR');
    const attempts = webError.attempts ?? [];
    const outcome = webError.code === 'CANCELLED' ? 'cancelled' : 'failure';

    this.record(
      operation,
      outcome,
      startedAt,
      failureDetail(lastProvider(attempts), attempts, queueDetail),
      webError.code,
    );

    return webError;
  }

  private record(
    operation: WebOperation,
    outcome: 'success' | 'failure' | 'cancelled',
    startedAt: string,
    detail: TelemetryDetail,
    errorCode?: string,
  ): void {
    this.telemetry?.record({
      moduleId: 'web',
      operation,
      outcome,
      startedAt,
      ...(errorCode ? { errorCode } : {}),
      detail,
    });
  }
}

/** Queue-wait telemetry accumulated across every attempt of one search. */
class QueueStats {
  queueWaitMs = 0;
  queuePeak = 0;
  queuedAttempts = 0;

  observeDepth(depth: number): void {
    this.queuePeak = Math.max(this.queuePeak, depth);
  }

  detail(): TelemetryDetail {
    return {
      queueWaitMs: this.queueWaitMs,
      queuePeak: this.queuePeak,
      queuedAttempts: this.queuedAttempts,
    };
  }
}

/**
 * Failure telemetry detail. Search failures (identified by queue detail) also
 * report zero results.
 */
function failureDetail(
  adapterId: string,
  attempts: SearchAttempt[],
  queueDetail?: TelemetryDetail,
): TelemetryDetail {
  return {
    adapterId,
    ...(queueDetail ? { resultCount: 0 } : {}),
    attempts: attempts.length,
    retries: countRetries(attempts),
    ...queueDetail,
  };
}

/** Attach the normalized structure; a normalizer failure is reported, not thrown. */
function withStructure(raw: PageReadResult): PageReadResult {
  try {
    const structured = normalizePage(raw);
    if (raw.truncated.html) structured.truncated = true;

    return { ...raw, structured };
  } catch {
    return { ...raw, structureError: 'EXTRACTION_FAILED' };
  }
}

/** Mark the successful attempt as `empty` when the result set is empty. */
function finalizeAttempts(
  attempts: SearchAttempt[],
  resultCount: number,
): SearchAttempt[] {
  if (resultCount > 0) {
    return attempts;
  }
  return attempts.map((attempt, index) =>
    index === attempts.length - 1 && attempt.outcome === 'ok'
      ? { ...attempt, outcome: 'empty' }
      : attempt,
  );
}

function countRetries(attempts: SearchAttempt[]): number {
  return attempts.filter(
    (attempt) =>
      attempt.outcome === 'retryable' || attempt.outcome === 'unavailable',
  ).length;
}

function lastProvider(attempts: SearchAttempt[]): string {
  return attempts.length > 0
    ? attempts[attempts.length - 1].providerId
    : 'none';
}
