import { WebError } from './web.error';
import {
  SEARCH_POLICY,
  validateSearchPolicy,
  type SearchPolicy,
} from './search-policy';
import type { CapabilityContext } from './capabilities';

type Timer = ReturnType<typeof setTimeout>;

export interface SearchQueueDeps {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  clear?: (timer: Timer) => void;
  random?: () => number;
  policy?: SearchPolicy;
}

export interface SearchQueueProgress {
  queueLength: number;
  position: number | null;
  state: 'idle' | 'waiting' | 'running';
  waitingMs: number;
  nextEligibleAt: string | null;
}

interface QueueOptions {
  signal?: AbortSignal;
  deadline?: number;
  ownerId?: string;
  onStart?: (waitingMs: number, depth: number) => void;
  onWaitEnd?: (waitingMs: number) => void;
  onQueued?: (depth: number) => void;
}

interface Entry {
  ownerId?: string;
  enqueuedAt: number;
  expiresAt: number;
  startedAt?: number;
  signal?: AbortSignal;
  work: () => Promise<unknown>;
  onStart?: (waitingMs: number, depth: number) => void;
  onWaitEnd?: (waitingMs: number) => void;
  resolve: (value: unknown) => void;
  reject: (error: WebError) => void;
  expiry: Timer | null;
  onAbort: () => void;
}

/** One FIFO for all WebService search attempts, including fallback attempts. */
export class SearchQueue {
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => Timer;
  private readonly clear: (timer: Timer) => void;
  private readonly random: () => number;
  private readonly policy: SearchPolicy;
  private readonly pending: Entry[] = [];
  private active: Entry | null = null;
  private cooldown: Timer | null = null;
  private nextEligible = 0;

  constructor(deps: SearchQueueDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? setTimeout;
    this.clear = deps.clear ?? clearTimeout;
    this.random = deps.random ?? Math.random;
    this.policy = deps.policy ?? SEARCH_POLICY;
    validateSearchPolicy(this.policy);
  }

