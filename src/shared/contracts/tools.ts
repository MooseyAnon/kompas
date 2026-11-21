import { z } from 'zod';
import {
  inferenceErrorSchema,
  jsonSchemaObjectSchema,
  jsonValueSchema,
} from './inference';

/**
 * Provider-independent tool contract — v1 (Stage 006.3).
 *
 * These are the schemas shared across the trust boundary: the model-facing
 * tool *definition* (what the worker/provider may see), and the *invocation* /
 * *result* envelopes exchanged over the internal worker transport. The actual
 * tool handler, Zod input/output schemas and permission policy live only in the
 * main-process registry/broker and are never serialised to the worker or the
 * renderer.
 */

/**
 * Tool name: namespace-qualified, stable, lower-case. e.g.
 * `examples.add_numbers`.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,79}$/;
export const toolNameSchema = z.string().regex(TOOL_NAME_PATTERN);

/** What a tool does to the world. Separate dimension from permission. */
export const toolEffectSchema = z.enum(['read', 'write', 'external_action']);
export type ToolEffect = z.infer<typeof toolEffectSchema>;

/**
 * Whether a tool may run, and how. Default for anything unrecognised is denied.
 */
export const toolPermissionSchema = z.enum([
  'automatic',
  'approval_required',
  'disabled',
]);
export type ToolPermission = z.infer<typeof toolPermissionSchema>;

const TOOL_CALL_FIELD_MAX = 80;

/** Shared by invocation and result so a result can be matched to its call. */
const toolCallIdSchema = z.string().min(1).max(TOOL_CALL_FIELD_MAX);
const toolCallNameSchema = z.string().min(1).max(TOOL_CALL_FIELD_MAX);

/** Conservative bounds for the tool-call loop and payload sizes. */
export const TOOL_LIMITS = {
  /** Default bounded reasoning steps per run before forced termination. */
  defaultMaxSteps: 3,
  /** Hard ceiling regardless of caller request. */
  hardMaxSteps: 8,
  /** Default total tool calls per run. */
  defaultMaxToolCalls: 4,
  /** Hard ceiling on total tool calls per run. */
  hardMaxToolCalls: 16,
  /** Default/hard ceiling on calls to a single tool within one run. */
  defaultMaxCallsPerTool: 3,
  /** Maximum serialised argument size accepted from a provider proposal. */
  maxArgBytes: 8 * 1024,
  /** Default tool execution deadline. */
  defaultTimeoutMs: 5_000,
  /** Hard ceiling on a single tool execution deadline. */
  maxTimeoutMs: 30_000,
  /** Default/hard ceiling on a validated tool result size. */
  defaultMaxResultBytes: 16 * 1024,
  maxResultBytes: 64 * 1024,
  /** Maximum tool definitions presented to a provider in one run. */
  maxToolDefinitions: 32,
} as const;

/**
 * The safe, model-facing description of a tool. Only these fields cross into
 * the worker/provider; no handler, permission or owner authority is exposed.
 */
export const toolDefinitionSchema = z.object({
  name: toolNameSchema,
  version: z.number().int().positive(),
  description: z.string().min(1).max(500),
  inputSchema: jsonSchemaObjectSchema,
});
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

/**
 * A single proposed tool call, normalised from an untrusted provider proposal.
 * Arguments are untrusted JSON and are validated by the broker before use.
 */
export const toolInvocationSchema = z.object({
  toolCallId: toolCallIdSchema,
  toolName: toolCallNameSchema,
  version: z.number().int().positive(),
  arguments: jsonValueSchema,
});
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;

/**
 * Outcome of one tool call. On failure `error` carries a safe error; no raw
 * vendor text is ever included.
 */
export const toolResultSchema = z.object({
  toolCallId: toolCallIdSchema,
  toolName: toolCallNameSchema,
  ok: z.boolean(),
  data: jsonValueSchema.nullable().optional(),
  error: inferenceErrorSchema.optional(),
  durationMs: z.number().int().nonnegative(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

/** Per-run loop bounds handed to the worker (also enforced by the broker). */
export const toolPolicySchema = z.object({
  maxSteps: z.number().int().positive().max(TOOL_LIMITS.hardMaxSteps),
  maxToolCalls: z.number().int().positive().max(TOOL_LIMITS.hardMaxToolCalls),
  maxCallsPerTool: z
    .number()
    .int()
    .positive()
    .max(TOOL_LIMITS.defaultMaxCallsPerTool),
});
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
