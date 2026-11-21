import type {
  MainToWorkerMessage,
  ProviderConfig,
} from '../../../shared/contracts/inference-worker';
import { WorkerRuntime, type ProviderFactory } from './worker-runtime';

export interface TransportExitInfo {
  code: number | null;
}

/**
 * Narrow transport the supervisor talks to. Implementations hide whether the
 * worker is a real Electron utility process or an in-memory test double. All
 * messages are plain structured-clone-safe data.
 */
export interface Transport {
  start(): void;
  send(message: MainToWorkerMessage): void;
  onMessage(cb: (raw: unknown) => void): void;
  onExit(cb: (info: TransportExitInfo) => void): void;
  stop(): void;
}

export interface InMemoryTransportOptions {
  createProvider?: ProviderFactory;
  now?: () => string;
}

/**
 * In-process transport that drives a real {@link WorkerRuntime} without
 * Electron. Messages are JSON round-tripped in both directions to mirror the
 * structured-clone boundary and surface non-serialisable values. Tests can call
 * {@link simulateExit} to model a worker crash.
 */
export class InMemoryTransport implements Transport {
  private runtime: WorkerRuntime | null = null;
  private messageCb: ((raw: unknown) => void) | null = null;
  private exitCb: ((info: TransportExitInfo) => void) | null = null;
  private stopped = false;

  constructor(private readonly options: InMemoryTransportOptions = {}) {}

  start(): void {
    this.runtime = new WorkerRuntime({
      send: (message) => {
        if (this.stopped) {
          return;
        }

        const clone = JSON.parse(JSON.stringify(message));
        queueMicrotask(() => this.messageCb?.(clone));
      },
      createProvider: this.options.createProvider,
      now: this.options.now,
    });
  }

  send(message: MainToWorkerMessage): void {
    if (this.stopped || !this.runtime) {
      return;
    }

    const clone = JSON.parse(JSON.stringify(message));
    queueMicrotask(() => this.runtime?.handle(clone));
  }

  onMessage(cb: (raw: unknown) => void): void {
    this.messageCb = cb;
  }

  onExit(cb: (info: TransportExitInfo) => void): void {
    this.exitCb = cb;
  }

  stop(): void {
    this.stopped = true;
    this.runtime = null;
  }

  /** Model an abnormal worker exit for crash/restart tests. */
  simulateExit(code = 1): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.runtime = null;
    queueMicrotask(() => this.exitCb?.({ code }));
  }
}

/** Default provider configs the supervisor hands the worker (mock, dev-only). */
export function mockProviderConfigs(): ProviderConfig[] {
  return [{ providerId: 'mock', kind: 'mock', dev: true }];
}
