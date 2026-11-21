import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import {
  createAppDispatcher,
  type AppServices,
  type DocumentsPlatform,
} from './core/registry';
import { openStorage, type Storage } from './core/storage';
import {
  finishPendingReset,
  requestStorageReset,
  validateResetTargets,
} from './core/storage-maintenance';
import { AppError } from './ipc/errors';
import { resolveDataDir, resolveStorageLayout } from './core/paths';
import { ProviderManager } from './modules/inference/provider-manager';
import { WorkerSupervisor } from './modules/inference/worker-supervisor';
import { UtilityProcessTransport } from './modules/inference/utility-transport';
import { InferenceService } from './modules/inference/inference.service';
import { InferenceSettingsRepository } from './modules/inference/settings.repository';
import { MOCK_PROVIDER_ID } from './modules/inference/mock-provider';
import { ToolRegistry } from './core/tools/tool-registry';
import { ToolBroker } from './core/tools/tool-broker';
import { registerExampleTools } from './core/tools/example-tools';
import {
  OLLAMA_DEFAULT_ENDPOINT,
  OLLAMA_PROVIDER_ID,
} from './modules/inference/ollama-provider';
import { JsonlLogger } from './modules/telemetry/jsonl-log';
import { TelemetryRepository } from './modules/telemetry/telemetry.repository';
import { TelemetryService } from './modules/telemetry/telemetry.service';
import { createDefaultWebService } from './modules/web/composition';
import { windowChromeFor } from './window-chrome';
import {
  buildFailure,
  coerceCorrelationId,
  type Dispatcher,
} from './ipc/dispatcher';
import {
  isAuthorisedSender,
  senderInfoFromEvent,
} from './ipc/sender-validation';
import {
  allowedUrlPrefixes as computeAllowedUrlPrefixes,
  contentSecurityPolicy,
  navigationDecision,
  resolveWindowOpen,
} from './security/web-policy';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const REQUEST_CHANNEL = 'career:request';
const RESET_DRAIN_TIMEOUT_MS = 15_000;
const RESET_DRAIN_POLL_INTERVAL_MS = 100;
const RESET_RESTART_DELAY_MS = 150;
const WORKER_STATUS_TIMEOUT_MS = 6_000;

const DEV_SERVER_URL = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? undefined;
const IS_DEV = Boolean(DEV_SERVER_URL);

// SQLite already uses a separate development identity. Keep Chromium's default
// session in that same identity too, so clearing dev session data cannot touch
// an installed app's Electron session under its ordinary userData directory.
if (!app.isPackaged) {
  const devDataDir = resolveDataDir(app.getPath('userData'), false);
  fs.mkdirSync(devDataDir, { recursive: true });
  validateResetTargets(devDataDir);
  app.setPath('sessionData', devDataDir);
}

let mainWindow: BrowserWindow | null = null;
let activeStorage: Storage | null = null;
let storageReady = false;
let dispatcher: Dispatcher | null = null;
let activeRequests = 0;

let inferenceService: InferenceService | null = null;
let webService: ReturnType<typeof createDefaultWebService> | null = null;
let webShutdownStarted = false;

let resetPending = false;
let resetBootFailed = false;
const busyChecks: Array<() => boolean> = [];

function createFallbackLogger(dataDir: string): JsonlLogger | undefined {
  try {
    const layout = resolveStorageLayout(dataDir);
    fs.mkdirSync(layout.logsDir, { recursive: true });

    return new JsonlLogger(layout.appLogFile);
  } catch {
    // No writable log location; telemetry degrades to a no-op.
    return undefined;
  }
}

/**
 * Initialise durable local storage and telemetry on boot. Storage readiness is
 * reported honestly: if initialisation fails, the app still runs with
 * `storageReady = false` and the failure is recorded to the JSONL log.
 */
