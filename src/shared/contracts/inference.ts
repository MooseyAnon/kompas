import { z } from 'zod';

/** Public API major version for the `inference` module. */
export const INFERENCE_API_VERSION = 1;
export const INFERENCE_MODULE_ID = 'inference';

/**
 * Internal main<->worker transport protocol major version (see
 * WORKER_PROTOCOL_V1).
 */
export const INFERENCE_PROTOCOL_VERSION = 1;

// --- Bounded limits ---------------------------------------------------------

/** Request/response guardrails. In-process generation is not bound by the IPC
 * envelope cap, so the service applies its own conservative limits. */
export const INFERENCE_LIMITS = {
  maxMessages: 64,
  maxMessageChars: 24_000,
  minTimeoutMs: 100,
  defaultTimeoutMs: 300_000,
  // Node timers cannot reliably schedule a single delay beyond this value.
  maxTimeoutMs: 2_147_483_647,
  // The saved target may run for twice its duration before being cancelled.
  maxConfigurableTimeoutMs: Math.floor(2_147_483_647 / 2),
  maxInFlightPerProvider: 1,
  maxQueued: 8,
  startupTimeoutMs: 10_000,
  shutdownTimeoutMs: 5_000,
  maxRestartAttempts: 3,
  maxEventPayloadBytes: 32 * 1024,
  maxToolNames: 32,
} as const;

// --- Error taxonomy ---------------------------------------------------------

/** Detailed inference error codes used inside trusted service interfaces.
 * These are mapped to the narrow public IPC error vocabulary before crossing
 * the renderer boundary; raw stacks/vendor payloads never leave the worker. */
export const INFERENCE_ERROR_CODES = [
  'PROVIDER_UNAVAILABLE',
  'MODEL_NOT_FOUND',
  'CAPABILITY_UNSUPPORTED',
  'INVALID_RESPONSE',
  'INVALID_SCHEMA',
  'TIMEOUT',
  'CANCELLED',
  'WORKER_EXITED',
  'WORKER_UNAVAILABLE',
  'OVER_CAPACITY',
  'RETRIES_EXHAUSTED',
  'TOOL_NOT_ALLOWED',
  'TOOL_INVALID_ARGUMENTS',
  'TOOL_TIMEOUT',
  'TOOL_FAILED',
  'LIMIT_EXCEEDED',
  'INTERNAL',
] as const;

export const inferenceErrorCodeSchema = z.enum(INFERENCE_ERROR_CODES);

export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number];

export const inferenceErrorSchema = z.object({
  code: inferenceErrorCodeSchema,
  message: z.string().min(1).max(500),
});
export type InferenceError = z.infer<typeof inferenceErrorSchema>;

// --- Capabilities / provider status ----------------------------------------

export const capabilitySupportSchema = z.enum([
  'supported',
  'unsupported',
  'unknown',
]);
export type CapabilitySupport = z.infer<typeof capabilitySupportSchema>;

