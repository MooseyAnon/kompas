import {
  INFERENCE_LIMITS,
  INFERENCE_PROTOCOL_VERSION,
  generationRequestSchema,
  type CancelResult,
  type GenerationEvent,
  type GenerationRequestInput,
  type GenerationResult,
  type InferenceErrorCode,
  type ModelDescriptor,
  type ProviderCapabilities,
  type ProviderState,
  type ToolCall,
  type ToolDefinition,
  type ToolInvocation,
  type ToolPolicy,
  type ToolResult,
  type WorkerState,
} from '../../../shared/contracts';
import {
  workerToMainMessageSchema,
  type MainToWorkerMessage,
  type ProviderConfig,
  type WorkerToMainMessage,
} from '../../../shared/contracts/inference-worker';
import type { Transport } from './transport';
import type { GenerationEventMessageSchemaPayload } from './runtime-types';
import type { TelemetryService } from '../telemetry/telemetry.service';
import type { ToolExecutor } from '../../core/tools/tool-broker';

export interface GenerationControls {
  signal?: AbortSignal;
  onEvent?: (event: GenerationEvent) => void;
}

/** Tool inputs resolved by the broker and forwarded to the worker/provider. */
export interface GenerationToolInputs {
  tools?: ToolDefinition[];
  toolPolicy?: ToolPolicy;
}

export type SupervisorGenerationInput = GenerationRequestInput &
  GenerationToolInputs & {
    /** Telemetry operation label for this run (defaults to `generation`). */
    telemetryOperation?: string;
  };

export interface WorkerProviderObservation {
  state: ProviderState;
  capabilities: ProviderCapabilities;
  runtimeVersion: string | null;
  messageCode?: string;
}

export interface WorkerSupervisorOptions {
  createTransport: () => Transport;
  providerConfigs: ProviderConfig[];
  telemetry?: TelemetryService;
  now?: () => string;
  startupTimeoutMs?: number;
  statusTimeoutMs?: number;
  maxInFlightPerProvider?: number;
  maxQueued?: number;
  /** Authorises and runs provider-proposed tool calls for an active run. */
  toolExecutor?: ToolExecutor;
}

type ValidatedGenerationRequest = ReturnType<
  typeof generationRequestSchema.parse
>;

/** The identifiers every generation result carries. */
interface GenerationIdentity {
  requestId: string;
  providerId: string;
  modelId: string;
}

interface PendingGeneration {
  input: GenerationIdentity;
  transport: Transport;
  lastSeq: number;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onEvent?: (event: GenerationEvent) => void;
  resolve: (result: GenerationResult) => void;
  detachAbort?: () => void;
  startedAt: number;
  firstTokenMs: number | null;
  operationLabel: string;
  toolCalls: ToolCall[];
}

/** Resolver for a correlated worker query; `null` means no usable answer. */
type QueryResolver<T> = (value: T | null) => void;

type ToolExecutionRequestMessage = Extract<
  WorkerToMainMessage,
  { kind: 'tool.execution.request' }
>;

type GenerationEventMessage = Extract<
  WorkerToMainMessage,
  { kind: 'generation.event' }
>;

/** Number of settled request ids remembered for `already_finished` answers. */
const FINISHED_CACHE_CAP = 256;

const DEFAULT_STATUS_TIMEOUT_MS = 2_000;

const DEFAULT_TELEMETRY_OPERATION = 'generation';

const MESSAGES = {
  invalidRequest: 'The generation request was invalid.',
  workerUnavailable: 'The inference worker is unavailable.',
  overCapacity: 'Too many inference requests are queued.',
  timedOut: 'The inference request timed out.',
  workerStopped: 'The inference worker was stopped.',
  workerExited: 'The inference worker exited.',
  noActiveRun: 'No active run for this tool call.',
  toolsUnavailable: 'Tools are not available.',
  brokerFailed: 'The tool broker failed.',
} as const;

/**
 * Supervises exactly one inference worker over a {@link Transport}. Owns the
 * startup handshake, request correlation, bounded per-provider concurrency,
 * timeouts, cancellation, crash detection and lazy restart. A worker crash
 * fails in-flight calls with a safe code and never crashes the main process.
 */
export class WorkerSupervisor {
  private readonly createTransport: () => Transport;
  private readonly providerConfigs: ProviderConfig[];
  private readonly telemetry?: TelemetryService;
  private readonly now: () => string;
  private readonly startupTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly maxInFlightPerProvider: number;
  private readonly maxQueued: number;
  private readonly toolExecutor?: ToolExecutor;

