import type {
  InferenceError,
  JsonValue,
  ModelDescriptor,
  ProviderCapabilities,
  ToolCall,
  ToolDefinition,
} from '../../../shared/contracts';
import type {
  ProviderGenerateControls,
  ProviderGenerateOutcome,
  ProviderGenerateRequest,
  ProviderMessage,
  ProviderStatusObservation,
  WorkerProvider,
} from './provider';

export const OLLAMA_PROVIDER_ID = 'ollama';
export const OLLAMA_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

/** Stable status/guidance codes surfaced to the UI (never raw vendor text). */
export const OLLAMA_MESSAGE_CODES = {
  ready: 'OLLAMA_READY',
  noModels: 'OLLAMA_NO_MODELS',
  notRunning: 'OLLAMA_NOT_RUNNING',
  unreachable: 'OLLAMA_UNREACHABLE',
  badEndpoint: 'OLLAMA_ENDPOINT_NOT_LOCAL',
} as const;

/** Conservative per-call bounds; the supervisor also enforces its own timeout. */
const HEALTH_TIMEOUT_MS = 1_500;
const MODELS_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_CHARS = 200_000;
/** Reasoning past this is dropped rather than failing the answer. */
const MAX_THINKING_CHARS = 200_000;

const UNKNOWN_CAPABILITIES: ProviderCapabilities = {
  text: 'unknown',
  streaming: 'unknown',
  structuredOutput: 'unknown',
  tools: 'unknown',
};

// Ollama can be reached by a model that is itself cloud-hosted; local-only
// policy must fail closed on anything that looks cloud-backed.
const CAPABILITIES_WHEN_READY: ProviderCapabilities = {
  text: 'supported',
  streaming: 'supported',
  structuredOutput: 'supported',
  tools: 'unknown',
};

export type FetchImpl = typeof fetch;

export interface OllamaProviderOptions {
  endpoint?: string;
  /** Injected for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Health probe timeout override (defaults to {@link HEALTH_TIMEOUT_MS}). */
  healthTimeoutMs?: number;
  /** Model discovery timeout override (defaults to {@link MODELS_TIMEOUT_MS}). */
  modelsTimeoutMs?: number;
}

interface OllamaTagModel {
  name?: unknown;
  model?: unknown;
  size?: unknown;
  digest?: unknown;
  details?: {
    parameter_size?: unknown;
    quantization_level?: unknown;
    family?: unknown;
    families?: unknown;
  };
}

/** One NDJSON line of an Ollama `/api/chat` stream. */
interface OllamaChatChunk {
  error?: unknown;
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: unknown;
  };
  done?: unknown;
  total_duration?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

type StreamUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
};

/** Accumulated answer, reasoning budget, usage and tool calls of a stream. */
interface StreamState {
  output: string;
  thinkingChars: number;
  usage: StreamUsage | null;
  toolCalls: ToolCall[];
}

/** Model metadata strings (parameter size, quantization) are capped. */
const MAX_METADATA_CHARS = 32;

/** Classify a failed loopback request without guessing installation state. */
type ConnectionFailure = 'refused' | 'aborted' | 'other';

function classifyFetchError(error: unknown): ConnectionFailure {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'aborted';
  }
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  return 'other';
}

function isLoopbackHost(host: string): boolean {
  const normalised = host.toLowerCase();
  return (
    normalised === '127.0.0.1' ||
    normalised === 'localhost' ||
    normalised === '::1' ||
    normalised === '[::1]'
  );
}

/** Only loopback endpoints are permitted; remote hosts fail closed. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Models whose naming/metadata indicates cloud backing are never "local". */
function detectLocality(name: string): 'local' | 'cloud' | 'unknown' {
  const lower = name.toLowerCase();
  if (
    lower.endsWith('-cloud') ||
    lower.includes(':cloud') ||
    lower === 'cloud'
  ) {
    return 'cloud';
  }
  if (lower.includes('cloud')) {
    return 'unknown';
  }
  return 'local';
}

function combineSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) {
        remove();
      }
    },
  };
}

/**
 * Ollama provider adapter. Pure translation layer that runs inside the
 * inference worker: it maps provider-neutral requests to the Ollama HTTP API on
 * a constrained loopback endpoint and normalises responses, errors, usage and
 * streaming back into provider-neutral shapes. It never starts, installs,
 * downloads, kills or otherwise orchestrates Ollama, and performs no filesystem
 * or arbitrary network access.
 */
export class OllamaProvider implements WorkerProvider {
  readonly id = OLLAMA_PROVIDER_ID;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImpl;
  private readonly endpointIsLocal: boolean;
  private readonly healthTimeoutMs: number;
  private readonly modelsTimeoutMs: number;

  constructor(options: OllamaProviderOptions = {}) {
    this.endpoint = (options.endpoint ?? OLLAMA_DEFAULT_ENDPOINT).replace(
      /\/+$/,
      '',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpointIsLocal = isLoopbackEndpoint(this.endpoint);
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    this.modelsTimeoutMs = options.modelsTimeoutMs ?? MODELS_TIMEOUT_MS;
  }

  async status(): Promise<ProviderStatusObservation> {
    if (!this.endpointIsLocal) {
      return unavailableStatus('error', OLLAMA_MESSAGE_CODES.badEndpoint);
    }

    let version: string | null = null;
    try {
      const res = await this.request('/api/version', {
        method: 'GET',
        timeoutMs: this.healthTimeoutMs,
      });
      if (!res.ok) {
        return unavailableStatus('unknown', OLLAMA_MESSAGE_CODES.unreachable);
      }

      const body = (await res.json()) as { version?: unknown };
      version = typeof body.version === 'string' ? body.version : null;
    } catch (error) {
      // A failed connection is NOT proof of "not installed"; stay conservative.
      return classifyFetchError(error) === 'refused'
        ? unavailableStatus('not_running', OLLAMA_MESSAGE_CODES.notRunning)
        : unavailableStatus('unknown', OLLAMA_MESSAGE_CODES.unreachable);
    }

    // Runtime is reachable; distinguish "running, no models" from "has models".
    let modelCount = 0;
    try {
      const models = await this.listModels();
      modelCount = models.length;
    } catch {
      modelCount = 0;
    }

    return {
      state: 'ready',
      capabilities: CAPABILITIES_WHEN_READY,
      runtimeVersion: version,
      messageCode:
        modelCount > 0
          ? OLLAMA_MESSAGE_CODES.ready
          : OLLAMA_MESSAGE_CODES.noModels,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.endpointIsLocal) {
      return [];
    }

    let body: { models?: unknown };
    try {
      const res = await this.request('/api/tags', {
        method: 'GET',
        timeoutMs: this.modelsTimeoutMs,
      });
      if (!res.ok) {
        return [];
      }

      body = (await res.json()) as { models?: unknown };
    } catch {
      return [];
    }

    const rawModels = Array.isArray(body.models)
      ? (body.models as OllamaTagModel[])
      : [];
    const descriptors: ModelDescriptor[] = [];
    for (const raw of rawModels) {
      const descriptor = toModelDescriptor(this.id, raw);
      if (descriptor) {
        descriptors.push(descriptor);
      }
    }

    return descriptors;
  }

  async generate(
    req: ProviderGenerateRequest,
    controls: ProviderGenerateControls,
  ): Promise<ProviderGenerateOutcome> {
    if (!this.endpointIsLocal) {
      return failure(
        'PROVIDER_UNAVAILABLE',
        'The Ollama endpoint is not a local loopback address.',
      );
    }

    if (controls.signal.aborted) {
      return { status: 'cancelled' };
    }

    let response: Response;
    const combined = combineSignals([controls.signal]);
    try {
      response = await this.fetchImpl(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toChatRequestBody(req)),
        signal: combined.signal,
      });
    } catch (error) {
      combined.dispose();
      return chatRequestFailure(error);
    }