export const providerCapabilitiesSchema = z.object({
  text: capabilitySupportSchema,
  streaming: capabilitySupportSchema,
  structuredOutput: capabilitySupportSchema,
  tools: capabilitySupportSchema,
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerKindSchema = z.enum(['mock', 'ollama', 'cloud']);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const providerStateSchema = z.enum([
  'ready',
  'not_installed',
  'not_running',
  'unconfigured',
  'error',
  'unknown',
]);
export type ProviderState = z.infer<typeof providerStateSchema>;

export const providerStatusSchema = z.object({
  providerId: z.string().min(1).max(64),
  kind: providerKindSchema,
  configured: z.boolean(),
  reachable: z.boolean(),
  runtimeVersion: z.string().max(64).nullable().optional(),
  lastCheckedAt: z.string().min(1),
  state: providerStateSchema,
  messageCode: z.string().max(64).optional(),
  capabilities: providerCapabilitiesSchema,
  dev: z.boolean().optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

// --- Model descriptor (contract only in 006.1) ------------------------------

export const modelDescriptorSchema = z.object({
  providerId: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  locality: z.enum(['local', 'cloud', 'unknown']),
  installed: z.boolean(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  parameterSize: z.string().max(32).nullable().optional(),
  quantization: z.string().max(32).nullable().optional(),
  contextLength: z.number().int().positive().nullable().optional(),
  capabilities: providerCapabilitiesSchema.optional(),
});
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

/** Adapter-reported capacity; model maximum and runtime allocation differ. */
export const modelDetailsSchema = z.object({
  maxContextTokens: z.number().int().positive().nullable(),
  configuredContextTokens: z.number().int().positive().nullable(),
  supportsContextOverride: z.boolean(),
});
export type ModelDetails = z.infer<typeof modelDetailsSchema>;

// --- Model recommendations (006.2) ------------------------------------------

/** A conservative, qualified recommendation for one installed local model. */
export const modelRecommendationSchema = z.object({
  modelId: z.string().min(1).max(128),
  fit: z.enum(['likely', 'uncertain']),
  reasons: z.array(z.string().max(200)).max(16),
  warnings: z.array(z.string().max(200)).max(16),
});
export type ModelRecommendation = z.infer<typeof modelRecommendationSchema>;

export const modelRecommendationsSchema = z.object({
  items: z.array(modelRecommendationSchema).max(32),
  notes: z.array(z.string().max(200)).max(16),
});
export type ModelRecommendations = z.infer<typeof modelRecommendationsSchema>;

// --- Hardware profile -------------------------------------------------------

export const accelerationSchema = z.enum([
  'metal',
  'cuda',
  'rocm',
  'cpu',
  'unknown',
]);
export type Acceleration = z.infer<typeof accelerationSchema>;

export const hardwareProfileSchema = z.object({
  platform: z.string().min(1).max(32),
  architecture: z.string().min(1).max(32),
  cpuLogicalCount: z.number().int().positive(),
  totalMemoryBytes: z.number().int().nonnegative(),
  freeMemoryBytes: z.number().int().nonnegative(),
  freeDiskBytes: z.number().int().nonnegative().nullable(),
  capturedAt: z.string().min(1),
  osRelease: z.string().max(64).optional(),
  gpuName: z.string().max(128).nullable(),
  gpuMemoryBytes: z.number().int().nonnegative().nullable(),
  acceleration: accelerationSchema,
  notes: z.array(z.string().max(200)).max(16),
});
export type HardwareProfile = z.infer<typeof hardwareProfileSchema>;

// --- JSON value / bounded JSON Schema subset --------------------------------

/**
 * Keys rejected everywhere to avoid prototype pollution from untrusted JSON.
 */
export const FORBIDDEN_JSON_KEYS = ['__proto__', 'constructor', 'prototype'];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * Bounded JSON Schema subset accepted for structured output requests.
 * Recursive, bounded subset. Unsupported keywords are rejected, never ignored.
 */
export const JSON_SCHEMA_LIMITS = {
  depth: 10,
  nodes: 512,
  bytes: 64_000,
} as const;

export type JsonSchemaNode =
  | {
      type: 'string' | 'number' | 'integer' | 'boolean' | ['string', 'null'];
      enum?: (string | number | boolean)[];
      minLength?: number;
      maxLength?: number;
    }
  | { type: 'array'; items: JsonSchemaNode; maxItems?: number }
  | JsonSchemaObject;

export type JsonSchemaObject = {
  type: 'object';
  properties: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
};

/** Shared bounds for the JSON Schema subset; kept private to this contract. */
const JSON_SCHEMA_MAX_PROPERTIES = 64;
const JSON_SCHEMA_MAX_ENUM_VALUES = 64;
const JSON_SCHEMA_MAX_KEY_CHARS = 64;
const JSON_SCHEMA_MAX_STRING_LENGTH = 200_000;
const JSON_SCHEMA_MAX_ARRAY_ITEMS = 1000;

const stringLengthBound = z
  .number()
  .int()
  .nonnegative()
  .max(JSON_SCHEMA_MAX_STRING_LENGTH)
  .optional();

/** Length bounds apply to string types only and must not be inverted. */
const scalarNodeSchema = z
  .object({
    type: z.union([
      z.enum(['string', 'number', 'integer', 'boolean']),
      z.tuple([z.literal('string'), z.literal('null')]),
    ]),
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .max(JSON_SCHEMA_MAX_ENUM_VALUES)
      .optional(),
    minLength: stringLengthBound,
    maxLength: stringLengthBound,
  })
  .strict()
  .refine((node) => {
    const hasLengthBounds =
      node.minLength !== undefined || node.maxLength !== undefined;
    if (!hasLengthBounds) return true;

    const isStringType = node.type === 'string' || Array.isArray(node.type);
    const minLength = node.minLength ?? 0;
    const maxLength = node.maxLength ?? JSON_SCHEMA_MAX_STRING_LENGTH;

    return isStringType && minLength <= maxLength;
  });

function arrayNodeSchema(depth: number) {
  return z
    .object({
      type: z.literal('array'),
      items: schemaAt(depth + 1),
      maxItems: z
        .number()
        .int()
        .nonnegative()
        .max(JSON_SCHEMA_MAX_ARRAY_ITEMS)
        .optional(),
    })
    .strict();
}

const propertyKeySchema = z
  .string()
  .max(JSON_SCHEMA_MAX_KEY_CHARS)
  .refine((key) => !FORBIDDEN_JSON_KEYS.includes(key));

function objectNodeSchema(depth: number) {
  return z
    .object({
      type: z.literal('object'),
      properties: z
        .record(propertyKeySchema, schemaAt(depth + 1))
        .refine(
          (properties) =>
            Object.keys(properties).length <= JSON_SCHEMA_MAX_PROPERTIES,
        ),
      required: z
        .array(z.string().max(JSON_SCHEMA_MAX_KEY_CHARS))
        .max(JSON_SCHEMA_MAX_PROPERTIES)
        .optional(),
      additionalProperties: z.boolean().optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
      const hasUnknownRequired = node.required?.some(
        (key) => !Object.hasOwn(node.properties, key),
      );
      if (hasUnknownRequired) {
        ctx.addIssue({ code: 'custom', message: 'unknown required property' });
      }
    });
}

/** Schema for a node at `depth`; anything deeper than the limit is rejected. */
function schemaAt(depth: number): z.ZodType<JsonSchemaNode> {
  if (depth > JSON_SCHEMA_LIMITS.depth) return z.never();

  return z.lazy(() =>
    z.union([
      scalarNodeSchema,
      arrayNodeSchema(depth),
      objectNodeSchema(depth),
    ]),
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Iterative preflight that bounds node count and depth of an untrusted schema
 * before the recursive Zod parse, so hostile input cannot exhaust the stack.
 */
function isWithinJsonSchemaShapeLimits(value: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length) {
    const entry = stack.pop()!;
    nodes += 1;
    const exceedsLimits =
      nodes > JSON_SCHEMA_LIMITS.nodes ||
      entry.depth > JSON_SCHEMA_LIMITS.depth;
    if (exceedsLimits || !isPlainObject(entry.value)) return false;

    const node = entry.value;
    const childDepth = entry.depth + 1;

    if (node.type === 'object' && isPlainObject(node.properties)) {
      const children = Object.values(node.properties);
      if (children.length > JSON_SCHEMA_MAX_PROPERTIES) return false;
      for (const child of children) {
        stack.push({ value: child, depth: childDepth });
      }
    } else if (node.type === 'array') {
      stack.push({ value: node.items, depth: childDepth });
    }
  }

  return true;
}

export const jsonSchemaPropertySchema = schemaAt(1);

export const jsonSchemaObjectSchema: z.ZodType<JsonSchemaObject> =
  z.custom<JsonSchemaObject>((value) => {
    if (!isWithinJsonSchemaShapeLimits(value)) return false;

    try {
      return (
        JSON.stringify(value).length <= JSON_SCHEMA_LIMITS.bytes &&
        schemaAt(0).safeParse(value).success &&
        (value as JsonSchemaObject).type === 'object'
      );
    } catch {
      return false;
    }
  });

export const responseFormatSchema = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_schema'), schema: jsonSchemaObjectSchema }),
]);
export type ResponseFormat = z.infer<typeof responseFormatSchema>;

// --- Generation request / result -------------------------------------------

export const messageRoleSchema = z.enum([
  'system',
  'user',
  'assistant',
  'tool',
]);

export const generationMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.string().max(INFERENCE_LIMITS.maxMessageChars),
  name: z.string().max(64).optional(),
});
export type GenerationMessage = z.infer<typeof generationMessageSchema>;

export const generationLimitsSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .min(INFERENCE_LIMITS.minTimeoutMs)
    .max(INFERENCE_LIMITS.maxTimeoutMs)
    .optional(),
  maxOutputTokens: z.number().int().positive().max(100_000).optional(),
  /** Requested total context window, translated by the provider adapter. */
  contextTokens: z.number().int().positive().optional(),
});
export type GenerationLimits = z.infer<typeof generationLimitsSchema>;