  /**
   * Enqueue `work` behind every earlier search. Rejects immediately when the
   * caller is already cancelled, the wait budget is spent or the queue is full.
   */
  run<T>(work: () => Promise<T>, options: QueueOptions = {}): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new WebError('CANCELLED'));
    }

    const now = this.now();
    const expiresAt = Math.min(
      now + this.policy.maxWaitMs,
      options.deadline ?? Infinity,
    );
    if (now >= expiresAt) return Promise.reject(new WebError('TIMEOUT'));

    if (this.pending.length >= this.policy.maxQueued) {
      return Promise.reject(new WebError('QUEUE_FULL'));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        ownerId: options.ownerId,
        enqueuedAt: now,
        expiresAt,
        signal: options.signal,
        work,
        onStart: options.onStart,
        onWaitEnd: options.onWaitEnd,
        resolve: (value) => resolve(value as T),
        reject,
        expiry: null,
        onAbort: () => this.remove(entry, new WebError('CANCELLED')),
      };
      entry.expiry = this.schedule(
        () => this.remove(entry, new WebError('TIMEOUT')),
        Math.max(0, expiresAt - now),
      );
      options.signal?.addEventListener('abort', entry.onAbort, { once: true });

      this.pending.push(entry);
      options.onQueued?.(this.pending.length + (this.active ? 1 : 0));
      this.pump();
    });
  }

  /** Queue wait ends before the independent per-adapter network budget begins. */
  runAttempt<T>(
    run: (context: CapabilityContext) => Promise<T>,
    options: QueueOptions = {},
  ): Promise<T> {
    return this.run(() => this.runWithAttemptBudget(run, options), options);
  }

  progress(ownerId: string): SearchQueueProgress {
    const position = this.pending.findIndex(
      (entry) => entry.ownerId === ownerId,
    );
    const waiting = position >= 0 ? this.pending[position] : null;
    const running = this.active?.ownerId === ownerId ? this.active : null;
    const isNextInLine = waiting !== null && position === 0;

    return {
      queueLength: this.pending.length,
      position: waiting ? position + 1 : null,
      state: waiting ? 'waiting' : running ? 'running' : 'idle',
      waitingMs: this.progressWaitingMs(waiting, running),
      nextEligibleAt:
        isNextInLine && this.nextEligible > this.now()
          ? new Date(this.nextEligible).toISOString()
          : null,
    };
  }

  /**
   * Run one dispatched attempt with its own abort controller and a timeout
   * bounded by the attempt budget and the outer deadline.
   */
  private runWithAttemptBudget<T>(
    run: (context: CapabilityContext) => Promise<T>,
    options: QueueOptions,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const deadline = Math.min(
        this.now() + this.policy.attemptTimeoutMs,
        options.deadline ?? Infinity,
      );
      let settled = false;

      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        this.clear(timer);
        options.signal?.removeEventListener('abort', onAbort);
        complete();
      };

      const abortWith = (error: WebError) => {
        controller.abort();
        finish(() => reject(error));
      };

      const onAbort = () => abortWith(new WebError('CANCELLED'));
      const timer = this.schedule(
        () => abortWith(new WebError('TIMEOUT')),
        Math.max(0, deadline - this.now()),
      );

      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      void Promise.resolve()
        .then(() => run({ signal: controller.signal, deadline }))
        .then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
    });
  }

  private progressWaitingMs(
    waiting: Entry | null,
    running: Entry | null,
  ): number {
    if (waiting) return Math.max(0, this.now() - waiting.enqueuedAt);

    if (running?.startedAt !== undefined) {
      return Math.max(0, running.startedAt - running.enqueuedAt);
    }

    return 0;
  }

  private remove(entry: Entry, error: WebError): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;

    this.pending.splice(index, 1);
    this.rejectWaiting(entry, error);
    this.pump();
  }

  /** Settle an entry that never started; its queue wait still counts. */
  private rejectWaiting(entry: Entry, error: WebError): void {
    this.cleanup(entry);
    entry.onWaitEnd?.(this.waitedMs(entry));
    entry.reject(error);
  }

  private cleanup(entry: Entry): void {
    if (entry.expiry) this.clear(entry.expiry);
    entry.signal?.removeEventListener('abort', entry.onAbort);
  }

  private waitedMs(entry: Entry): number {
    return Math.max(0, this.now() - entry.enqueuedAt);
  }

  /** Start the next eligible entry, honouring the inter-search cooldown. */
  private pump(): void {
    if (this.active) return;

    if (this.cooldown) this.clear(this.cooldown);
    this.cooldown = null;
    if (this.pending.length === 0) return;

    const remaining = this.nextEligible - this.now();
    if (remaining > 0) {
      this.cooldown = this.schedule(() => {
        this.cooldown = null;
        this.pump();
      }, remaining);
      return;
    }

    const entry = this.pending.shift()!;
    if (entry.signal?.aborted || this.now() >= entry.expiresAt) {
      const code = entry.signal?.aborted ? 'CANCELLED' : 'TIMEOUT';
      this.rejectWaiting(entry, new WebError(code));
      this.pump();
      return;
    }

    this.start(entry);
  }

  private start(entry: Entry): void {
    this.cleanup(entry);
    this.active = entry;
    entry.startedAt = this.now();
    entry.onStart?.(this.waitedMs(entry), this.pending.length + 1);

    void Promise.resolve()
      .then(entry.work)
      .then(
        (value) => {
          this.finish();
          entry.resolve(value);
        },
        (error) => {
          this.finish();
          entry.reject(error);
        },
      );
  }

  /** Release the active slot and schedule the randomized inter-search gap. */
  private finish(): void {
    this.nextEligible = this.now() + this.nextGapMs();
    this.active = null;
    this.pump();
  }

  private nextGapMs(): number {
    // The random source is injected only by trusted composition/tests.
    const fraction = this.random();
    const bounded = Number.isFinite(fraction)
      ? Math.max(0, Math.min(1, fraction))
      : 0;
    const spread = this.policy.maxGapMs - this.policy.minGapMs;

    return this.policy.minGapMs + Math.round(bounded * spread);
  }
}