  private transport: Transport | null = null;
  private state: WorkerState = 'stopped';
  private explicitlyStopped = false;
  private currentLifecycleId: string | null = null;
  private startPromise: Promise<void> | null = null;
  private readyResolver: ((ok: boolean) => void) | null = null;
  private shutdownResolver: (() => void) | null = null;

  private readonly pendingGenerations = new Map<string, PendingGeneration>();
  private readonly pendingStatus = new Map<
    string,
    QueryResolver<WorkerProviderObservation>
  >();
  private readonly pendingModels = new Map<
    string,
    QueryResolver<ModelDescriptor[]>
  >();
  private readonly finished = new Set<string>();

  private readonly inFlight = new Map<string, number>();
  private readonly waiters: Array<{ providerId: string; resolve: () => void }> =
    [];

  constructor(options: WorkerSupervisorOptions) {
    this.createTransport = options.createTransport;
    this.providerConfigs = options.providerConfigs;
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => new Date().toISOString());
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? INFERENCE_LIMITS.startupTimeoutMs;
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    this.maxInFlightPerProvider =
      options.maxInFlightPerProvider ?? INFERENCE_LIMITS.maxInFlightPerProvider;
    this.maxQueued = options.maxQueued ?? INFERENCE_LIMITS.maxQueued;
    this.toolExecutor = options.toolExecutor;
  }

  getState(): WorkerState {
    return this.state;
  }

  getProtocolVersion(): typeof INFERENCE_PROTOCOL_VERSION {
    return INFERENCE_PROTOCOL_VERSION;
  }

  /** Start (or restart) the worker and await its ready handshake. */
  async start(): Promise<void> {
    this.explicitlyStopped = false;

    if (this.state === 'ready') {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = null;
      });
    }

    await this.startPromise;
  }

  /** Gracefully shut the worker down; idempotent. */
  async stop(): Promise<void> {
    this.explicitlyStopped = true;

    const transport = this.transport;
    if (!transport || this.state === 'stopped') {
      this.state = 'stopped';
      return;
    }

    const lifecycleId = newId();
    const stopped = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, INFERENCE_LIMITS.shutdownTimeoutMs);
      this.shutdownResolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    try {
      transport.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'worker.shutdown',
        lifecycleId,
        payload: {},
      });
      await stopped;
    } catch {
      // fall through to teardown
    }

    this.shutdownResolver = null;
    this.failAllPending('WORKER_EXITED', MESSAGES.workerStopped);
    this.flushWaiters();
    this.teardown(transport);
    this.state = 'stopped';
  }

  async generate(
    input: SupervisorGenerationInput,
    controls: GenerationControls = {},
  ): Promise<GenerationResult> {
    const requestId = input.requestId ?? newId();
    const parsed = generationRequestSchema.safeParse({ ...input, requestId });
    if (!parsed.success) {
      const identity = {
        requestId,
        providerId: input.providerId ?? 'unknown',
        modelId: input.modelId ?? 'unknown',
      };
      return failedResult(identity, 'INTERNAL', MESSAGES.invalidRequest);
    }

    const request = parsed.data;
    const identity = identityOf(request);

    await this.ensureReady();
    if (!this.hasReadyTransport()) {
      return workerUnavailableResult(identity);
    }

    if (controls.signal?.aborted) {
      return cancelledResult(identity);
    }

    const { providerId } = request;
    if (!this.acquire(providerId)) {
      if (this.waiters.length >= this.maxQueued) {
        return failedResult(identity, 'OVER_CAPACITY', MESSAGES.overCapacity);
      }

      await this.waitForReleasedSlot(providerId);
    }

    try {
      if (controls.signal?.aborted) {
        return cancelledResult(identity);
      }

      if (!this.hasReadyTransport()) {
        return workerUnavailableResult(identity);
      }

      // Tool definitions/policy are resolved by the broker (not part of the
      // public generation schema) and carried alongside the validated request.
      const toolInputs: GenerationToolInputs = {
        tools: input.tools,
        toolPolicy: input.toolPolicy,
      };
      const operationLabel =
        input.telemetryOperation ?? DEFAULT_TELEMETRY_OPERATION;

      return await this.runGeneration(
        request,
        toolInputs,
        controls,
        operationLabel,
      );
    } finally {
      this.release(providerId);
    }
  }

  async cancel(requestId: string): Promise<CancelResult> {
    if (this.pendingGenerations.has(requestId)) {
      this.requestCancel(requestId);
      return { requestId, outcome: 'cancelled' };
    }

    return {
      requestId,
      outcome: this.finished.has(requestId) ? 'already_finished' : 'not_found',
    };
  }

  /** Query the worker for a provider's live health/capabilities. */
  async queryProviderStatus(
    providerId: string,
  ): Promise<WorkerProviderObservation | null> {
    return this.queryWorker(this.pendingStatus, 'provider.status', providerId);
  }

  /** Query the worker for a provider's installed model descriptors. */
  async queryModels(providerId: string): Promise<ModelDescriptor[] | null> {
    return this.queryWorker(this.pendingModels, 'provider.models', providerId);
  }

  // --- lifecycle ------------------------------------------------------------

  private async doStart(): Promise<void> {
    const startedMs = Date.now();
    this.state = 'starting';

    const transport = this.createTransport();
    const lifecycleId = newId();
    this.transport = transport;
    this.currentLifecycleId = lifecycleId;
    this.attachTransportListeners(transport);

    try {
      transport.start();
      transport.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'worker.init',
        lifecycleId,
        payload: { providers: this.providerConfigs },
      });
    } catch {
      this.state = 'unavailable';
      this.teardown(transport);
      this.recordWorker('worker.start', 'failure', 'INTERNAL', startedMs);
      return;
    }

    const ready = await this.awaitReadyHandshake();

    if (ready && this.transport === transport) {
      this.state = 'ready';
      this.recordWorker('worker.start', 'success', null, startedMs);
      return;
    }

    this.state = 'unavailable';
    this.teardown(transport);
    this.recordWorker(
      'worker.start',
      'failure',
      'WORKER_UNAVAILABLE',
      startedMs,
    );
  }

  /** Route messages and exits only while `transport` is the current one. */
  private attachTransportListeners(transport: Transport): void {
    transport.onMessage((raw) => {
      if (this.transport === transport) {
        this.onWorkerMessage(raw);
      }
    });

    transport.onExit(() => {
      if (this.transport === transport) {
        this.onWorkerExit();
      }
    });
  }

  /** Resolves `true` on `worker.ready`, `false` on failure or timeout. */
  private awaitReadyHandshake(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.readyResolver = null;
        resolve(false);
      }, this.startupTimeoutMs);

      this.readyResolver = (ok) => {
        clearTimeout(timer);
        this.readyResolver = null;
        resolve(ok);
      };
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.explicitlyStopped || this.state === 'ready') {
      return;
    }

    await this.start();
  }

  private hasReadyTransport(): boolean {
    return this.state === 'ready' && this.transport !== null;
  }

  private teardown(transport: Transport): void {
    try {
      transport.stop();
    } catch {
      // best effort
    }

    if (this.transport === transport) {
      this.transport = null;
    }
  }

  // --- generation -----------------------------------------------------------

  private runGeneration(
    request: ValidatedGenerationRequest,
    toolInputs: GenerationToolInputs,
    controls: GenerationControls,
    operationLabel: string,
  ): Promise<GenerationResult> {
    const transport = this.transport!;
    const timeoutMs =
      request.limits?.timeoutMs ?? INFERENCE_LIMITS.defaultTimeoutMs;
    const { requestId } = request;

    return new Promise<GenerationResult>((resolve) => {
      const pending: PendingGeneration = {
        input: identityOf(request),
        transport,
        lastSeq: 0,
        settled: false,
        onEvent: controls.onEvent,
        resolve,
        startedAt: Date.now(),
        firstTokenMs: null,
        operationLabel,
        toolCalls: [],
        timer: setTimeout(() => this.onGenerationTimeout(requestId), timeoutMs),
      };

      if (controls.signal) {
        const signal = controls.signal;
        const onAbort = () => this.requestCancel(requestId);
        signal.addEventListener('abort', onAbort, { once: true });
        pending.detachAbort = () =>
          signal.removeEventListener('abort', onAbort);
      }

      this.pendingGenerations.set(requestId, pending);

      if (controls.signal?.aborted) {
        this.requestCancel(requestId);
        return;
      }

      try {
        sendGenerationStart(transport, request, toolInputs);
      } catch {
        this.settleGeneration(
          requestId,
          workerUnavailableResult(pending.input),
        );
      }
    });
  }

  private onGenerationEvent(message: GenerationEventMessage): void {
    const pending = this.pendingGenerations.get(message.requestId);
    const isCurrent =
      pending !== undefined &&
      pending.transport === this.transport &&
      !pending.settled;
    if (!isCurrent) {
      return;
    }

    if (message.seq <= pending.lastSeq) {
      return; // out-of-order or duplicate
    }

    pending.lastSeq = message.seq;
    const { requestId, seq, payload } = message;

    // Reasoning (`thinking_delta`) is not the first answer token.
    if (payload.eventKind === 'delta' && pending.firstTokenMs === null) {
      pending.firstTokenMs = Date.now() - pending.startedAt;
    }

    if (payload.eventKind === 'tool_request') {
      pending.toolCalls = payload.toolCalls;
    }

    pending.onEvent?.(toGenerationEvent(requestId, seq, this.now(), payload));

    const terminalResult = toTerminalResult(pending, payload);
    if (terminalResult) {
      this.settleGeneration(requestId, terminalResult);
    }
  }

  private onGenerationTimeout(requestId: string): void {
    const pending = this.pendingGenerations.get(requestId);
    if (!pending || pending.settled) {
      return;
    }

    try {
      this.transport?.send(generationCancelMessage(requestId));
    } catch {
      // The timeout result is still authoritative if the transport has exited.
    }

    pending.lastSeq += 1;
    pending.onEvent?.({
      kind: 'failed',
      requestId,
      seq: pending.lastSeq,
      at: this.now(),
      error: { code: 'TIMEOUT', message: MESSAGES.timedOut },
    });
    this.settleGeneration(
      requestId,
      failedResult(pending.input, 'TIMEOUT', MESSAGES.timedOut),
    );
  }

  private requestCancel(requestId: string): void {
    const pending = this.pendingGenerations.get(requestId);
    if (!pending || !this.transport) {
      return;
    }

    try {
      this.transport.send(generationCancelMessage(requestId));
    } catch {
      // Still release capacity and discard late messages.
    }

    // Settle immediately: an unresponsive worker must not retain capacity, and
    // late events must not turn an aborted request into a success.
    this.settleGeneration(requestId, cancelledResult(pending.input));
  }

  private settleGeneration(requestId: string, result: GenerationResult): void {
    const pending = this.pendingGenerations.get(requestId);
    if (!pending || pending.settled) {
      return;
    }

    pending.settled = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.detachAbort?.();

    this.pendingGenerations.delete(requestId);
    this.rememberFinished(requestId);
    this.recordGeneration(result, Date.now() - pending.startedAt, pending);
    pending.resolve(result);
  }

  private failAllPending(code: InferenceErrorCode, message: string): void {
    const pendingList = [...this.pendingGenerations.values()];
    for (const pending of pendingList) {
      this.settleGeneration(
        pending.input.requestId,
        failedResult(pending.input, code, message),
      );
    }
  }

  private rememberFinished(requestId: string): void {
    this.finished.add(requestId);

    if (this.finished.size > FINISHED_CACHE_CAP) {
      const oldest = this.finished.values().next().value;
      if (oldest) {
        this.finished.delete(oldest);
      }
    }
  }

  // --- worker queries -------------------------------------------------------

  /**
   * Send a correlated provider query and resolve with the worker's answer, or
   * `null` when the worker is not ready, times out or exits first.
   */
  private queryWorker<T>(
    resolvers: Map<string, QueryResolver<T>>,
    kind: 'provider.status' | 'provider.models',
    providerId: string,
  ): Promise<T | null> {
    const transport = this.transport;
    if (this.state !== 'ready' || !transport) {
      return Promise.resolve(null);
    }

    const requestId = newId();

    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        resolvers.delete(requestId);
        resolve(null);
      }, this.statusTimeoutMs);

      resolvers.set(requestId, (value) => {
        clearTimeout(timer);
        resolvers.delete(requestId);
        resolve(value);
      });

      transport.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind,
        requestId,
        payload: { providerId },
      });
    });
  }

  // --- inbound worker messages ----------------------------------------------

  private onWorkerMessage(raw: unknown): void {
    const parsed = workerToMainMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return; // malformed inbound data is ignored safely
    }

    const message = parsed.data;
    switch (message.kind) {
      case 'worker.ready':
        if (message.lifecycleId === this.currentLifecycleId) {
          this.readyResolver?.(true);
        }
        break;
      case 'worker.failure':
        this.readyResolver?.(false);
        break;
      case 'worker.stopped':
        this.shutdownResolver?.();
        break;
      case 'provider.status.result':
        this.pendingStatus.get(message.requestId)?.({
          state: message.payload.state,
          capabilities: message.payload.capabilities,
          runtimeVersion: message.payload.runtimeVersion ?? null,
          messageCode: message.payload.messageCode,
        });
        break;
      case 'provider.models.result':
        this.pendingModels.get(message.requestId)?.(message.payload.models);
        break;
      case 'generation.event':
        this.onGenerationEvent(message);
        break;
      case 'tool.execution.request':
        void this.onToolExecutionRequest(message);
        break;
    }
  }

  /**
   * Handle a worker's proposed tool call. The call is only executed if it
   * correlates to an active, non-settled generation and a tool executor is
   * configured; otherwise it fails closed with a safe result. The executor
   * (broker) performs all authorisation, validation and limits.
   */
  private async onToolExecutionRequest(
    message: ToolExecutionRequestMessage,
  ): Promise<void> {
    const { requestId } = message;
    const { invocation } = message.payload;
    const transport = this.transport;
    const pending = this.pendingGenerations.get(requestId);

    const sendResult = (result: ToolResult) => {
      if (transport && transport === this.transport) {
        transport.send({
          protocolVersion: INFERENCE_PROTOCOL_VERSION,
          kind: 'tool.execution.result',
          requestId,
          payload: { result },
        });
      }
    };

    const hasActiveRun =
      pending !== undefined &&
      !pending.settled &&
      pending.transport === this.transport;
    if (!hasActiveRun) {
      sendResult(
        failedToolResult(invocation, 'TOOL_NOT_ALLOWED', MESSAGES.noActiveRun),
      );
      return;
    }

    if (!this.toolExecutor) {
      sendResult(
        failedToolResult(
          invocation,
          'TOOL_NOT_ALLOWED',
          MESSAGES.toolsUnavailable,
        ),
      );
      return;
    }

    let result: ToolResult;
    try {
      result = await this.toolExecutor.execute(requestId, invocation);
    } catch {
      result = failedToolResult(
        invocation,
        'TOOL_FAILED',
        MESSAGES.brokerFailed,
      );
    }

    sendResult(result);
  }

  private onWorkerExit(): void {
    this.state = 'unavailable';
    this.readyResolver?.(false);
    this.failAllPending('WORKER_EXITED', MESSAGES.workerExited);
    resolveAllWithNull(this.pendingStatus);
    resolveAllWithNull(this.pendingModels);
    this.flushWaiters();

    this.transport = null;
    this.currentLifecycleId = null;
    this.recordWorker('worker.exit', 'failure', 'WORKER_EXITED');
  }

  // --- per-provider capacity ------------------------------------------------

  private acquire(providerId: string): boolean {
    const inFlight = this.inFlight.get(providerId) ?? 0;
    if (inFlight >= this.maxInFlightPerProvider) {
      return false;
    }

    this.inFlight.set(providerId, inFlight + 1);

    return true;
  }

  /**
   * Release a slot and hand it straight to the oldest waiter for the same
   * provider, so a queued request resumes already holding capacity.
   */
  private release(providerId: string): void {
    const inFlight = this.inFlight.get(providerId) ?? 1;
    this.inFlight.set(providerId, Math.max(0, inFlight - 1));

    const index = this.waiters.findIndex((w) => w.providerId === providerId);
    if (index >= 0 && this.acquire(providerId)) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter.resolve();
    }
  }

  private waitForReleasedSlot(providerId: string): Promise<void> {
    return new Promise<void>((resolve) =>
      this.waiters.push({ providerId, resolve }),
    );
  }

  /** Wake any queued requests so they re-check state and settle promptly. */
  private flushWaiters(): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  // --- telemetry ------------------------------------------------------------

  private recordWorker(
    operation: string,
    outcome: 'success' | 'failure',
    errorCode: string | null,
    startedMs?: number,
  ): void {
    this.telemetry?.record({
      moduleId: 'inference',
      operation,
      outcome,
      durationMs: startedMs !== undefined ? Date.now() - startedMs : undefined,
      errorCode,
    });
  }

  private recordGeneration(
    result: GenerationResult,
    durationMs: number,
    pending: PendingGeneration,
  ): void {
    this.telemetry?.record({
      moduleId: 'inference',
      operation: pending.operationLabel,
      outcome: telemetryOutcome(result.status),
      durationMs,
      errorCode: result.error?.code ?? null,
      detail: {
        providerId: result.providerId,
        modelId: result.modelId,
        status: result.status,
        requestId: result.requestId,
        firstTokenMs: pending.firstTokenMs,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        toolCalls: result.toolCalls.length,
      },
    });
  }
}

