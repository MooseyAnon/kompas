import { z } from 'zod';
import {
  INFERENCE_PROTOCOL_VERSION,
  generationLimitsSchema,
  generationMessageSchema,
  inferenceErrorSchema,
  jsonValueSchema,
  modelDescriptorSchema,
  modelDetailsSchema,
  providerCapabilitiesSchema,
  providerStateSchema,
  responseFormatSchema,
  toolCallSchema,
} from './inference';
import {
  toolDefinitionSchema,
  toolInvocationSchema,
  toolPolicySchema,
  toolResultSchema,
} from './tools';

/**
 * Internal main<->utility-process transport protocol v1.
 *
 * This is NOT the public `career:request` envelope and is deliberately kept out
 * of the renderer-facing contracts index. Only the main-process supervisor and
 * the utility worker import it. Every message is validated on receipt at both
 * ends; malformed or wrong-version envelopes are rejected with a safe error.
 */

const protocolVersionSchema = z.literal(INFERENCE_PROTOCOL_VERSION);
const requestIdSchema = z.string().uuid();
const seqSchema = z.number().int().nonnegative();
const lifecycleIdSchema = z.string().uuid();
const providerIdSchema = z.string().min(1).max(64);
const emptyPayloadSchema = () => z.object({}).strict();

/** Upper bound on a single streamed text/thinking delta. */
const MAX_DELTA_TEXT_LENGTH = 24_000;
const MAX_TOOLS_PER_GENERATION = 32;

// --- Main -> worker ---------------------------------------------------------

export const providerConfigSchema = z.object({
  providerId: providerIdSchema,
  kind: z.enum(['mock', 'ollama', 'cloud']),
  dev: z.boolean().optional(),
  /**
   * Provider-specific loopback endpoint (e.g. Ollama). Validated by the
   * adapter.
   */
  endpoint: z.string().min(1).max(128).optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const workerInitMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('worker.init'),
  lifecycleId: lifecycleIdSchema,
  payload: z.object({
    providers: z.array(providerConfigSchema).max(16),
  }),
});

export const providerStatusMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('provider.status'),
  requestId: requestIdSchema,
  payload: z.object({ providerId: providerIdSchema }),
});

export const providerModelsMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('provider.models'),
  requestId: requestIdSchema,
  payload: z.object({ providerId: providerIdSchema }),
});

export const providerModelDetailsMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('provider.modelDetails'),
  requestId: requestIdSchema,
  payload: z.object({
    providerId: providerIdSchema,
    modelId: z.string().min(1).max(128),
  }),
});

export const generationStartMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('generation.start'),
  requestId: requestIdSchema,
  seq: seqSchema,
  payload: z.object({
    providerId: providerIdSchema,
    modelId: z.string().min(1).max(128),
    messages: z.array(generationMessageSchema).min(1).max(64),
    responseFormat: responseFormatSchema.optional(),
    thinking: z.boolean().optional(),
    toolNames: z
      .array(z.string().min(1).max(80))
      .max(MAX_TOOLS_PER_GENERATION)
      .optional(),
    /** Resolved, authorised tool definitions presented to the provider. */
    tools: z
      .array(toolDefinitionSchema)
      .max(MAX_TOOLS_PER_GENERATION)
      .optional(),
    /** Bounded tool-loop policy (also independently enforced by the broker). */
    toolPolicy: toolPolicySchema.optional(),
    limits: generationLimitsSchema.optional(),
  }),
});

/** Main -> worker: the broker's validated result for one proposed tool call. */
export const toolExecutionResultMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('tool.execution.result'),
  requestId: requestIdSchema,
  payload: z.object({ result: toolResultSchema }),
});

export const generationCancelMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('generation.cancel'),
  requestId: requestIdSchema,
  payload: emptyPayloadSchema(),
});

export const workerShutdownMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('worker.shutdown'),
  lifecycleId: lifecycleIdSchema,
  payload: emptyPayloadSchema(),
});

