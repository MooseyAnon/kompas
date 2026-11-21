import {
  INFERENCE_LIMITS,
  generationRequestSchema,
  type CancelResult,
  type GenerationEvent,
  type GenerationRequestInput,
  type GenerationResult,
  type InferenceErrorCode,
  type ToolPolicy,
} from '../../../shared/contracts';
import type { ToolApprovalHandler } from '../../core/tools/tool-broker';
import type { TelemetryService } from '../telemetry/telemetry.service';

export type GenerationPriority = 'interactive' | 'normal' | 'background';

/** Trusted, in-process submission; nothing here is exposed over renderer IPC. */
export type GenerationEntry = GenerationRequestInput & {
  callerModule: string;
  contextId?: string;
  toolPolicy?: Partial<ToolPolicy>;
  approvalHandler?: ToolApprovalHandler;
  telemetryOperation?: string;
  execution: {
    priority: GenerationPriority;
    retry?: { maxRetries: 0 | 1 | 2 };
    signal?: AbortSignal;
    onEvent?: (event: GenerationEvent) => void;
  };
};

type DispatchGeneration = (
  entry: GenerationEntry,
  signal: AbortSignal,
  onEvent: ((event: GenerationEvent) => void) | undefined,
  timeoutMs: number,
) => Promise<GenerationResult>;

interface Scheduled {
  entry: GenerationEntry;
  id: string;
  order: number;
  enqueuedAt: number;
  dispatchedAt: number | null;
  attemptsMade: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  resolve: (result: GenerationResult) => void;
  settled: boolean;
  lastSeq: number;
}

/** Telemetry stage names, recorded as `scheduler.<stage>`. */
type SchedulerStage =
  | 'queued'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'exhausted'
  | 'cancelled_queued'
  | 'cancelled_active';

const PRIORITY_RANK: Record<GenerationPriority, number> = {
  interactive: 0,
  normal: 1,
  background: 2,
};

/** Failures worth retrying because a later attempt may succeed. */
const TRANSIENT_ERROR_CODES = new Set<InferenceErrorCode>([
  'PROVIDER_UNAVAILABLE',
  'WORKER_EXITED',
  'WORKER_UNAVAILABLE',
  'TIMEOUT',
]);

const DEFAULT_MAX_RETRIES = 2;

const MAX_ALLOWED_RETRIES = 2;

/** Linear backoff: attempt N waits `RETRY_BACKOFF_STEP_MS * (N + 1)`. */
const RETRY_BACKOFF_STEP_MS = 100;

/** Number of settled request ids remembered for `already_finished` answers. */
const FINISHED_CACHE_CAP = 256;

const CALLER_MODULE_PATTERN = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;

const TERMINAL_EVENT_KINDS: ReadonlyArray<GenerationEvent['kind']> = [
  'completed',
  'failed',
  'cancelled',
];

const GENERIC_FAILURE_MESSAGE = 'Inference generation failed.';

const RETRIES_EXHAUSTED_MESSAGE = 'Inference retries were exhausted.';

/** Single-resource non-preemptive scheduler; capacity is internal, never caller-controlled. */
export class GenerationScheduler {
  private readonly queue: Scheduled[] = [];
  private readonly entries = new Map<string, Scheduled>();
  private readonly finished = new Set<string>();
  private active = 0;
  private nextOrder = 0;
  private stopped = false;

