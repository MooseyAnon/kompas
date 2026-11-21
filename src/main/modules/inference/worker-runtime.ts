import { type GenerationEventMessageSchemaPayload } from './runtime-types';
import {
  mainToWorkerMessageSchema,
  type MainToWorkerMessage,
  type ProviderConfig,
  type WorkerToMainMessage,
} from '../../../shared/contracts/inference-worker';
import {
  INFERENCE_PROTOCOL_VERSION,
  TOOL_LIMITS,
  type InferenceError,
  type JsonValue,
  type ProviderCapabilities,
  type ToolCall,
  type ToolDefinition,
  type ToolPolicy,
  type ToolResult,
} from '../../../shared/contracts';
import { MockProvider } from './mock-provider';
import { OllamaProvider } from './ollama-provider';
import type {
  ProviderGenerateOutcome,
  ProviderMessage,
  ProviderStatusObservation,
  WorkerProvider,
} from './provider';
import { safeParseJson, validateAgainstJsonSchema } from './json-schema';

export type ProviderFactory = (config: ProviderConfig) => WorkerProvider | null;

export interface WorkerRuntimeOptions {
  send: (message: WorkerToMainMessage) => void;
  createProvider?: ProviderFactory;
  now?: () => string;
}

interface ActiveGeneration {
  abort: AbortController;
  seq: number;
  terminal: boolean;
  /** Resolvers for in-flight tool executions, keyed by toolCallId. */
  pendingTool: Map<string, (result: ToolResult) => void>;
}

type GenerationStartMessage = Extract<
  MainToWorkerMessage,
  { kind: 'generation.start' }
>;

type GenerationStartPayload = GenerationStartMessage['payload'];

type ToolExecutionResultMessage = Extract<
  MainToWorkerMessage,
  { kind: 'tool.execution.result' }
>;

type ResponseFormat = GenerationStartPayload['responseFormat'];

type ValidatedOutput =
  | { ok: true; value: string | JsonValue }
  | { ok: false; error: InferenceError };

/** Running tool-call counts for one generation, checked against its policy. */
interface ToolBudget {
  totalCalls: number;
  perTool: Map<string, number>;
}

/** Tool names are truncated to this length in `tool` role messages. */
const MAX_TOOL_MESSAGE_NAME_LENGTH = 64;

const UNKNOWN_CAPABILITIES: ProviderCapabilities = {
  text: 'unknown',
  streaming: 'unknown',
  structuredOutput: 'unknown',
  tools: 'unknown',
};

const defaultFactory: ProviderFactory = (config) => {
  if (config.kind === 'mock') {
    return new MockProvider();
  }

  if (config.kind === 'ollama') {
    return new OllamaProvider({ endpoint: config.endpoint });
  }

  return null;
};

/**
 * Provider-neutral worker message handler. Pure logic: it receives validated
 * transport envelopes and emits transport events through `send`, with no access
 * to the database, filesystem, network or Electron APIs. The same instance runs
 * inside the real utility process and under the in-memory test transport.
 */
export class WorkerRuntime {
  private readonly send: (message: WorkerToMainMessage) => void;
  private readonly createProvider: ProviderFactory;
  private readonly now: () => string;
  private readonly providers = new Map<string, WorkerProvider>();
  private readonly active = new Map<string, ActiveGeneration>();
  private initialised = false;