function bootStorageAndTelemetry(): TelemetryService {
  const dataDir = resolveDataDir(app.getPath('userData'), app.isPackaged);
  const startedMs = Date.now();

  try {
    if (resetBootFailed) {
      throw new Error('Pending reset could not be completed');
    }

    const storage = openStorage(dataDir);
    activeStorage = storage;
    storageReady = true;

    const telemetry = new TelemetryService({
      repository: new TelemetryRepository(storage.db),
      logger: new JsonlLogger(storage.layout.appLogFile),
    });
    telemetry.recordBoot('success', {
      durationMs: Date.now() - startedMs,
      detail: {
        schemaVersion: storage.migration.currentVersion,
        migrationsApplied: storage.migration.appliedVersions.length,
      },
    });

    return telemetry;
  } catch {
    storageReady = false;

    if (resetBootFailed) {
      return new TelemetryService({});
    }

    const logger = createFallbackLogger(dataDir);
    const telemetry = new TelemetryService({ logger });
    telemetry.recordBoot('failure', {
      durationMs: Date.now() - startedMs,
      errorCode: 'IO_ERROR',
    });

    return telemetry;
  }
}

/** URL prefixes that identify our own application origin. */
function allowedUrlPrefixes(): string[] {
  return computeAllowedUrlPrefixes(DEV_SERVER_URL);
}

/** Content Security Policy. Production is strict; dev relaxes for Vite HMR only. */
function appContentSecurityPolicy(): string {
  return contentSecurityPolicy(IS_DEV);
}

function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [appContentSecurityPolicy()],
      },
    });
  });
}

/**
 * Permission policy for privileged web capabilities. Only microphone capture is
 * ever granted, only to our own trusted window, and only when the renderer
 * explicitly requests it (on the user's Record action). Camera, geolocation,
 * notifications and every other capability are denied. This is the OS-facing
 * gate that complements the per-call IPC sender validation.
 */
function isMicrophoneRequest(
  contents: Electron.WebContents,
  permission: string,
  mediaTypes: string[] | undefined,
): boolean {
  if (contents.id !== mainWindow?.webContents.id) {
    return false;
  }

  if (permission !== 'media' && permission !== 'audioCapture') {
    return false;
  }

  // For a generic `media` request the caller must ask for audio only.
  if (mediaTypes && mediaTypes.includes('video')) {
    return false;
  }

  return true;
}

function installMediaPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
      callback(isMicrophoneRequest(contents, permission, mediaTypes));
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) => {
      if (!contents) {
        return false;
      }

      const mediaType = details.mediaType;
      const mediaTypes = mediaType === 'video' ? ['video'] : undefined;

      return isMicrophoneRequest(contents, permission, mediaTypes);
    },
  );
}

/** Deny navigation away from the app origin and block all new windows/webviews. */
function hardenWebContents(contents: Electron.WebContents): void {
  const prefixes = allowedUrlPrefixes();

  contents.on('will-navigate', (event, targetUrl) => {
    if (navigationDecision(targetUrl, prefixes) === 'block') {
      event.preventDefault();
    }
  });

  // Deny in-app windows/webviews. A safe public http(s) link (explicit user
  // click on a search result) is opened in the OS default browser instead.
  contents.setWindowOpenHandler((details) => {
    const decision = resolveWindowOpen(details.url);

    if (decision.externalUrl) {
      void shell.openExternal(decision.externalUrl);
    }

    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...windowChromeFor(process.platform),
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Career Workspace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  hardenWebContents(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

function registerIpc(): void {
  ipcMain.handle(REQUEST_CHANNEL, async (event, raw) => {
    const expectedId = mainWindow?.webContents.id;
    const expectedMainFrameId =
      mainWindow?.webContents.mainFrame.frameTreeNodeId;

    const authorised =
      expectedId !== undefined &&
      isAuthorisedSender(senderInfoFromEvent(event, expectedMainFrameId), {
        expectedWebContentsId: expectedId,
        allowedUrlPrefixes: allowedUrlPrefixes(),
      });

    if (!authorised) {
      return buildFailure(coerceCorrelationId(raw), 'PERMISSION_DENIED');
    }

    if (!dispatcher) {
      return buildFailure(coerceCorrelationId(raw), 'INTERNAL');
    }

    if (resetPending) {
      return buildFailure(
        coerceCorrelationId(raw),
        'CONFLICT',
        'Application data is being reset. Wait for the restart.',
      );
    }

    activeRequests += 1;

    try {
      return await dispatcher.dispatch(raw);
    } finally {
      activeRequests -= 1;
    }
  });
}

async function startReset(): Promise<void> {
  if (resetPending || busyChecks.some((check) => check())) {
    throw new AppError(
      'CONFLICT',
      'Another operation or recording is active. Finish it before resetting.',
    );
  }

  const dataDir = resolveDataDir(app.getPath('userData'), app.isPackaged);

  try {
    validateResetTargets(dataDir);
  } catch {
    throw new AppError(
      'CONFLICT',
      'Storage ownership or permissions could not be verified. Reset was refused.',
    );
  }

  resetPending = true;

  try {
    // The reset request itself must remain active. Keep the wait inline so an
    // already-drained reset reaches shutdown without an extra async boundary.
    const deadline = Date.now() + RESET_DRAIN_TIMEOUT_MS;

    while (activeRequests !== 1 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, RESET_DRAIN_POLL_INTERVAL_MS),
      );
    }

    if (activeRequests !== 1 || busyChecks.some((check) => check())) {
      throw new AppError(
        'CONFLICT',
        'Another operation is still active. Finish it and try again.',
      );
    }

    await webService?.shutdown();
    webShutdownStarted = true;
    await inferenceService?.stop();
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    requestStorageReset(dataDir);
    activeStorage?.close();
    activeStorage = null;
    storageReady = false;
  } catch (error) {
    resetPending = false;

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      'IO_ERROR',
      'Reset could not safely stop storage. Restart the app and try again.',
    );
  }

  setTimeout(() => {
    app.relaunch();
    app.quit();
  }, RESET_RESTART_DELAY_MS);
}

app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents);
});

