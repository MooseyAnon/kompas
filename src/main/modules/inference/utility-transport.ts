import { utilityProcess, type UtilityProcess } from 'electron';
import type { MainToWorkerMessage } from '../../../shared/contracts/inference-worker';
import type { Transport, TransportExitInfo } from './transport';

export interface UtilityTransportOptions {
  /** Absolute path to the built worker entry (`.vite/build/inference-worker.cjs`). */
  workerPath: string;
  /** Extra environment variables passed to the forked worker. */
  env?: Record<string, string>;
}

/**
 * Production transport backed by a real Electron `utilityProcess`. The worker is
 * a separate OS process; a crash surfaces as an `exit` event and never takes
 * down the main process or renderer.
 */
export class UtilityProcessTransport implements Transport {
  private child: UtilityProcess | null = null;
  private messageCb: ((raw: unknown) => void) | null = null;
  private exitCb: ((info: TransportExitInfo) => void) | null = null;

  constructor(private readonly options: UtilityTransportOptions) {}

  start(): void {
    const child = utilityProcess.fork(this.options.workerPath, [], {
      serviceName: 'career-inference-worker',
      env: { ...process.env, ...this.options.env },
      stdio: 'ignore',
    });
    this.child = child;

    child.on('message', (data: unknown) => {
      this.messageCb?.(data);
    });
    child.on('exit', (code: number) => {
      this.exitCb?.({ code });
    });
  }

  send(message: MainToWorkerMessage): void {
    this.child?.postMessage(message);
  }

  onMessage(cb: (raw: unknown) => void): void {
    this.messageCb = cb;
  }

  onExit(cb: (info: TransportExitInfo) => void): void {
    this.exitCb = cb;
  }

  stop(): void {
    try {
      this.child?.kill();
    } catch {
      // best effort
    }

    this.child = null;
  }
}