    try {
      if (response.status === 404) {
        return failure(
          'MODEL_NOT_FOUND',
          'The requested model is not installed.',
        );
      }

      if (!response.ok || !response.body) {
        return failure(
          'INVALID_RESPONSE',
          'Ollama returned an error response.',
        );
      }

      return await this.consumeStream(response, controls);
    } finally {
      combined.dispose();
    }
  }

  /** Read the NDJSON chat stream, forwarding deltas as they arrive. */
  private async consumeStream(
    response: Response,
    controls: ProviderGenerateControls,
  ): Promise<ProviderGenerateOutcome> {
    const decoder = new TextDecoder();
    const stream = newStreamState();
    let buffer = '';

    try {
      const body = response.body as ReadableStream<Uint8Array>;
      for await (const part of iterateStream(body)) {
        if (controls.signal.aborted) {
          return { status: 'cancelled' };
        }

        buffer += decoder.decode(part, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const terminal = applyStreamLine(line, stream, controls);
          if (terminal) {
            return terminal;
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        const terminal = applyStreamLine(buffer, stream, controls);
        if (terminal) {
          return terminal;
        }
      }
    } catch (error) {
      if (classifyFetchError(error) === 'aborted' || controls.signal.aborted) {
        return { status: 'cancelled' };
      }

      return failure('INVALID_RESPONSE', 'The Ollama stream was interrupted.');
    }

    if (controls.signal.aborted) {
      return { status: 'cancelled' };
    }

    return toStreamOutcome(stream);
  }

  private request(
    path: string,
    options: { method: 'GET' | 'POST'; timeoutMs: number; body?: unknown },
  ): Promise<Response> {
    const signal = AbortSignal.timeout(options.timeoutMs);
    return this.fetchImpl(`${this.endpoint}${path}`, {
      method: options.method,
      headers:
        options.body === undefined
          ? undefined
          : { 'content-type': 'application/json' },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
  }
}

function unavailableStatus(
  state: ProviderStatusObservation['state'],
  messageCode: string,
): ProviderStatusObservation {
  return {
    state,
    capabilities: UNKNOWN_CAPABILITIES,
    runtimeVersion: null,
    messageCode,
  };
}

function toModelDescriptor(
  providerId: string,
  raw: OllamaTagModel,
): ModelDescriptor | null {
  const name = stringOrNull(raw.name) ?? stringOrNull(raw.model);
  if (!name) {
    return null;
  }

  const size =
    typeof raw.size === 'number' && Number.isFinite(raw.size)
      ? Math.max(0, Math.floor(raw.size))
      : null;
  const details = raw.details ?? {};

  return {
    providerId,
    id: name,
    displayName: name,
    locality: detectLocality(name),
    installed: true,
    sizeBytes: size,
    parameterSize: cappedString(details.parameter_size),
    quantization: cappedString(details.quantization_level),
    contextLength: null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function cappedString(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_METADATA_CHARS) : null;
}

function toChatRequestBody(
  req: ProviderGenerateRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.modelId,
    messages: toOllamaMessages(req.messages),
    stream: true,
  };

  if (req.thinking !== undefined) {
    body.think = req.thinking;
  }

  if (req.responseFormat?.type === 'json_schema') {
    body.format = req.responseFormat.schema;
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = toOllamaTools(req.tools);
  }

  return body;
}

function chatRequestFailure(error: unknown): ProviderGenerateOutcome {
  const kind = classifyFetchError(error);
  if (kind === 'aborted') {
    return { status: 'cancelled' };
  }

  if (kind === 'refused') {
    return failure(
      'PROVIDER_UNAVAILABLE',
      'The Ollama server is not reachable.',
    );
  }

  return failure('INVALID_RESPONSE', 'The Ollama request failed.');
}

function newStreamState(): StreamState {
  return { output: '', thinkingChars: 0, usage: null, toolCalls: [] };
}

/**
 * Apply one stream line to `stream`, forwarding reasoning and answer deltas.
 * Returns a terminal outcome when the line ends the stream with a failure.
 */
function applyStreamLine(
  line: string,
  stream: StreamState,
  controls: ProviderGenerateControls,
): ProviderGenerateOutcome | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return failure(
      'INVALID_RESPONSE',
      'Ollama returned malformed stream data.',
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const chunk = parsed as OllamaChatChunk;
  if (typeof chunk.error === 'string') {
    return failure('INVALID_RESPONSE', 'Ollama reported a generation error.');
  }

  forwardThinking(chunk.message?.thinking, stream, controls);

  const content = chunk.message?.content;
  if (typeof content === 'string' && content.length > 0) {
    stream.output += content;
    if (stream.output.length > MAX_OUTPUT_CHARS) {
      return failure(
        'LIMIT_EXCEEDED',
        'The model output exceeded the allowed size.',
      );
    }
    controls.onDelta(content);
  }

  collectToolCalls(chunk.message?.tool_calls, stream);

  if (chunk.done === true) {
    stream.usage = {
      inputTokens: intOrNull(chunk.prompt_eval_count),
      outputTokens: intOrNull(chunk.eval_count),
      durationMs: nanosToMillis(chunk.total_duration),
    };
  }

  return null;
}

/** Forward reasoning until {@link MAX_THINKING_CHARS}; the rest is dropped. */
function forwardThinking(
  thinking: unknown,
  stream: StreamState,
  controls: ProviderGenerateControls,
): void {
  const hasBudget =
    typeof thinking === 'string' &&
    thinking.length > 0 &&
    stream.thinkingChars < MAX_THINKING_CHARS;
  if (!hasBudget) {
    return;
  }

  const allowed = thinking.slice(0, MAX_THINKING_CHARS - stream.thinkingChars);
  stream.thinkingChars += allowed.length;
  controls.onThinkingDelta?.(allowed);
}

function collectToolCalls(rawToolCalls: unknown, stream: StreamState): void {
  if (!Array.isArray(rawToolCalls)) {
    return;
  }

  for (const call of rawToolCalls) {
    const normalised = normaliseToolCall(call, stream.toolCalls.length);
    if (normalised) {
      stream.toolCalls.push(normalised);
    }
  }
}

function toStreamOutcome(stream: StreamState): ProviderGenerateOutcome {
  if (stream.toolCalls.length > 0) {
    return {
      status: 'tool_calls',
      toolCalls: stream.toolCalls,
      assistantContent: stream.output.length > 0 ? stream.output : null,
      usage: stream.usage,
    };
  }

  return { status: 'completed', output: stream.output, usage: stream.usage };
}

async function* iterateStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Serialise authorised tool definitions into Ollama's `tools` wire format. */
export function toOllamaTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Map provider-neutral messages (including the worker's assistant tool-call
 * turns and `tool` result turns) into Ollama's chat message wire format. This
 * is how a validated broker tool result, serialised into a `tool` message by
 * the worker, is mapped back into an Ollama-compatible tool message.
 */
export function toOllamaMessages(messages: ProviderMessage[]): unknown[] {
  return messages.map((message) => {
    if (
      message.role === 'assistant' &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          function: {
            name: call.toolName,
            arguments: call.arguments as JsonValue,
          },
        })),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function normaliseToolCall(call: unknown, index: number): ToolCall | null {
  if (!call || typeof call !== 'object') {
    return null;
  }
  const fn = (call as { function?: unknown }).function;
  if (!fn || typeof fn !== 'object') {
    return null;
  }
  const name = (fn as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }
  const rawArgs = (fn as { arguments?: unknown }).arguments;
  let args: ToolCall['arguments'] = {};
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs) as ToolCall['arguments'];
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as ToolCall['arguments'];
  }
  return {
    toolCallId: `ollama-tool-${index}`,
    toolName: name.slice(0, 80),
    arguments: args,
  };
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

function nanosToMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value / 1_000_000))
    : null;
}

function failure(
  code: InferenceError['code'],
  message: string,
): ProviderGenerateOutcome {
  return { status: 'failed', error: { code, message } };
}