  constructor(
    private readonly dispatch: DispatchGeneration,
    private readonly telemetry?: TelemetryService,
    private readonly capacity = 1,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Invalid inference capacity');
    }
  }

  submit(entry: GenerationEntry): Promise<GenerationResult> {
    const id = entry.requestId ?? crypto.randomUUID();
    const maxRetries = maxRetriesOf(entry);

    if (!this.isAcceptable(entry, id, maxRetries)) {
      return Promise.resolve(
        failureResult(entry, id, 'INTERNAL', 0, maxRetries),
      );
    }

    if (this.stopped) {
      return Promise.resolve(cancelledResult(entry, id, 0, maxRetries));
    }

    return new Promise((resolve) => {
      this.enqueue(entry, id, resolve);

      if (entry.execution.signal?.aborted) {
        this.abort(id);
      } else {
        this.pump();
      }
    });
  }

  cancel(id: string): CancelResult {
    if (!this.entries.has(id)) {
      return {
        requestId: id,
        outcome: this.finished.has(id) ? 'already_finished' : 'not_found',
      };
    }

    this.abort(id);

    return { requestId: id, outcome: 'cancelled' };
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.entries.keys()) {
      this.abort(id);
    }
  }

  // --- queueing -------------------------------------------------------------

  private isAcceptable(
    entry: GenerationEntry,
    id: string,
    maxRetries: number,
  ): boolean {
    const requestIsValid = generationRequestSchema.safeParse({
      ...entry,
      requestId: id,
    }).success;
    const callerIsValid =
      !!entry.callerModule && CALLER_MODULE_PATTERN.test(entry.callerModule);
    const priorityIsValid = Object.hasOwn(
      PRIORITY_RANK,
      entry.execution?.priority,
    );
    const retriesAreValid =
      Number.isInteger(maxRetries) &&
      maxRetries >= 0 &&
      maxRetries <= MAX_ALLOWED_RETRIES;

    return (
      requestIsValid &&
      callerIsValid &&
      priorityIsValid &&
      retriesAreValid &&
      !this.entries.has(id)
    );
  }

  private enqueue(
    entry: GenerationEntry,
    id: string,
    resolve: (result: GenerationResult) => void,
  ): void {
    const timeoutMs =
      entry.limits?.timeoutMs ?? INFERENCE_LIMITS.defaultTimeoutMs;
    const item: Scheduled = {
      entry: { ...entry, requestId: id },
      id,
      order: this.nextOrder++,
      enqueuedAt: Date.now(),
      dispatchedAt: null,
      attemptsMade: 0,
      controller: new AbortController(),
      timer: setTimeout(() => this.abort(id, true), timeoutMs),
      detach: () => {},
      resolve,
      settled: false,
      lastSeq: 0,
    };

    const signal = entry.execution.signal;
    if (signal) {
      const onAbort = () => this.abort(id);
      signal.addEventListener('abort', onAbort, { once: true });
      item.detach = () => signal.removeEventListener('abort', onAbort);
    }

    this.entries.set(id, item);
    this.queue.push(item);
    this.record(item, 'queued');
  }

  private abort(id: string, timedOut = false): void {
    const item = this.entries.get(id);
    if (!item || item.settled) {
      return;
    }

    item.controller.abort();

    // Settle immediately even during worker startup. The slot remains occupied
    // until the underlying dispatch actually unwinds, avoiding overlap.
    const { entry, attemptsMade } = item;
    const maxRetries = maxRetriesOf(entry);

    if (timedOut) {
      this.finish(
        item,
        failureResult(entry, id, 'TIMEOUT', attemptsMade, maxRetries),
        'failed',
      );
      return;
    }

    this.finish(
      item,
      cancelledResult(entry, id, attemptsMade, maxRetries),
      item.dispatchedAt === null ? 'cancelled_queued' : 'cancelled_active',
    );
  }

  private pump(): void {
    while (!this.stopped && this.active < this.capacity && this.queue.length) {
      this.queue.sort(byPriorityThenOrder);
      const item = this.queue.shift()!;
      if (item.settled) {
        continue;
      }

      item.dispatchedAt = Date.now();
      this.active++;
      this.record(item, 'dispatched');

      void this.run(item).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  // --- execution ------------------------------------------------------------

  /**
   * Dispatch with bounded retries for transient failures, within the
   * request's overall deadline measured from when it was enqueued.
   */
  private async run(item: Scheduled): Promise<void> {
    const { entry, controller } = item;
    const maxRetries = maxRetriesOf(entry);

    // A tool run may have performed an external effect even if the worker crashes.
    const hasTools = !!entry.toolNames?.length;
    const allowedRetries = hasTools ? 0 : maxRetries;
    let lastCode: InferenceErrorCode = 'INTERNAL';

    for (let attempt = 0; attempt <= allowedRetries; attempt++) {
      if (controller.signal.aborted) {
        break;
      }

      const remainingMs = this.remainingMs(item);
      if (remainingMs < INFERENCE_LIMITS.minTimeoutMs) {
        lastCode = 'TIMEOUT';
        break;
      }

      item.attemptsMade++;
      const result = await this.attempt(item, remainingMs);
      if (controller.signal.aborted) {
        break;
      }

      if (result.status === 'completed' || result.status === 'cancelled') {
        this.finish(
          item,
          { ...result, attemptsMade: item.attemptsMade, maxRetries },
          result.status === 'completed' ? 'completed' : 'cancelled_active',
        );
        return;
      }

      lastCode = result.error?.code ?? 'INTERNAL';
      if (!TRANSIENT_ERROR_CODES.has(lastCode) || hasTools) {
        this.finish(
          item,
          { ...result, attemptsMade: item.attemptsMade, maxRetries },
          'failed',
        );
        return;
      }

      if (attempt === allowedRetries) {
        break;
      }

      await backoff(controller.signal, RETRY_BACKOFF_STEP_MS * (attempt + 1));
    }

    if (!controller.signal.aborted) {
      this.finishUnsuccessful(item, lastCode, allowedRetries);
    }
  }

  private remainingMs(item: Scheduled): number {
    const timeoutMs =
      item.entry.limits?.timeoutMs ?? INFERENCE_LIMITS.defaultTimeoutMs;

    return item.enqueuedAt + timeoutMs - Date.now();
  }

  /** One dispatch attempt; a thrown dispatch becomes an `INTERNAL` failure. */
  private async attempt(
    item: Scheduled,
    remainingMs: number,
  ): Promise<GenerationResult> {
    const { entry, id, controller } = item;
    const timeoutMs = Math.min(
      INFERENCE_LIMITS.maxTimeoutMs,
      Math.floor(remainingMs),
    );

    try {
      return await this.dispatch(
        entry,
        controller.signal,
        (event) => this.forwardProgress(item, event),
        timeoutMs,
      );
    } catch {
      return failureResult(
        entry,
        id,
        'INTERNAL',
        item.attemptsMade,
        maxRetriesOf(entry),
      );
    }
  }

  /**
   * Re-sequence non-terminal progress events for the caller. Terminal events
   * are emitted once by {@link finish} so retries never leak them.
   */
  private forwardProgress(item: Scheduled, event: GenerationEvent): void {
    const isForwardable =
      !item.settled &&
      !item.controller.signal.aborted &&
      !TERMINAL_EVENT_KINDS.includes(event.kind);
    if (!isForwardable) {
      return;
    }

    try {
      item.entry.execution.onEvent?.({ ...event, seq: ++item.lastSeq });
    } catch {
      // A caller's progress observer cannot strand the active worker.
    }
  }

  private finishUnsuccessful(
    item: Scheduled,
    lastCode: InferenceErrorCode,
    allowedRetries: number,
  ): void {
    const exhausted =
      item.attemptsMade > 0 &&
      TRANSIENT_ERROR_CODES.has(lastCode) &&
      item.attemptsMade > allowedRetries;
    const code = exhausted ? 'RETRIES_EXHAUSTED' : lastCode;
    const result = failureResult(
      item.entry,
      item.id,
      code,
      item.attemptsMade,
      maxRetriesOf(item.entry),
    );

    this.finish(
      item,
      { ...result, lastErrorCode: lastCode },
      exhausted ? 'exhausted' : 'failed',
    );
  }

  // --- settlement -----------------------------------------------------------

  private finish(
    item: Scheduled,
    result: GenerationResult,
    stage: SchedulerStage,
  ): void {
    if (item.settled) {
      return;
    }

    item.settled = true;
    clearTimeout(item.timer);
    item.detach();

    this.entries.delete(item.id);
    this.rememberFinished(item.id);

    const index = this.queue.indexOf(item);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }

    this.record(
      item,
      stage,
      result.error?.code ?? null,
      result.lastErrorCode ?? null,
    );

    try {
      item.entry.execution.onEvent?.(
        toTerminalEvent(result, item.id, ++item.lastSeq),
      );
    } catch {
      // A progress callback cannot change the settled result.
    }

    item.resolve(result);
  }

  private rememberFinished(id: string): void {
    this.finished.add(id);

    if (this.finished.size > FINISHED_CACHE_CAP) {
      this.finished.delete(this.finished.values().next().value!);
    }
  }

  private record(
    item: Scheduled,
    stage: SchedulerStage,
    errorCode: string | null = null,
    lastErrorCode: string | null = null,
  ): void {
    const now = Date.now();
    const executionMs =
      item.dispatchedAt === null ? 0 : Math.max(0, now - item.dispatchedAt);

    this.telemetry?.record({
      moduleId: 'inference',
      operation: 'scheduler.' + stage,
      outcome: stageOutcome(stage),
      correlationId: item.id,
      errorCode,
      detail: {
        requestId: item.id,
        callerModule: item.entry.callerModule,
        priority: item.entry.execution.priority,
        providerId: item.entry.providerId,
        modelId: item.entry.modelId,
        queueDepth: this.queue.length,
        activeCount: this.active,
        queueWaitMs: Math.max(0, (item.dispatchedAt ?? now) - item.enqueuedAt),
        executionMs,
        totalMs: Math.max(0, now - item.enqueuedAt),
        attemptsMade: item.attemptsMade,
        retriesUsed: Math.max(0, item.attemptsMade - 1),
        lastErrorCode,
      },
    });
  }
}

