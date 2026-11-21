import type {
  GenerationLimits,
  GenerationMessage,
  InferenceError,
  JsonValue,
  ModelDescriptor,
  ProviderCapabilities,
  ProviderState,
  ResponseFormat,
  ToolCall,
  ToolDefinition,
  Usage,
} from '../../../shared/contracts';

/**
 * A message in the provider-neutral conversation. Extends the public
 * {@link GenerationMessage} with the optional structure needed to represent a
 * tool round-trip inside the worker loop: an assistant turn may carry the
 * `toolCalls` it proposed, and a `tool` turn carries the `toolCallId` it
 * answers. Adapters translate these to each provider's wire format.
 */
export interface ProviderMessage extends GenerationMessage {
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ProviderGenerateRequest {
  modelId: string;
  messages: ProviderMessage[];
  responseFormat?: ResponseFormat;
  /** Provider-neutral on/off preference; omission uses the model default. */
  thinking?: boolean;
  toolNames?: string[];
  /** Authorised tool definitions the provider may propose calls for. */
  tools?: ToolDefinition[];
  limits?: GenerationLimits;
}

export interface ProviderGenerateControls {
  /** Answer text only. */
  onDelta: (text: string) => void;
  /** Model reasoning, when the model produces it; never part of the output. */
  onThinkingDelta?: (text: string) => void;
  signal: AbortSignal;
}

export type ProviderGenerateOutcome =
  | {
      status: 'completed';
      output: string | JsonValue;
      usage: Usage;
    }
  | {
      /** The provider proposed one or more tool calls instead of finishing. */
      status: 'tool_calls';
      toolCalls: ToolCall[];
      assistantContent: string | null;
      usage: Usage;
    }
  | { status: 'failed'; error: InferenceError }
  | { status: 'cancelled' };

export interface ProviderStatusObservation {
  state: ProviderState;
  capabilities: ProviderCapabilities;
  runtimeVersion?: string | null;
  messageCode?: string;
}

/**
 * Provider adapter interface as seen *inside the worker*. Adapters never touch
 * the database, filesystem or Electron APIs; they only transform a bounded
 * request into provider-neutral events. Adapters may perform their own
 * designated model API calls (e.g. an Ollama loopback endpoint), never
 * arbitrary web/tool/file access. Adapters serialise tool *definitions* and
 * normalise tool-call *proposals*; they never execute tools.
 */
export interface WorkerProvider {
  readonly id: string;
  status(): ProviderStatusObservation | Promise<ProviderStatusObservation>;
  /** Discover locally installed model descriptors (006.2). */
  listModels?(): Promise<ModelDescriptor[]>;
  generate(
    req: ProviderGenerateRequest,
    controls: ProviderGenerateControls,
  ): Promise<ProviderGenerateOutcome>;
}