export const mainToWorkerMessageSchema = z.discriminatedUnion('kind', [
  workerInitMessageSchema,
  providerStatusMessageSchema,
  providerModelsMessageSchema,
  providerModelDetailsMessageSchema,
  generationStartMessageSchema,
  generationCancelMessageSchema,
  toolExecutionResultMessageSchema,
  workerShutdownMessageSchema,
]);
export type MainToWorkerMessage = z.infer<typeof mainToWorkerMessageSchema>;

// --- Worker -> main ---------------------------------------------------------

export const workerReadyMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('worker.ready'),
  lifecycleId: lifecycleIdSchema,
  payload: z.object({ protocolVersion: protocolVersionSchema }),
});

export const workerFailureMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('worker.failure'),
  lifecycleId: lifecycleIdSchema.optional(),
  payload: z.object({ error: inferenceErrorSchema }),
});

export const providerStatusResultMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('provider.status.result'),
  requestId: requestIdSchema,
  payload: z.object({
    providerId: providerIdSchema,
    state: providerStateSchema,
    capabilities: providerCapabilitiesSchema,
    runtimeVersion: z.string().max(64).nullable().optional(),
    messageCode: z.string().max(64).optional(),
  }),
});

export const providerModelsResultMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('provider.models.result'),
  requestId: requestIdSchema,
  payload: z.object({
    providerId: providerIdSchema,
    models: z.array(modelDescriptorSchema).max(256),
    error: inferenceErrorSchema.optional(),
  }),
});

export const providerModelDetailsResultMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('provider.modelDetails.result'),
  requestId: requestIdSchema,
  payload: z.object({
    providerId: providerIdSchema,
    modelId: z.string().min(1).max(128),
    details: modelDetailsSchema.nullable(),
  }),
});

export const generationEventKindSchema = z.enum([
  'started',
  'delta',
  'thinking_delta',
  'tool_request',
  'tool_result',
  'completed',
  'failed',
  'cancelled',
]);

const optionalCountSchema = z
  .number()
  .int()
  .nonnegative()
  .nullable()
  .optional();

const generationUsageSchema = z.object({
  inputTokens: optionalCountSchema,
  outputTokens: optionalCountSchema,
  durationMs: optionalCountSchema,
});

export const generationEventMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('generation.event'),
  requestId: requestIdSchema,
  seq: seqSchema,
  payload: z.discriminatedUnion('eventKind', [
    z.object({
      eventKind: z.literal('started'),
      providerId: providerIdSchema,
    }),
    z.object({
      eventKind: z.literal('delta'),
      text: z.string().max(MAX_DELTA_TEXT_LENGTH),
    }),
    z.object({
      eventKind: z.literal('thinking_delta'),
      text: z.string().max(MAX_DELTA_TEXT_LENGTH),
    }),
    z.object({
      eventKind: z.literal('tool_request'),
      toolCalls: z.array(toolCallSchema),
    }),
    z.object({
      eventKind: z.literal('tool_result'),
      toolCallId: z.string().min(1).max(80),
      ok: z.boolean(),
    }),
    z.object({
      eventKind: z.literal('completed'),
      output: z.union([z.string(), jsonValueSchema]).nullable(),
      usage: generationUsageSchema.nullable(),
    }),
    z.object({
      eventKind: z.literal('failed'),
      error: inferenceErrorSchema,
    }),
    z.object({
      eventKind: z.literal('cancelled'),
    }),
  ]),
});

export const workerStoppedMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('worker.stopped'),
  lifecycleId: lifecycleIdSchema,
  payload: emptyPayloadSchema(),
});

/**
 * Worker -> main: a provider-proposed tool call awaiting broker authorisation.
 */
export const toolExecutionRequestMessageSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('tool.execution.request'),
  requestId: requestIdSchema,
  seq: seqSchema,
  payload: z.object({ invocation: toolInvocationSchema }),
});

export const workerToMainMessageSchema = z.discriminatedUnion('kind', [
  workerReadyMessageSchema,
  workerFailureMessageSchema,
  providerStatusResultMessageSchema,
  providerModelsResultMessageSchema,
  providerModelDetailsResultMessageSchema,
  generationEventMessageSchema,
  toolExecutionRequestMessageSchema,
  workerStoppedMessageSchema,
]);
export type WorkerToMainMessage = z.infer<typeof workerToMainMessageSchema>;
