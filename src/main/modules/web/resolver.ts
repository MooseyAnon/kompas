import type { SearchAttempt, WebCapability } from '../../../shared/contracts';
import type { AdapterRegistry } from './adapter-registry';
import type { CapabilityContext, WebAdapter } from './capabilities';
import { isWebError, WebError } from './web.error';

export interface ResolveResult<T> {
  providerId: string;
  value: T;
  attempts: SearchAttempt[];
}

export interface ResolveOptions {
  /** Caller cancellation; a pre-aborted signal yields CANCELLED with no attempts. */
  signal?: AbortSignal;
  /** Total time budget for an unqueued capability; queued searches own per-attempt timeouts. */
  timeoutMs: number;
  /** Hard cap on the number of adapters tried. */
  maxAttempts: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Search-only: serialize availability and execution; set the deadline at dispatch. */
  runAttempt?: <T>(
    adapter: WebAdapter,
    run: (ctx: CapabilityContext) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Generic capability resolver. Selects adapters by the supplied per-capability
 * preference order, skipping unregistered / non-capable / unavailable ones, and
 * falls back to the next adapter only on unavailable or explicitly retryable
 * failures. A successful result (including a valid empty one) ends the
 * operation. Invalid input, cancellation, unsafe URLs and content limits never
 * trigger fallback. The caller never names or configures the chosen adapter.
 */
export async function resolveCapability<T>(
  capability: WebCapability,
  registry: AdapterRegistry,
  preferenceOrder: readonly string[],
  run: (adapter: WebAdapter, ctx: CapabilityContext) => Promise<T>,
  options: ResolveOptions,
): Promise<ResolveResult<T>> {
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, options.timeoutMs);
  const queued = options.runAttempt !== undefined;

  const candidates = orderedCandidates(capability, registry, preferenceOrder);
  const attempts: SearchAttempt[] = [];
  if (candidates.length === 0) {
    throw withAttempts(new WebError('NO_CAPABLE_PROVIDER'), attempts);
  }

  throwIfCancelled(options.signal, attempts);

  let lastRetryable: WebError | undefined;

  for (const adapter of candidates) {
    if (attempts.length >= options.maxAttempts) break;

    throwIfCancelled(options.signal, attempts);
    if (!queued && now() >= deadline) {
      throw withAttempts(new WebError('TIMEOUT'), attempts);
    }

    // Unqueued capabilities probe availability up front; queued searches probe
    // inside the dispatched attempt so availability is checked when it runs.
    if (!queued && !(await probeAvailable(adapter))) {
      lastRetryable = new WebError('PROVIDER_UNAVAILABLE');
      recordAttempt(attempts, adapter, 'unavailable', lastRetryable.code);
      continue;
    }

    try {
      const value = await runOnce(adapter, run, options, deadline);
      recordAttempt(attempts, adapter, 'ok');

      return { providerId: adapter.id, value, attempts };
    } catch (error) {
      const webError = asWebError(error);
      const outcome = classifyFailure(capability, webError);

      if (outcome === 'abort') throw withAttempts(webError, attempts);

      recordAttempt(attempts, adapter, outcome, webError.code);
      if (outcome === 'fatal') throw withAttempts(webError, attempts);

      lastRetryable = webError;
    }
  }

  // Every capable adapter was unavailable or retryably failed.
  throw withAttempts(
    lastRetryable ?? new WebError('PROVIDER_UNAVAILABLE'),
    attempts,
  );
}

/** How a failed attempt affects the operation. */
type FailureOutcome = 'abort' | 'fatal' | 'unavailable' | 'retryable';

/**
 * Fallback policy for a failed attempt:
 * - `abort`: cancellation, timeout and a full queue end the operation without
 *   recording an attempt;
 * - `fatal`: non-retryable errors (and search rate limiting) end the
 *   operation after recording the attempt;
 * - `unavailable` / `retryable`: record and fall back to the next adapter.
 */
function classifyFailure(
  capability: WebCapability,
  error: WebError,
): FailureOutcome {
  const endsOperation =
    error.code === 'CANCELLED' ||
    error.code === 'TIMEOUT' ||
    error.code === 'QUEUE_FULL';
  if (endsOperation) return 'abort';

  if (error.code === 'PROVIDER_UNAVAILABLE') return 'unavailable';

  // Falling back after a search rate limit would just hammer another provider.
  if (capability === 'search' && error.code === 'RATE_LIMITED') return 'fatal';
  if (!error.retryable) return 'fatal';

  return 'retryable';
}

function runOnce<T>(
  adapter: WebAdapter,
  run: (adapter: WebAdapter, ctx: CapabilityContext) => Promise<T>,
  options: ResolveOptions,
  deadline: number,
): Promise<T> {
  if (!options.runAttempt) {
    return run(adapter, { signal: cancelSignal(options.signal), deadline });
  }

  return options.runAttempt(adapter, async (ctx) => {
    if (!(await probeAvailable(adapter))) {
      throw new WebError('PROVIDER_UNAVAILABLE');
    }

    return run(adapter, ctx);
  });
}

function recordAttempt(
  attempts: SearchAttempt[],
  adapter: WebAdapter,
  outcome: SearchAttempt['outcome'],
  errorCode?: SearchAttempt['errorCode'],
): void {
  attempts.push(
    errorCode
      ? { providerId: adapter.id, outcome, errorCode }
      : { providerId: adapter.id, outcome },
  );
}

function orderedCandidates(
  capability: WebCapability,
  registry: AdapterRegistry,
  preferenceOrder: readonly string[],
): WebAdapter[] {
  const capable = new Set(
    registry.supporting(capability).map((adapter) => adapter.id),
  );
  const ordered: WebAdapter[] = [];
  for (const id of preferenceOrder) {
    if (!capable.has(id)) continue;

    const adapter = registry.get(id);
    if (adapter) ordered.push(adapter);
  }

  return ordered;
}

async function probeAvailable(adapter: WebAdapter): Promise<boolean> {
  if (!adapter.isAvailable) {
    return true;
  }
  try {
    return await adapter.isAvailable();
  } catch {
    return false;
  }
}

function asWebError(error: unknown): WebError {
  if (isWebError(error)) {
    return error;
  }
  // Unknown adapter errors are treated as retryable provider failures so the
  // resolver can fall back; raw details never leave the main process.
  return new WebError('PROVIDER_FAILURE', { retryable: true });
}

function cancelSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

function withAttempts(error: WebError, attempts: SearchAttempt[]): WebError {
  error.attempts = attempts;
  return error;
}

function throwIfCancelled(
  signal: AbortSignal | undefined,
  attempts: SearchAttempt[],
): void {
  if (signal?.aborted) {
    throw withAttempts(new WebError('CANCELLED'), attempts);
  }
}
