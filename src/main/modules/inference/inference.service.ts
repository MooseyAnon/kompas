import {
  INFERENCE_MODULE_ID,
  INFERENCE_LIMITS,
  INFERENCE_PROTOCOL_VERSION,
  INFERENCE_TEST_PROMPT,
  inferenceSettingsSchema,
  type CancelResult,
  type GenerationEvent,
  type GenerationResult,
  type HardwareProfile,
  type InferenceOperationSummary,
  type InferenceSettings,
  type InferenceSettingsGetOutput,
  type InferenceSettingsPatch,
  type InferenceTestSnapshot,
  type InferenceStatusGetOutput,
  type ModelDescriptor,
  type ModelDetails,
  type ModelRecommendations,
  type ProviderStatus,
  type WorkerState,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import { collectHardwareProfile } from './hardware';
import { recommendOllamaModels } from './ollama-recommend';
import type { ProviderManager } from './provider-manager';
import type { InferenceSettingsRepository } from './settings.repository';
import type {
  OperationRunWithDetail,
  TelemetryService,
} from '../telemetry/telemetry.service';
import {
  GenerationScheduler,
  type GenerationEntry,
} from './generation-scheduler';
import type { GenerationControls, WorkerSupervisor } from './worker-supervisor';
import type { ToolBroker } from '../../core/tools/tool-broker';
export type { GenerationEntry } from './generation-scheduler';

/** Narrow read-only source of module-scoped telemetry for diagnostics. */
export interface InferenceDiagnosticsSource {
  listByModule(moduleId: string, limit?: number): OperationRunWithDetail[];
}

export interface InferenceServiceDeps {
  supervisor: WorkerSupervisor;
  providers: ProviderManager;
  /** Directory used for the free-disk probe (defaults to the OS temp dir). */
  hardwareProbeDir?: string;
  /** Core tool broker; enables authorised, bounded tool calls when present. */
  toolBroker?: ToolBroker;
  /** Persists local-only inference preferences; in-memory fallback when absent. */
  settingsRepository?: InferenceSettingsRepository;
  /** Read-only telemetry source used to project safe diagnostics. */
  diagnostics?: InferenceDiagnosticsSource;
  /** Privacy-safe scheduler event recorder. */
  telemetry?: TelemetryService;
}

/** Internal bookkeeping for one in-flight connectivity test. */
interface TestRun {
  snapshot: InferenceTestSnapshot;
  controller: AbortController;
}

/** Maximum number of recent connectivity tests retained in memory. */
const MAX_RETAINED_TESTS = 32;
const MODEL_DETAILS_TTL_MS = 60_000;
const MAX_CACHED_MODEL_DETAILS = 32;

/**
 * In-process, provider-neutral inference entry point used by other domain
 * modules through ordinary main-process calls (no same-process IPC hop). It
 * owns the worker supervisor and provider registry; the renderer only ever sees
 * the three narrow, validated status actions, never `generate`.
 */
export class InferenceService {
  private readonly supervisor: WorkerSupervisor;
  private readonly providers: ProviderManager;
  private readonly hardwareProbeDir?: string;
  private readonly toolBroker?: ToolBroker;
  private readonly settingsRepository?: InferenceSettingsRepository;
  private readonly diagnostics?: InferenceDiagnosticsSource;
  private settingsCache: InferenceSettings | null = null;
  private readonly testRuns = new Map<string, TestRun>();
  private readonly scheduler: GenerationScheduler;
  private readonly modelDetails = new Map<
    string,
    { expiresAt: number; result: Promise<ModelDetails | null> }
  >();

  constructor(deps: InferenceServiceDeps) {
    this.supervisor = deps.supervisor;
    this.providers = deps.providers;
    this.hardwareProbeDir = deps.hardwareProbeDir;
    this.toolBroker = deps.toolBroker;
    this.settingsRepository = deps.settingsRepository;
    this.diagnostics = deps.diagnostics;
    this.scheduler = new GenerationScheduler(
      (entry, signal, onEvent, timeoutMs) =>
        this.dispatch(entry, signal, onEvent, timeoutMs),
      deps.telemetry,
    );
  }

  /** Start the supervised worker and take an initial provider-status reading. */
  async start(): Promise<void> {
    await this.supervisor.start();
    await this.refreshStatus();
  }

  async stop(): Promise<void> {
    this.modelDetails.clear();
    this.scheduler.stop();
    await this.supervisor.stop();
  }

  getHardwareProfile(): HardwareProfile {
    return collectHardwareProfile(this.hardwareProbeDir);
  }

  getWorkerState(): WorkerState {
    return this.supervisor.getState();
  }

  listProviders(): ProviderStatus[] {
    return this.providers.listStatuses();
  }

  getProviderStatus(providerId: string): ProviderStatus {
    return this.providers.getStatus(providerId);
  }

  /** Refresh and return a single provider's live health observation. */
  async getProviderHealth(providerId: string): Promise<ProviderStatus> {
    // Validates the provider is registered (throws NOT_FOUND otherwise).
    this.providers.get(providerId);
    const at = new Date().toISOString();
    const observation = await this.supervisor.queryProviderStatus(providerId);
    this.providers.updateObservation(providerId, observation, at);

    return this.providers.getStatus(providerId);
  }

  /** Discover the provider's installed models (empty when unreachable). */
  async listModels(providerId: string): Promise<ModelDescriptor[]> {
    this.providers.get(providerId);
    const models = await this.supervisor.queryModels(providerId);

    return models ?? [];
  }

  /** Bounded, short-lived adapter metadata cache, shared by concurrent callers. */
  async getModelDetails(
    providerId: string,
    modelId: string,
  ): Promise<ModelDetails | null> {
    this.providers.get(providerId);
    const key = JSON.stringify([providerId, modelId]);
    const cached = this.modelDetails.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    if (this.modelDetails.size >= MAX_CACHED_MODEL_DETAILS) {
      const oldest = this.modelDetails.keys().next().value;
      if (oldest) this.modelDetails.delete(oldest);
    }

    const result = this.supervisor.queryModelDetails(providerId, modelId);
    const entry = { expiresAt: Date.now() + MODEL_DETAILS_TTL_MS, result };
    this.modelDetails.set(key, entry);
    const details = await result;
    if (!details && this.modelDetails.get(key) === entry) {
      this.modelDetails.delete(key);
    }

    return details;
  }

  /** Conservative, qualified recommendation over installed local models only. */
  async recommendModels(providerId: string): Promise<ModelRecommendations> {
    this.providers.get(providerId);
    const models = await this.listModels(providerId);

    return recommendOllamaModels(this.getHardwareProfile(), models);
  }

  /**
   * Run a provider-neutral generation. When the caller requests tools and a
   * broker is configured, a bounded, authorised tool run is opened for the
   * request and closed when it settles. A registered tool is never made
   * available to a run unless the caller explicitly selects it *and* is
   * authorised for it.
   */
  generate(entry: GenerationEntry): Promise<GenerationResult> {
    const targetMs =
      this.getSettings().generationTimeoutMs ??
      INFERENCE_LIMITS.defaultTimeoutMs;
    return this.scheduler.submit({
      ...entry,
      limits: {
        ...entry.limits,
        // Trusted callers may supply a shorter hard deadline (e.g. a run's
        // remaining budget); otherwise all generations share the saved target.
        timeoutMs: entry.limits?.timeoutMs ?? targetMs * 2,
      },
    });
  }

  private async dispatch(
    entry: GenerationEntry,
    signal: AbortSignal,
    onEvent: ((event: GenerationEvent) => void) | undefined,
    timeoutMs: number,
  ): Promise<GenerationResult> {
    const {
      callerModule,
      contextId,
      toolPolicy,
      approvalHandler,
      execution: _execution,
      ...base
    } = entry;
    const requestId = entry.requestId!;
    const input = { ...base, requestId, limits: { ...base.limits, timeoutMs } };
    const controls: GenerationControls = { signal, onEvent };

    if (this.toolBroker && entry.toolNames && entry.toolNames.length > 0) {
      const run = this.toolBroker.openRun({
        runId: requestId,
        callerModule,
        contextId,
        requestedToolNames: entry.toolNames,
        policy: toolPolicy,
        approvalHandler,
      });
      try {
        return await this.supervisor.generate(
          {
            ...input,
            tools: run.definitions,
            toolPolicy: run.policy,
          },
          controls,
        );
      } finally {
        this.toolBroker.closeRun(requestId);
      }
    }

    return this.supervisor.generate(input, controls);
  }

  cancel(requestId: string): Promise<CancelResult> {
    return Promise.resolve(this.scheduler.cancel(requestId));
  }

  /** Re-query the worker for each registered provider's live health. */
  async refreshStatus(): Promise<void> {
    const at = new Date().toISOString();
    for (const registration of this.providers.list()) {
      const observation = await this.supervisor.queryProviderStatus(
        registration.providerId,
      );
      this.providers.updateObservation(
        registration.providerId,
        observation,
        at,
      );
    }
  }

  async getStatusSnapshot(): Promise<InferenceStatusGetOutput> {
    await this.refreshStatus();

    return {
      worker: {
        state: this.supervisor.getState(),
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
      },
      providers: this.listProviders(),
    };
  }

  async getProvidersSnapshot(): Promise<ProviderStatus[]> {
    await this.refreshStatus();

    return this.listProviders();
  }

  // --- Local AI preferences (006.4) -----------------------------------------

  private defaultSettings(): InferenceSettings {
    return {
      mode: 'local_only',
      providerId: null,
      modelId: null,
      generationTimeoutMs: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** The current preferences, loading from durable storage once on first use. */
  getSettings(): InferenceSettings {
    if (this.settingsCache) {
      return this.settingsCache;
    }
    const stored = this.settingsRepository?.read() ?? null;
    this.settingsCache = stored ?? this.defaultSettings();

    return this.settingsCache;
  }

  /**
   * Return the saved preferences, the selected model resolved against the
   * provider's live inventory and plain-language, non-sensitive warnings. A
   * selected-but-missing model is reported as a warning; the saved preference is
   * never silently rewritten.
   */
  async getSettingsSnapshot(): Promise<InferenceSettingsGetOutput> {
    const settings = this.getSettings();
    const { resolvedModel, warnings } =
      await this.resolveSelectedModel(settings);

    return { settings, resolvedModel, warnings };
  }

  /**
   * Validate and persist a partial preference update. An absent patch key leaves
   * the field unchanged; an explicit null clears it. Clearing the provider also
   * clears the model selection.
   */
  async updateSettings(
    patch: InferenceSettingsPatch,
  ): Promise<InferenceSettings> {
    const next: InferenceSettings = { ...this.getSettings() };

    if (patch.mode !== undefined) {
      next.mode = patch.mode;
    }

    if ('providerId' in patch) {
      const providerId = patch.providerId ?? null;
      if (providerId !== null && !this.providers.has(providerId)) {
        throw new AppError(
          'INVALID_INPUT',
          'That inference provider is not available.',
        );
      }
      next.providerId = providerId;
    }

    if ('modelId' in patch) {
      next.modelId = patch.modelId ?? null;
    }

    if ('generationTimeoutMs' in patch) {
      next.generationTimeoutMs = patch.generationTimeoutMs ?? null;
    }

    if (next.providerId === null) {
      next.modelId = null;
    }

    if (next.modelId !== null && next.providerId === null) {
      throw new AppError(
        'INVALID_INPUT',
        'Select a provider before choosing a model.',
      );
    }

    next.updatedAt = new Date().toISOString();
    const validated = inferenceSettingsSchema.parse(next);
    this.settingsRepository?.write(validated);
    this.settingsCache = validated;

    return validated;
  }

  // --- Diagnostics -----------------------------------------------------------

  /** Project recent inference telemetry into privacy-safe operation summaries. */
  listDiagnostics(limit?: number): InferenceOperationSummary[] {
    const runs =
      this.diagnostics?.listByModule(INFERENCE_MODULE_ID, limit) ?? [];

    return runs.map(toOperationSummary);
  }

  // --- Opt-in connectivity test ---------------------------------------------

  /**
   * Begin a user-triggered connectivity test against the selected installed
   * local model using the single fixed app prompt. Fails closed when no suitable
   * confirmed-local model is selected. Returns immediately; the renderer polls
   * {@link getTest} for progress and the final outcome.
   */
  async startTest(): Promise<{ testId: string; status: 'started' }> {
    const { providerId, modelId } = await this.requireTestableModel();

    const testId = globalThis.crypto.randomUUID();
    const run: TestRun = {
      controller: new AbortController(),
      snapshot: newTestSnapshot(testId, providerId, modelId),
    };
    this.testRuns.set(testId, run);
    this.pruneTests();

    const startedMs = Date.now();
    let firstTokenMs: number | null = null;
    const finishedTiming = () => ({
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      firstTokenMs,
    });

    void this.generate({
      requestId: testId,
      providerId,
      modelId,
      messages: [{ role: 'user', content: INFERENCE_TEST_PROMPT }],
      telemetryOperation: 'test',
      callerModule: INFERENCE_MODULE_ID,
      execution: {
        priority: 'interactive',
        signal: run.controller.signal,
        onEvent: (event) => {
          if (event.kind === 'delta' && firstTokenMs === null) {
            firstTokenMs = Date.now() - startedMs;
          }
        },
      },
    })
      .then((result) => {
        run.snapshot = {
          ...run.snapshot,
          ...finishedTiming(),
          ...testOutcomeFields(result),
        };
      })
      .catch(() => {
        run.snapshot = {
          ...run.snapshot,
          status: 'failed',
          ...finishedTiming(),
          passed: false,
          errorCode: 'INTERNAL',
        };
      });

    return { testId, status: 'started' };
  }

  /** Current snapshot for a started test. Throws NOT_FOUND when unknown. */
  getTest(testId: string): InferenceTestSnapshot {
    const run = this.testRuns.get(testId);
    if (!run) {
      throw new AppError('NOT_FOUND', 'That test could not be found.');
    }

    return run.snapshot;
  }

  /**
   * Request cancellation of a running test. Idempotent: returns false if the
   * test has already settled. Throws NOT_FOUND for an unknown test id.
   */
  async cancelTest(testId: string): Promise<boolean> {
    const run = this.testRuns.get(testId);
    if (!run) {
      throw new AppError('NOT_FOUND', 'That test could not be found.');
    }
    if (run.snapshot.status !== 'running') {
      return false;
    }

    run.controller.abort();
    await this.cancel(testId);

    return true;
  }

  /**
   * Resolve the saved selection for a warnings-only snapshot. A
   * selected-but-missing model is reported, never silently rewritten.
   */
  private async resolveSelectedModel(settings: InferenceSettings): Promise<{
    resolvedModel: ModelDescriptor | null;
    warnings: string[];
  }> {
    const { providerId, modelId } = settings;

    if (!providerId) {
      return { resolvedModel: null, warnings: [] };
    }

    if (!this.providers.has(providerId)) {
      return {
        resolvedModel: null,
        warnings: [
          `The saved provider "${providerId}" is not available in this build.`,
        ],
      };
    }

    if (!modelId) {
      return { resolvedModel: null, warnings: ['No model is selected yet.'] };
    }

    const models = await this.listModels(providerId);
    const match = models.find((m) => m.id === modelId) ?? null;
    if (!match) {
      return {
        resolvedModel: null,
        warnings: [
          `The selected model "${modelId}" is not currently installed. ` +
            'It stays saved and will be used again if reinstalled.',
        ],
      };
    }

    const warnings = isInstalledLocalModel(match)
      ? []
      : [`The selected model "${modelId}" is not a confirmed local model.`];

    return { resolvedModel: match, warnings };
  }

  /** The saved provider/model, provided it is an installed local model. */
  private async requireTestableModel(): Promise<{
    providerId: string;
    modelId: string;
  }> {
    const { providerId, modelId } = this.getSettings();
    if (!providerId || !modelId) {
      throw new AppError(
        'CONFLICT',
        'Select an installed local model before running a test.',
      );
    }

    if (!this.providers.has(providerId)) {
      throw new AppError('CONFLICT', 'The selected provider is not available.');
    }

    const models = await this.listModels(providerId);
    const model = models.find((m) => m.id === modelId) ?? null;
    if (!model || !isInstalledLocalModel(model)) {
      throw new AppError(
        'CONFLICT',
        'The selected model is not an installed local model.',
      );
    }

    return { providerId, modelId };
  }

  private pruneTests(): void {
    while (this.testRuns.size > MAX_RETAINED_TESTS) {
      const oldest = this.testRuns.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.testRuns.delete(oldest);
    }
  }
}

/** Characters of a successful test reply kept for the UI preview. */
const TEST_REPLY_PREVIEW_CHARS = 200;

function isInstalledLocalModel(model: ModelDescriptor): boolean {
  return model.installed && model.locality === 'local';
}

function newTestSnapshot(
  testId: string,
  providerId: string,
  modelId: string,
): InferenceTestSnapshot {
  return {
    testId,
    status: 'running',
    providerId,
    modelId,
    prompt: INFERENCE_TEST_PROMPT,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    firstTokenMs: null,
    passed: null,
    replyPreview: null,
    errorCode: null,
  };
}

function replyText(output: GenerationResult['output']): string {
  if (typeof output === 'string') {
    return output;
  }

  return output == null ? '' : JSON.stringify(output);
}

/** Outcome fields of a settled test; it passes on any non-blank reply. */
function testOutcomeFields(
  result: GenerationResult,
): Pick<
  InferenceTestSnapshot,
  'status' | 'passed' | 'replyPreview' | 'errorCode'
> {
  const completed = result.status === 'completed';
  const reply = replyText(result.output);

  return {
    status: result.status,
    passed: completed ? reply.trim().length > 0 : false,
    replyPreview: completed ? reply.slice(0, TEST_REPLY_PREVIEW_CHARS) : null,
    errorCode: result.error?.code ?? null,
  };
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function toOperationSummary(
  run: OperationRunWithDetail,
): InferenceOperationSummary {
  const detail = run.detail ?? {};
  return {
    id: run.id,
    operation: run.operation,
    status: run.outcome,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    firstTokenMs: safeCount(detail.firstTokenMs),
    providerId: safeString(detail.providerId),
    modelId: safeString(detail.modelId),
    inputTokens: safeCount(detail.inputTokens),
    outputTokens: safeCount(detail.outputTokens),
    toolCalls: safeCount(detail.toolCalls),
    errorCode: run.errorCode,
  };
}