// --- module helpers ---------------------------------------------------------

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function identityOf(request: GenerationIdentity): GenerationIdentity {
  return {
    requestId: request.requestId,
    providerId: request.providerId,
    modelId: request.modelId,
  };
}

function failedResult(
  identity: GenerationIdentity,
  code: InferenceErrorCode,
  message: string,
): GenerationResult {
  return {
    ...identity,
    status: 'failed',
    output: null,
    toolCalls: [],
    usage: null,
    error: { code, message },
  };
}

function workerUnavailableResult(
  identity: GenerationIdentity,
): GenerationResult {
  return failedResult(
    identity,
    'WORKER_UNAVAILABLE',
    MESSAGES.workerUnavailable,
  );
}

function cancelledResult(identity: GenerationIdentity): GenerationResult {
  return {
    ...identity,
    status: 'cancelled',
    output: null,
    toolCalls: [],
    usage: null,
  };
}

function failedToolResult(
  invocation: ToolInvocation,
  code: NonNullable<ToolResult['error']>['code'],
  message: string,
): ToolResult {
  return {
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
    ok: false,
    error: { code, message },
    durationMs: 0,
  };
}

function generationCancelMessage(requestId: string): MainToWorkerMessage {
  return {
    protocolVersion: INFERENCE_PROTOCOL_VERSION,
    kind: 'generation.cancel',
    requestId,
    payload: {},
  };
}

