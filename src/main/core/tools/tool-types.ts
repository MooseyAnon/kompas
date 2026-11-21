import type { z } from 'zod';
import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolEffect,
  ToolPermission,
} from '../../../shared/contracts';

/** Context passed to a tool handler for one authorised call. */
export interface ToolHandlerContext {
  runId: string;

  callerModule: string;

  contextId?: string;
}

/** The caller identity used for discovery/authorisation. */
export interface ToolCallerContext {
  callerModule: string;

  contextId?: string;
}

/**
 * A tool registration as supplied by an owning domain module. The handler is a
 * typed in-process function; it is never serialised to the worker, provider or
 * renderer. Input/output are validated with Zod on every call; `jsonInputSchema`
 * is the bounded JSON-Schema-subset representation presented to providers.
 */
export interface ToolRegistration<Args = unknown, Out = unknown> {
  name: string;

  version: number;

  ownerModule: string;

  description: string;

  inputSchema: z.ZodType<Args>;

  jsonInputSchema: JsonSchemaObject;

  outputSchema: z.ZodType<Out>;

  effect: ToolEffect;

  permission: ToolPermission;

  timeoutMs: number;

  maxResultBytes: number;

  maxCallsPerRun: number;

  /** Non-owner caller contexts/workflows permitted to use this tool. */
  allowlistContexts?: string[];

  handle: (args: Args, context: ToolHandlerContext) => Promise<Out> | Out;
}

/** A normalised, registered tool held by the registry. */
export type RegisteredTool = ToolRegistration;

/** Reduce a registered tool to its safe, model-facing definition. */
export function toToolDefinition(tool: RegisteredTool): ToolDefinition {
  return {
    name: tool.name,
    version: tool.version,
    description: tool.description,
    inputSchema: tool.jsonInputSchema,
  };
}