export const generationRequestSchema = z.object({
  requestId: z.string().uuid(),
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  messages: z
    .array(generationMessageSchema)
    .min(1)
    .max(INFERENCE_LIMITS.maxMessages),
  responseFormat: responseFormatSchema.optional(),
  /**
   * Optional caller preference; omitted leaves the model/provider default
   * intact.
   */
  thinking: z.boolean().optional(),
  toolNames: z
    .array(z.string().min(1).max(80))
    .max(INFERENCE_LIMITS.maxToolNames)
    .optional(),
  limits: generationLimitsSchema.optional(),
});
export type GenerationRequest = z.infer<typeof generationRequestSchema>;

/** What callers pass to `generate()`; the service mints `requestId`. */
export type GenerationRequestInput = Omit<GenerationRequest, 'requestId'> & {
  requestId?: string;
};

export const generationStatusSchema = z.enum([
  'completed',
  'cancelled',
  'failed',
]);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const toolCallSchema = z.object({
  toolCallId: z.string().min(1).max(80),
  toolName: z.string().min(1).max(80),
  arguments: jsonValueSchema,
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable().optional(),
    outputTokens: z.number().int().nonnegative().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  })
  .nullable();
export type Usage = z.infer<typeof usageSchema>;

export const generationResultSchema = z.object({
  requestId: z.string().uuid(),
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  status: generationStatusSchema,
  output: z.union([z.string(), jsonValueSchema]).nullable(),
  toolCalls: z.array(toolCallSchema),
  usage: usageSchema,
  error: inferenceErrorSchema.optional(),
  /** Logical-entry retry accounting; absent on low-level worker results. */
  attemptsMade: z.number().int().nonnegative().max(3).optional(),
  maxRetries: z.number().int().min(0).max(2).optional(),
  lastErrorCode: inferenceErrorCodeSchema.optional(),
});
export type GenerationResult = z.infer<typeof generationResultSchema>;