function sendGenerationStart(
  transport: Transport,
  request: ValidatedGenerationRequest,
  toolInputs: GenerationToolInputs,
): void {
  transport.send({
    protocolVersion: INFERENCE_PROTOCOL_VERSION,
    kind: 'generation.start',
    requestId: request.requestId,
    seq: 0,
    payload: {
      providerId: request.providerId,
      modelId: request.modelId,
      messages: request.messages,
      responseFormat: request.responseFormat,
      thinking: request.thinking,
      toolNames: request.toolNames,
      tools: toolInputs.tools,
      toolPolicy: toolInputs.toolPolicy,
      limits: request.limits,
    },
  });
}

/** Translate a worker event payload into the public generation event. */
function toGenerationEvent(
  requestId: string,
  seq: number,
  at: string,
  payload: GenerationEventMessageSchemaPayload,
): GenerationEvent {
  const base = { requestId, seq, at };

  switch (payload.eventKind) {
    case 'started':
      return { kind: 'started', ...base, providerId: payload.providerId };
    case 'delta':
      return { kind: 'delta', ...base, text: payload.text };
    case 'thinking_delta':
      return { kind: 'thinking_delta', ...base, text: payload.text };
    case 'tool_request':
      return { kind: 'tool_request', ...base, toolCalls: payload.toolCalls };
    case 'tool_result':
      return {
        kind: 'tool_result',
        ...base,
        toolCallId: payload.toolCallId,
        ok: payload.ok,
      };
    case 'completed':
      return {
        kind: 'completed',
        ...base,
        output: payload.output,
        usage: payload.usage,
      };
    case 'failed':
      return { kind: 'failed', ...base, error: payload.error };
    case 'cancelled':
      return { kind: 'cancelled', ...base };
  }
}

/** The settled result for a terminal event payload, or `null` otherwise. */
function toTerminalResult(
  pending: PendingGeneration,
  payload: GenerationEventMessageSchemaPayload,
): GenerationResult | null {
  switch (payload.eventKind) {
    case 'completed':
      return {
        ...pending.input,
        status: 'completed',
        output: payload.output,
        toolCalls: pending.toolCalls,
        usage: payload.usage,
      };
    case 'failed':
      return failedResult(
        pending.input,
        payload.error.code,
        payload.error.message,
      );
    case 'cancelled':
      return cancelledResult(pending.input);
    default:
      return null;
  }
}

function resolveAllWithNull<T>(resolvers: Map<string, QueryResolver<T>>): void {
  for (const resolver of resolvers.values()) {
    resolver(null);
  }
  resolvers.clear();
}

function telemetryOutcome(
  status: GenerationResult['status'],
): 'success' | 'cancelled' | 'failure' {
  if (status === 'completed') {
    return 'success';
  }

  return status === 'cancelled' ? 'cancelled' : 'failure';
}