  constructor(options: WorkerRuntimeOptions) {
    this.send = options.send;
    this.createProvider = options.createProvider ?? defaultFactory;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Handle one raw inbound message. Invalid envelopes yield a safe failure. */
  handle(raw: unknown): void {
    const parsed = mainToWorkerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'worker.failure',
        payload: {
          error: {
            code: 'INVALID_RESPONSE',
            message: 'Malformed or unsupported worker message.',
          },
        },
      });
      return;
    }

    this.dispatch(parsed.data);
  }

  private dispatch(message: MainToWorkerMessage): void {
    switch (message.kind) {
      case 'worker.init':
        this.onInit(message.lifecycleId, message.payload.providers);
        break;
      case 'provider.status':
        void this.onProviderStatus(
          message.requestId,
          message.payload.providerId,
        );
        break;
      case 'provider.models':
        void this.onProviderModels(
          message.requestId,
          message.payload.providerId,
        );
        break;
      case 'generation.start':
        void this.onGenerationStart(message);
        break;
      case 'generation.cancel':
        this.onCancel(message.requestId);
        break;
      case 'tool.execution.result':
        this.onToolExecutionResult(message);
        break;
      case 'worker.shutdown':
        this.onShutdown(message.lifecycleId);
        break;
    }
  }

  // --- lifecycle ------------------------------------------------------------

  private onInit(lifecycleId: string, configs: ProviderConfig[]): void {
    this.providers.clear();
    for (const config of configs) {
      const provider = this.createProvider(config);
      if (provider) {
        this.providers.set(config.providerId, provider);
      }
    }

    this.initialised = true;
    this.send({
      protocolVersion: INFERENCE_PROTOCOL_VERSION,
      kind: 'worker.ready',
      lifecycleId,
      payload: { protocolVersion: INFERENCE_PROTOCOL_VERSION },
    });
  }

  private onCancel(requestId: string): void {
    const state = this.active.get(requestId);
    if (state && !state.terminal) {
      state.abort.abort();
    }
  }

  private onShutdown(lifecycleId: string): void {
    for (const state of this.active.values()) {
      state.abort.abort();
    }

    this.send({
      protocolVersion: INFERENCE_PROTOCOL_VERSION,
      kind: 'worker.stopped',
      lifecycleId,
      payload: {},
    });
  }

  // --- provider queries -----------------------------------------------------

  private async onProviderStatus(
    requestId: string,
    providerId: string,
  ): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      this.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'provider.status.result',
        requestId,
        payload: {
          providerId,
          state: 'unknown',
          capabilities: UNKNOWN_CAPABILITIES,
          messageCode: 'NOT_REGISTERED',
        },
      });
      return;
    }

    let observation: ProviderStatusObservation;
    try {
      observation = await provider.status();
    } catch {
      observation = {
        state: 'unknown',
        capabilities: UNKNOWN_CAPABILITIES,
        runtimeVersion: null,
      };
    }

    this.send({
      protocolVersion: INFERENCE_PROTOCOL_VERSION,
      kind: 'provider.status.result',
      requestId,
      payload: {
        providerId,
        state: observation.state,
        capabilities: observation.capabilities,
        runtimeVersion: observation.runtimeVersion ?? null,
        messageCode: observation.messageCode,
      },
    });
  }

  private async onProviderModels(
    requestId: string,
    providerId: string,
  ): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider || !provider.listModels) {
      this.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'provider.models.result',
        requestId,
        payload: { providerId, models: [] },
      });
      return;
    }

    try {
      const models = await provider.listModels();
      this.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'provider.models.result',
        requestId,
        payload: { providerId, models },
      });
    } catch {
      this.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'provider.models.result',
        requestId,
        payload: {
          providerId,
          models: [],
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: 'The provider could not list models.',
          },
        },
      });
    }
  }

  // --- generation -----------------------------------------------------------

  private async onGenerationStart(
    message: GenerationStartMessage,
  ): Promise<void> {
    const { requestId, payload } = message;
    if (this.active.has(requestId)) {
      return; // duplicate start ignored
    }

    const state: ActiveGeneration = {
      abort: new AbortController(),
      seq: 0,
      terminal: false,
      pendingTool: new Map(),
    };
    this.active.set(requestId, state);

    if (!this.initialised) {
      this.emitFailure(
        requestId,
        state,
        'WORKER_UNAVAILABLE',
        'The worker is not initialised.',
      );
      return;
    }

    const provider = this.providers.get(payload.providerId);
    if (!provider) {
      this.emitFailure(
        requestId,
        state,
        'PROVIDER_UNAVAILABLE',
        'The requested provider is not available.',
      );
      return;
    }

    this.emit(requestId, state, {
      eventKind: 'started',
      providerId: provider.id,
    });

    try {
      await this.runToolLoop(requestId, state, provider, payload);
    } catch {
      if (!state.terminal) {
        this.emitFailure(
          requestId,
          state,
          'INTERNAL',
          'The provider raised an unexpected error.',
        );
      }
    }
  }

  /**
   * Bounded, provider-neutral reasoning/tool loop. Never recurses and never
   * replays side-effecting calls; every iteration is capped and every tool
   * call is authorised and executed by the main-process broker.
   */
  private async runToolLoop(
    requestId: string,
    state: ActiveGeneration,
    provider: WorkerProvider,
    payload: GenerationStartPayload,
  ): Promise<void> {
    const tools = payload.tools ?? [];
    const policy = resolveToolPolicy(payload.toolPolicy);
    const messages: ProviderMessage[] = [...payload.messages];
    const budget: ToolBudget = { totalCalls: 0, perTool: new Map() };

    for (let step = 1; ; step += 1) {
      if (state.terminal) {
        return;
      }

      if (state.abort.signal.aborted) {
        this.emitTerminal(requestId, state, { eventKind: 'cancelled' });
        return;
      }

      if (step > policy.maxSteps) {
        this.emitFailure(
          requestId,
          state,
          'LIMIT_EXCEEDED',
          'The tool-call loop exceeded its step budget.',
        );
        return;
      }

      const outcome = await this.generateStep(
        requestId,
        state,
        provider,
        payload,
        messages,
        tools,
      );

      if (state.terminal) {
        return;
      }

      const wantsTools =
        outcome.status === 'tool_calls' && outcome.toolCalls.length > 0;
      if (!wantsTools) {
        this.emitFinalOutcome(requestId, state, outcome, payload);
        return;
      }

      messages.push({
        role: 'assistant',
        content: outcome.assistantContent ?? '',
        toolCalls: outcome.toolCalls,
      });

      const shouldContinue = await this.runToolCalls(
        requestId,
        state,
        outcome.toolCalls,
        { messages, tools, policy, budget },
      );
      if (!shouldContinue) {
        return;
      }
    }
  }

  /** One provider call, streaming deltas until the run becomes terminal. */
  private generateStep(
    requestId: string,
    state: ActiveGeneration,
    provider: WorkerProvider,
    payload: GenerationStartPayload,
    messages: ProviderMessage[],
    tools: ToolDefinition[],
  ): Promise<ProviderGenerateOutcome> {
    return provider.generate(
      {
        modelId: payload.modelId,
        messages,
        responseFormat: payload.responseFormat,
        thinking: payload.thinking,
        toolNames: payload.toolNames,
        tools: tools.length > 0 ? tools : undefined,
        limits: payload.limits,
      },
      {
        signal: state.abort.signal,
        onDelta: (text) => {
          if (!state.terminal) {
            this.emit(requestId, state, { eventKind: 'delta', text });
          }
        },
        onThinkingDelta: (text) => {
          if (!state.terminal) {
            this.emit(requestId, state, { eventKind: 'thinking_delta', text });
          }
        },
      },
    );
  }

  /** Emit the terminal event for an outcome that requests no further tools. */
  private emitFinalOutcome(
    requestId: string,
    state: ActiveGeneration,
    outcome: ProviderGenerateOutcome,
    payload: GenerationStartPayload,
  ): void {
    switch (outcome.status) {
      case 'cancelled':
        this.emitTerminal(requestId, state, { eventKind: 'cancelled' });
        return;

      case 'failed':
        this.emitTerminal(requestId, state, {
          eventKind: 'failed',
          error: outcome.error,
        });
        return;

      case 'completed': {
        const validated = validateOutput(
          outcome.output,
          payload.responseFormat,
        );
        this.emitTerminal(
          requestId,
          state,
          validated.ok
            ? {
                eventKind: 'completed',
                output: validated.value,
                usage: outcome.usage,
              }
            : { eventKind: 'failed', error: validated.error },
        );
        return;
      }

      case 'tool_calls':
        // A tool-call turn with no calls is the model's final answer.
        this.emitTerminal(requestId, state, {
          eventKind: 'completed',
          output: outcome.assistantContent ?? '',
          usage: outcome.usage,
        });
        return;
    }
  }

  /**
   * Execute one batch of proposed tool calls in order, appending each result
   * to the conversation. Returns `false` once the run has become terminal.
   */
  private async runToolCalls(
    requestId: string,
    state: ActiveGeneration,
    calls: ToolCall[],
    context: {
      messages: ProviderMessage[];
      tools: ToolDefinition[];
      policy: ToolPolicy;
      budget: ToolBudget;
    },
  ): Promise<boolean> {
    const { messages, tools, policy, budget } = context;

    for (const call of calls) {
      if (state.terminal) {
        return false;
      }

      budget.totalCalls += 1;
      if (budget.totalCalls > policy.maxToolCalls) {
        this.emitFailure(
          requestId,
          state,
          'LIMIT_EXCEEDED',
          'The run exceeded its total tool-call budget.',
        );
        return false;
      }

      const callsOfThisTool = (budget.perTool.get(call.toolName) ?? 0) + 1;
      budget.perTool.set(call.toolName, callsOfThisTool);

      this.emit(requestId, state, {
        eventKind: 'tool_request',
        toolCalls: [call],
      });

      const result =
        callsOfThisTool > policy.maxCallsPerTool
          ? perToolBudgetExhaustedResult(call)
          : await this.requestToolExecution(requestId, state, call, tools);

      if (state.terminal) {
        return false;
      }

      this.emit(requestId, state, {
        eventKind: 'tool_result',
        toolCallId: call.toolCallId,
        ok: result.ok,
      });
      messages.push({
        role: 'tool',
        content: serialiseToolResult(result),
        name: call.toolName.slice(0, MAX_TOOL_MESSAGE_NAME_LENGTH),
        toolCallId: call.toolCallId,
      });

      if (state.abort.signal.aborted) {
        this.emitTerminal(requestId, state, { eventKind: 'cancelled' });
        return false;
      }
    }

    return true;
  }

  // --- tool execution -------------------------------------------------------

  /** Emit one `tool.execution.request` and await the broker's validated result. */
  private requestToolExecution(
    requestId: string,
    state: ActiveGeneration,
    call: ToolCall,
    tools: ToolDefinition[],
  ): Promise<ToolResult> {
    const version = tools.find((t) => t.name === call.toolName)?.version ?? 1;
    const { toolCallId } = call;
    const { signal } = state.abort;

    return new Promise<ToolResult>((resolve) => {
      const cancelledResult: ToolResult = {
        toolCallId,
        toolName: call.toolName,
        ok: false,
        error: { code: 'CANCELLED', message: 'The run was cancelled.' },
        durationMs: 0,
      };

      if (signal.aborted) {
        resolve(cancelledResult);
        return;
      }

      const onAbort = () => {
        if (state.pendingTool.delete(toolCallId)) {
          resolve(cancelledResult);
        }
      };
      state.pendingTool.set(toolCallId, (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
      signal.addEventListener('abort', onAbort, { once: true });

      state.seq += 1;
      this.send({
        protocolVersion: INFERENCE_PROTOCOL_VERSION,
        kind: 'tool.execution.request',
        requestId,
        seq: state.seq,
        payload: {
          invocation: {
            toolCallId,
            toolName: call.toolName,
            version,
            arguments: call.arguments,
          },
        },
      });
    });
  }

  private onToolExecutionResult(message: ToolExecutionResultMessage): void {
    const state = this.active.get(message.requestId);
    if (!state) {
      return;
    }

    const { result } = message.payload;
    const resolver = state.pendingTool.get(result.toolCallId);
    if (resolver) {
      state.pendingTool.delete(result.toolCallId);
      resolver(result);
    }
  }

  // --- event emission -------------------------------------------------------

  private emit(
    requestId: string,
    state: ActiveGeneration,
    payload: GenerationEventMessageSchemaPayload,
  ): void {
    state.seq += 1;
    this.send({
      protocolVersion: INFERENCE_PROTOCOL_VERSION,
      kind: 'generation.event',
      requestId,
      seq: state.seq,
      payload,
    });
  }

  /** Emit the run's single terminal event and stop tracking it. */
  private emitTerminal(
    requestId: string,
    state: ActiveGeneration,
    payload: GenerationEventMessageSchemaPayload,
  ): void {
    if (state.terminal) {
      return;
    }

    state.terminal = true;
    this.emit(requestId, state, payload);
    this.active.delete(requestId);
  }

  private emitFailure(
    requestId: string,
    state: ActiveGeneration,
    code: InferenceError['code'],
    message: string,
  ): void {
    this.emitTerminal(requestId, state, {
      eventKind: 'failed',
      error: { code, message },
    });
  }
}

/** Check structured output against the requested JSON schema, if any. */
function validateOutput(
  output: string | JsonValue,
  responseFormat: ResponseFormat,
): ValidatedOutput {
  if (!responseFormat || responseFormat.type === 'text') {
    return { ok: true, value: output };
  }

  const parsed: JsonValue | undefined =
    typeof output === 'string' ? safeParseJson(output) : output;
  if (parsed === undefined) {
    return {
      ok: false,
      error: {
        code: 'INVALID_RESPONSE',
        message: 'Structured output was not valid JSON.',
      },
    };
  }

  const result = validateAgainstJsonSchema(parsed, responseFormat.schema);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SCHEMA',
        message: 'Structured output did not satisfy the requested schema.',
      },
    };
  }

  return { ok: true, value: result.value };
}