// --- Generation events (streaming) -----------------------------------------

export const generationEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('started'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    providerId: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('delta'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    text: z.string().max(INFERENCE_LIMITS.maxMessageChars),
  }),
  /** Live model reasoning; never part of `output` and never persisted. */
  z.object({
    kind: z.literal('thinking_delta'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    text: z.string().max(INFERENCE_LIMITS.maxMessageChars),
  }),
  z.object({
    kind: z.literal('tool_request'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    toolCalls: z.array(toolCallSchema),
  }),
  z.object({
    kind: z.literal('tool_result'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    toolCallId: z.string().min(1).max(80),
    ok: z.boolean(),
  }),
  z.object({
    kind: z.literal('completed'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    output: z.union([z.string(), jsonValueSchema]).nullable(),
    usage: usageSchema,
  }),
  z.object({
    kind: z.literal('failed'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
    error: inferenceErrorSchema,
  }),
  z.object({
    kind: z.literal('cancelled'),
    requestId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    at: z.string().min(1),
  }),
]);
export type GenerationEvent = z.infer<typeof generationEventSchema>;

export const CANCEL_RESULTS = [
  'cancelled',
  'already_finished',
  'not_found',
] as const;

export const cancelResultSchema = z.object({
  requestId: z.string().uuid(),
  outcome: z.enum(CANCEL_RESULTS),
});
export type CancelResult = z.infer<typeof cancelResultSchema>;

// --- Public renderer IPC (status/hardware/providers only) -------------------

export const workerStateSchema = z.enum([
  'starting',
  'ready',
  'unavailable',
  'stopped',
]);
export type WorkerState = z.infer<typeof workerStateSchema>;

export const inferenceStatusGetInputSchema = z.object({}).strict();

export const inferenceStatusGetOutputSchema = z.object({
  worker: z.object({
    state: workerStateSchema,
    protocolVersion: z.literal(INFERENCE_PROTOCOL_VERSION),
  }),
  providers: z.array(providerStatusSchema),
});
export type InferenceStatusGetOutput = z.infer<
  typeof inferenceStatusGetOutputSchema
>;

export const inferenceHardwareGetInputSchema = z.object({}).strict();

export const inferenceHardwareGetOutputSchema = z.object({
  profile: hardwareProfileSchema,
});
export type InferenceHardwareGetOutput = z.infer<
  typeof inferenceHardwareGetOutputSchema
>;

export const inferenceProvidersListInputSchema = z.object({}).strict();

export const inferenceProvidersListOutputSchema = z.object({
  items: z.array(providerStatusSchema),
});
export type InferenceProvidersListOutput = z.infer<
  typeof inferenceProvidersListOutputSchema
>;

export const inferenceProviderHealthInputSchema = z
  .object({ providerId: z.string().min(1).max(64) })
  .strict();

export const inferenceProviderHealthOutputSchema = z.object({
  item: providerStatusSchema,
});
export type InferenceProviderHealthOutput = z.infer<
  typeof inferenceProviderHealthOutputSchema
>;

export const inferenceModelsListInputSchema = z
  .object({ providerId: z.string().min(1).max(64) })
  .strict();

export const inferenceModelsListOutputSchema = z.object({
  items: z.array(modelDescriptorSchema),
});
export type InferenceModelsListOutput = z.infer<
  typeof inferenceModelsListOutputSchema
>;

export const inferenceModelsRecommendInputSchema = z
  .object({ providerId: z.string().min(1).max(64) })
  .strict();

export const inferenceModelsRecommendOutputSchema = modelRecommendationsSchema;
export type InferenceModelsRecommendOutput = z.infer<
  typeof inferenceModelsRecommendOutputSchema
>;

// --- Local AI user preferences (006.4) --------------------------------------

/**
 * Settings storage key for the single, local-only inference preference blob.
 */
export const INFERENCE_SETTINGS_KEY = 'inference.preferences';

/**
 * Inference operating mode. Only `local_only` is active; others are reserved.
 */
export const inferenceModeSchema = z.enum(['local_only']);
export type InferenceMode = z.infer<typeof inferenceModeSchema>;

/**
 * User-selectable generation target; null in settings means the app default.
 */
const configurableTimeoutMsSchema = z
  .number()
  .int()
  .min(INFERENCE_LIMITS.minTimeoutMs)
  .max(INFERENCE_LIMITS.maxConfigurableTimeoutMs);

/**
 * Validated, non-secret, local-only inference preferences. `providerId`/
 * `modelId` are the user's saved selection; they are kept verbatim even when
 * the
 * model is no longer installed (resolution/availability is computed at runtime,
 * never by silently rewriting the saved choice). `generationTimeoutMs` is null
 * when the five-minute app target applies. Generation is cancelled after
 * twice the target; a per-call hard deadline may be shorter.
 */
export const inferenceSettingsSchema = z.object({
  mode: inferenceModeSchema,
  providerId: z.string().min(1).max(64).nullable(),
  modelId: z.string().min(1).max(128).nullable(),
  generationTimeoutMs: configurableTimeoutMsSchema.nullable(),
  updatedAt: z.string().min(1),
});
export type InferenceSettings = z.infer<typeof inferenceSettingsSchema>;

/**
 * Partial update. A key absent from the patch leaves that field unchanged; an
 * explicit `null` clears the corresponding selection. This distinction is
 * meaningful and is preserved by the service.
 */
export const inferenceSettingsPatchSchema = z
  .object({
    mode: inferenceModeSchema.optional(),
    providerId: z.string().min(1).max(64).nullable().optional(),
    modelId: z.string().min(1).max(128).nullable().optional(),
    generationTimeoutMs: configurableTimeoutMsSchema.nullable().optional(),
  })
  .strict();
export type InferenceSettingsPatch = z.infer<
  typeof inferenceSettingsPatchSchema
>;

export const inferenceSettingsGetInputSchema = z.object({}).strict();

export const inferenceSettingsGetOutputSchema = z.object({
  settings: inferenceSettingsSchema,
  /**
   * The saved model resolved against the provider's live inventory, or null.
   */
  resolvedModel: modelDescriptorSchema.nullable(),
  /** Plain-language, non-sensitive advisories (e.g. selected model missing). */
  warnings: z.array(z.string().max(300)).max(16),
});
export type InferenceSettingsGetOutput = z.infer<
  typeof inferenceSettingsGetOutputSchema
>;

export const inferenceSettingsUpdateInputSchema = z
  .object({ patch: inferenceSettingsPatchSchema })
  .strict();

export const inferenceSettingsUpdateOutputSchema = z.object({
  settings: inferenceSettingsSchema,
});
export type InferenceSettingsUpdateOutput = z.infer<
  typeof inferenceSettingsUpdateOutputSchema
>;

// --- Diagnostics (safe inference operation summaries) -----------------------

export const inferenceOperationStatusSchema = z.enum([
  'success',
  'failure',
  'cancelled',
]);
export type InferenceOperationStatus = z.infer<
  typeof inferenceOperationStatusSchema
>;

/**
 * Privacy-safe projection of one recorded inference operation. Every field is
 * metadata only: no prompts, completions, tool arguments/results, file paths or
 * device identifiers ever appear here.
 */
export const inferenceOperationSummarySchema = z.object({
  id: z.string().min(1),
  operation: z.string().min(1).max(64),
  status: inferenceOperationStatusSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  firstTokenMs: z.number().int().nonnegative().nullable(),
  providerId: z.string().max(64).nullable(),
  modelId: z.string().max(128).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  toolCalls: z.number().int().nonnegative().nullable(),
  errorCode: z.string().max(64).nullable(),
});
export type InferenceOperationSummary = z.infer<
  typeof inferenceOperationSummarySchema
>;

export const INFERENCE_DIAGNOSTICS_MAX_LIMIT = 100;
export const INFERENCE_DIAGNOSTICS_DEFAULT_LIMIT = 50;

export const inferenceDiagnosticsListInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(INFERENCE_DIAGNOSTICS_MAX_LIMIT)
      .optional(),
  })
  .strict();

export const inferenceDiagnosticsListOutputSchema = z.object({
  items: z.array(inferenceOperationSummarySchema),
});
export type InferenceDiagnosticsListOutput = z.infer<
  typeof inferenceDiagnosticsListOutputSchema
>;

// --- Opt-in connectivity test ----------------------------------------------

/** The single fixed, app-controlled prompt used by the local inference test. */
export const INFERENCE_TEST_PROMPT = 'Reply with exactly: OK';

export const inferenceTestStatusSchema = z.enum([
  'running',
  'completed',
  'cancelled',
  'failed',
]);
export type InferenceTestStatus = z.infer<typeof inferenceTestStatusSchema>;

/**
 * Live, ephemeral snapshot of a user-triggered connectivity test. Never
 * persisted; `replyPreview` is a short, bounded echo of the model's reply shown
 * only in the live UI so the outcome is honest. This is a connectivity/
 * functionality check, not a model-quality benchmark.
 */
export const inferenceTestSnapshotSchema = z.object({
  testId: z.string().uuid(),
  status: inferenceTestStatusSchema,
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(200),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  firstTokenMs: z.number().int().nonnegative().nullable(),
  passed: z.boolean().nullable(),
  replyPreview: z.string().max(200).nullable(),
  errorCode: inferenceErrorCodeSchema.nullable(),
});
export type InferenceTestSnapshot = z.infer<typeof inferenceTestSnapshotSchema>;

export const inferenceTestRunInputSchema = z.object({}).strict();

export const inferenceTestRunOutputSchema = z.object({
  testId: z.string().uuid(),
  status: z.literal('started'),
});
export type InferenceTestRunOutput = z.infer<
  typeof inferenceTestRunOutputSchema
>;

export const inferenceTestGetInputSchema = z
  .object({ testId: z.string().uuid() })
  .strict();

export const inferenceTestGetOutputSchema = z.object({
  test: inferenceTestSnapshotSchema,
});
export type InferenceTestGetOutput = z.infer<
  typeof inferenceTestGetOutputSchema
>;

export const inferenceTestCancelInputSchema = z
  .object({ testId: z.string().uuid() })
  .strict();

export const inferenceTestCancelOutputSchema = z.object({
  cancelled: z.boolean(),
});
export type InferenceTestCancelOutput = z.infer<
  typeof inferenceTestCancelOutputSchema
>;