/**
 * Locate the bundled, trusted offline speech-to-text resources (the pinned
 * `whisper-cli` executable, the `ggml-base.bin` model and their manifest). In
 * the packaged app these live outside the ASAR under `Contents/Resources/
 * whisper`; in development they are the repo's `resources/whisper`. The path is
 * always app-controlled and never depends on the current working directory.
 */
function resolveWhisperResourcesDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(app.getAppPath(), 'resources', 'whisper');
}

/**
 * Native picker/opener for the documents module. The main process owns file
 * selection and opening; the renderer never supplies or receives a path.
 *
 * Smoke-test seam: when `CAREER_SMOKE=1` the picker returns a pre-set absolute
 * path (`CAREER_SMOKE_PICK_FILE`) instead of showing a GUI dialog, and `openPath`
 * verifies the managed file exists without launching an external application, so
 * the stage-004 packaged smoke test can run unattended. This never widens the
 * renderer boundary: the renderer still cannot supply or read any path, and the
 * env flag is only honoured for the local, developer-launched smoke harness.
 */
function createDocumentsPlatform(): DocumentsPlatform {
  if (process.env.CAREER_SMOKE === '1') {
    return {
      async pickFile(): Promise<string | null> {
        const file = process.env.CAREER_SMOKE_PICK_FILE;

        return file && fs.existsSync(file) ? file : null;
      },

      async openPath(absolutePath: string): Promise<string> {
        return fs.existsSync(absolutePath) ? '' : 'missing managed file';
      },
    };
  }

  return {
    async pickFile(): Promise<string | null> {
      if (!mainWindow) {
        return null;
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import a document',
        properties: ['openFile'],
        filters: [{ name: 'Documents', extensions: ['pdf', 'docx'] }],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    },

    openPath(absolutePath: string): Promise<string> {
      return shell.openPath(absolutePath);
    },
  };
}

function createInferenceProviders(devActions: boolean): ProviderManager {
  const providers = new ProviderManager();

  if (devActions) {
    providers.register({
      providerId: MOCK_PROVIDER_ID,
      kind: 'mock',
      configured: true,
      dev: true,
    });
  }

  // The Ollama adapter is always registered; it reports its own health and
  // model inventory and is a no-op clean-slate state when Ollama is absent.
  providers.register({
    providerId: OLLAMA_PROVIDER_ID,
    kind: 'ollama',
    configured: true,
    dev: false,
    endpoint: OLLAMA_DEFAULT_ENDPOINT,
  });

  return providers;
}

/**
 * Build the supervised inference service. The real Electron `utilityProcess`
 * worker is forked from the built sibling bundle (`inference-worker.cjs`). The
 * deterministic mock provider and the dev self-test actions are registered only
 * behind an explicit flag (set by the packaged smoke harness), so ordinary
 * end users see a supervised worker with no selectable mock model.
 */
function createInferenceService(
  telemetry: TelemetryService,
  dataDir: string,
  settingsRepository?: InferenceSettingsRepository,
): { service: InferenceService; devActions: boolean } {
  const devActions =
    process.env.CAREER_SMOKE === '1' ||
    process.env.CAREER_ENABLE_MOCK_PROVIDER === '1';
  const providers = createInferenceProviders(devActions);

  // Tool registry/broker live in the main-process core. Synthetic example tools
  // are registered ONLY behind the dev/smoke flag, so they are unreachable in
  // ordinary production use. No production write/browser/search tools exist.
  const toolRegistry = new ToolRegistry();

  if (devActions) {
    registerExampleTools(toolRegistry);
  }

  const toolBroker = new ToolBroker({ registry: toolRegistry, telemetry });

  const workerPath = path.join(__dirname, 'inference-worker.cjs');
  const supervisor = new WorkerSupervisor({
    createTransport: () =>
      new UtilityProcessTransport({
        workerPath,
        env: devActions ? { CAREER_INFERENCE_DEV: '1' } : {},
      }),
    providerConfigs: providers.workerConfigs(),
    telemetry,
    statusTimeoutMs: WORKER_STATUS_TIMEOUT_MS,
    toolExecutor: toolBroker,
  });

  const service = new InferenceService({
    supervisor,
    providers,
    hardwareProbeDir: dataDir,
    toolBroker,
    settingsRepository,
    diagnostics: telemetry,
    telemetry,
  });

  return { service, devActions };
}

function createMainDispatcher(
  telemetry: TelemetryService,
  dataDir: string,
  inference: ReturnType<typeof createInferenceService>,
  web: NonNullable<AppServices['web']>,
): Dispatcher {
  const storage: AppServices['storage'] = activeStorage
    ? {
        db: activeStorage.db,
        fileStore: activeStorage.fileStore,
        audioFileStore: activeStorage.audioFileStore,
        audioStagingDir: activeStorage.audioStagingDir,
      }
    : undefined;

  const documentsPlatform = createDocumentsPlatform();
  const audioTranscription = { resourcesDir: resolveWhisperResourcesDir() };
  const maintenance: AppServices['maintenance'] =
    !resetBootFailed && activeStorage
      ? {
          dataDir,
          reset: startReset,
          registerBusy: (check) => busyChecks.push(check),
        }
      : undefined;

  return createAppDispatcher({
    getAppVersion: () => app.getVersion(),
    isStorageReady: () => storageReady,
    telemetry,
    storage,
    documentsPlatform,
    inference: { service: inference.service, devActions: inference.devActions },
    audioTranscription,
    web,
    maintenance,
  });
}

function startApplication(): void {
  const dataDir = resolveDataDir(app.getPath('userData'), app.isPackaged);

  try {
    finishPendingReset(dataDir);
  } catch {
    resetBootFailed = true;
  }

  const telemetry = bootStorageAndTelemetry();
  const settingsRepository = activeStorage
    ? new InferenceSettingsRepository(activeStorage.db)
    : undefined;
  const inference = createInferenceService(
    telemetry,
    dataDir,
    settingsRepository,
  );
  inferenceService = inference.service;

  // Start the worker in the background; status is reported honestly as it boots.
  inference.service.start().catch(() => {
    /* worker failures are surfaced via status, never crash the app */
  });

  webService = createDefaultWebService({ telemetry });
  dispatcher = createMainDispatcher(telemetry, dataDir, inference, webService);

  installContentSecurityPolicy();
  installMediaPermissionHandlers();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.whenReady().then(startApplication);

app.on('before-quit', (event) => {
  if (!webService || webShutdownStarted) {
    return;
  }

  event.preventDefault();
  webShutdownStarted = true;
  void webService
    .shutdown()
    .catch(() => {})
    .finally(() => app.quit());
});

app.on('will-quit', () => {
  void inferenceService?.stop();
  inferenceService = null;
  activeStorage?.close();
  activeStorage = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