/** Clamp a requested tool policy to safe defaults and hard ceilings. */
function resolveToolPolicy(policy: ToolPolicy | undefined): ToolPolicy {
  return {
    maxSteps: Math.min(
      policy?.maxSteps ?? TOOL_LIMITS.defaultMaxSteps,
      TOOL_LIMITS.hardMaxSteps,
    ),
    maxToolCalls: Math.min(
      policy?.maxToolCalls ?? TOOL_LIMITS.defaultMaxToolCalls,
      TOOL_LIMITS.hardMaxToolCalls,
    ),
    // Note: capped at the default, not a hard ceiling (preserved behaviour).
    maxCallsPerTool: Math.min(
      policy?.maxCallsPerTool ?? TOOL_LIMITS.defaultMaxCallsPerTool,
      TOOL_LIMITS.defaultMaxCallsPerTool,
    ),
  };
}

function perToolBudgetExhaustedResult(call: ToolCall): ToolResult {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    ok: false,
    error: {
      code: 'LIMIT_EXCEEDED',
      message: 'The per-tool call budget was exhausted.',
    },
    durationMs: 0,
  };
}

/** Render a validated broker result as the tool message content for the model. */
function serialiseToolResult(result: ToolResult): string {
  const payload: JsonValue = result.ok
    ? { ok: true, data: result.data ?? null }
    : { ok: false, error: result.error?.code ?? 'TOOL_FAILED' };
  const text = JSON.stringify(payload);

  return text.length > TOOL_LIMITS.defaultMaxResultBytes
    ? text.slice(0, TOOL_LIMITS.defaultMaxResultBytes)
    : text;
}
