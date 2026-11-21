import {
  updateElectronApp,
  UpdateSourceType,
  type IUpdateElectronApp,
} from 'update-electron-app';
import type { TelemetryService } from '../modules/telemetry/telemetry.service';

const CHECK_TIMEOUT_MS = 2 * 60 * 1000;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
type UpdateEvent =
  | 'error'
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available';

interface UpdateDependencies {
  packaged: boolean;
  platform: string;
  arch: string;
  testing: boolean;
  repository: string | null;
  version: string;
  verifySignature: () => Promise<void>;
  updater: {
    on(event: UpdateEvent, listener: () => void): unknown;
    removeListener(event: UpdateEvent, listener: () => void): unknown;
    quitAndInstall(): void;
  };
  telemetry: Pick<TelemetryService, 'record'>;
  prompt: () => Promise<number>;
  isBusy: () => boolean;
  prepareInstall: () => Promise<void>;
  onReady: () => void;
}

/** Main-process-only stable updater. A downloaded update never implies quit. */
export class AppUpdates {
  private updates?: IUpdateElectronApp;
  private timeout?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private ready = false;
  private prompting = false;
  private installing = false;
  private started = false;
  private readonly listeners: Array<[UpdateEvent, () => void]> = [];

  constructor(private readonly deps: UpdateDependencies) {}

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    const deps = this.deps;
    const enabled =
      deps.packaged &&
      deps.platform === 'darwin' &&
      deps.arch === 'arm64' &&
      !deps.testing &&
      REPOSITORY.test(deps.repository ?? '') &&
      STABLE_VERSION.test(deps.version);

    if (!enabled) {
      this.record('disabled');
      return;
    }

    try {
      await deps.verifySignature();
      if (this.disposed) return;

      this.listen('error', () => {
        this.clearTimeout();
        this.record('check', 'UPDATE_SERVICE_UNAVAILABLE');
      });
      this.listen('checking-for-update', () => {
        this.clearTimeout();
        this.timeout = setTimeout(() => {
          this.record('check', 'UPDATE_TIMEOUT');
        }, CHECK_TIMEOUT_MS);
      });
      this.listen('update-available', () => {
        this.clearTimeout();
        this.record('download');
      });
      this.listen('update-not-available', () => {
        this.clearTimeout();
        this.record('check');
      });

      this.updates = updateElectronApp({
        updateSource: {
          type: UpdateSourceType.ElectronPublicUpdateService,
          repo: deps.repository ?? undefined,
          host: 'https://update.electronjs.org',
        },
        updateInterval: '6 hours',
        // The library's default notifier calls quitAndInstall directly. Our
        // notifier must drain Web/inference before Squirrel closes windows.
        onNotifyUser: () => this.downloaded(),
        // Library log arguments include remote notes/URLs and native errors.
        // Record only the allowlisted events above in local diagnostics.
        logger: {
          log: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });
      if (this.ready) this.updates.stopUpdates();
      this.record('initialise');
    } catch {
      this.record('initialise', 'UPDATE_INITIALISATION_FAILED');
      this.dispose();
    }
  }

  /** Also used by the application menu after Later; never prompts twice at once. */
  async promptToInstall(): Promise<void> {
    if (!this.ready || this.disposed || this.prompting || this.installing)
      return;
    this.prompting = true;

    try {
      const response = await this.deps.prompt();
      if (response !== 0 || this.disposed) return;

      this.installing = true;
      await this.deps.prepareInstall();
      if (this.disposed) return;

      this.record('install');
      this.deps.updater.quitAndInstall();
    } catch {
      this.installing = false;
      this.record('install', 'UPDATE_RESTART_DEFERRED');
    } finally {
      this.prompting = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.updates?.stopUpdates();
    this.clearTimeout();
    for (const [event, listener] of this.listeners) {
      this.deps.updater.removeListener(event, listener);
    }
    this.listeners.length = 0;
  }

  private downloaded(): void {
    if (this.ready || this.disposed) return;
    this.ready = true;
    this.clearTimeout();
    this.updates?.stopUpdates();
    this.record('ready');
    this.deps.onReady();
    if (!this.deps.isBusy()) void this.promptToInstall();
  }

  private listen(event: UpdateEvent, listener: () => void): void {
    this.listeners.push([event, listener]);
    this.deps.updater.on(event, listener);
  }

  private clearTimeout(): void {
    clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  private record(operation: string, errorCode?: string): void {
    this.deps.telemetry.record({
      moduleId: 'system',
      operation: `updates.${operation}`,
      outcome: errorCode ? 'failure' : 'success',
      errorCode,
    });
  }
}