// --- module helpers ---------------------------------------------------------

function maxRetriesOf(entry: GenerationEntry): number {
  return entry.execution?.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
}

function byPriorityThenOrder(a: Scheduled, b: Scheduled): number {
  const priorityDelta =
    PRIORITY_RANK[a.entry.execution.priority] -
    PRIORITY_RANK[b.entry.execution.priority];

  return priorityDelta || a.order - b.order;
}

/** Wait `ms`, resolving early if `signal` aborts. */
function backoff(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }

    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) {
      done();
    }
  });
}

function stageOutcome(
  stage: SchedulerStage,
): 'success' | 'cancelled' | 'failure' {
  if (stage === 'cancelled_queued' || stage === 'cancelled_active') {
    return 'cancelled';
  }

  if (stage === 'failed' || stage === 'exhausted') {
    return 'failure';
  }

  return 'success';
}

function toTerminalEvent(
  result: GenerationResult,
  requestId: string,
  seq: number,
): GenerationEvent {
  const common = { requestId, seq, at: new Date().toISOString() };

  if (result.status === 'completed') {
    return {
      ...common,
      kind: 'completed',
      output: result.output,
      usage: result.usage,
    };
  }

  if (result.status === 'cancelled') {
    return { ...common, kind: 'cancelled' };
  }

  return {
    ...common,
    kind: 'failed',
    error: result.error ?? {
      code: 'INTERNAL',
      message: GENERIC_FAILURE_MESSAGE,
    },
  };
}

function failureResult(
  entry: GenerationEntry,
  id: string,
  code: InferenceErrorCode,
  attemptsMade: number,
  maxRetries: number,
): GenerationResult {
  const message =
    code === 'RETRIES_EXHAUSTED'
      ? RETRIES_EXHAUSTED_MESSAGE
      : GENERIC_FAILURE_MESSAGE;

  return {
    requestId: id,
    providerId: entry.providerId,
    modelId: entry.modelId,
    status: 'failed',
    output: null,
    usage: null,
    toolCalls: [],
    error: { code, message },
    attemptsMade,
    maxRetries,
  };
}

function cancelledResult(
  entry: GenerationEntry,
  id: string,
  attemptsMade: number,
  maxRetries: number,
): GenerationResult {
  return {
    requestId: id,
    providerId: entry.providerId,
    modelId: entry.modelId,
    status: 'cancelled',
    output: null,
    usage: null,
    toolCalls: [],
    attemptsMade,
    maxRetries,
  };
}
