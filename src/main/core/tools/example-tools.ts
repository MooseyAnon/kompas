import { z } from 'zod';
import type { JsonSchemaObject } from '../../../shared/contracts';
import type { ToolRegistry } from './tool-registry';
import type { ToolRegistration } from './tool-types';

/**
 * Deterministic, synthetic tools used to exercise the tool broker/worker loop.
 *
 * These are intentionally trivial and side-effect-free. They are registered
 * ONLY behind an explicit dev/smoke flag (see {@link registerExampleTools}
 * callers) and are never reachable in ordinary production use. No production
 * `execute_shell`, `read_any_file`, `search_browser` or profile-dump tool is
 * registered here.
 */
export const EXAMPLES_MODULE_ID = 'examples';

export const EXAMPLE_TOOL_NAMES = {
  addNumbers: 'examples.add_numbers',
  echo: 'examples.echo',
  writeNote: 'examples.write_note',
  sleep: 'examples.sleep',
  throwError: 'examples.throw_error',
  badOutput: 'examples.bad_output',
} as const;

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_RESULT_BYTES = 1_024;
const SMALL_RESULT_BYTES = 256;

const addNumbersJsonSchema: JsonSchemaObject = {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
  additionalProperties: false,
};

const echoJsonSchema: JsonSchemaObject = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const writeNoteJsonSchema: JsonSchemaObject = {
  type: 'object',
  properties: { note: { type: 'string' } },
  required: ['note'],
  additionalProperties: false,
};

const emptyJsonSchema: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** The read-only, automatic addition tool required by the stage acceptance. */
export const addNumbersTool: ToolRegistration = {
  name: EXAMPLE_TOOL_NAMES.addNumbers,
  version: 1,
  ownerModule: EXAMPLES_MODULE_ID,
  description: 'Add two numbers and return their sum.',
  inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
  jsonInputSchema: addNumbersJsonSchema,
  outputSchema: z.object({ sum: z.number() }).strict(),
  effect: 'read',
  permission: 'automatic',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxResultBytes: DEFAULT_RESULT_BYTES,
  maxCallsPerRun: 3,
  handle: (args) => {
    const { a, b } = args as { a: number; b: number };

    return { sum: a + b };
  },
};

/** A read tool that returns only the length of its input (never the text). */
export const echoTool: ToolRegistration = {
  name: EXAMPLE_TOOL_NAMES.echo,
  version: 1,
  ownerModule: EXAMPLES_MODULE_ID,
  description: 'Return the character length of the supplied text.',
  inputSchema: z.object({ text: z.string().max(10_000) }).strict(),
  jsonInputSchema: echoJsonSchema,
  outputSchema: z.object({ length: z.number().int().nonnegative() }).strict(),
  effect: 'read',
  permission: 'automatic',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxResultBytes: DEFAULT_RESULT_BYTES,
  maxCallsPerRun: 3,
  handle: (args) => ({ length: (args as { text: string }).text.length }),
};

/** A write tool that must be denied without a trusted approval mechanism. */
export const writeNoteTool: ToolRegistration = {
  name: EXAMPLE_TOOL_NAMES.writeNote,
  version: 1,
  ownerModule: EXAMPLES_MODULE_ID,
  description: 'Persist a short note (requires explicit approval).',
  inputSchema: z.object({ note: z.string().max(500) }).strict(),
  jsonInputSchema: writeNoteJsonSchema,
  outputSchema: z.object({ saved: z.boolean() }).strict(),
  effect: 'write',
  permission: 'approval_required',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxResultBytes: SMALL_RESULT_BYTES,
  maxCallsPerRun: 1,
  handle: () => ({ saved: true }),
};

/** A read tool whose handler overruns its deadline (for TOOL_TIMEOUT tests). */
export const sleepTool: ToolRegistration = {
  name: EXAMPLE_TOOL_NAMES.sleep,
  version: 1,
  ownerModule: EXAMPLES_MODULE_ID,
  description: 'Sleep briefly (used to exercise the execution deadline).',
  inputSchema: z.object({}).strict(),
  jsonInputSchema: emptyJsonSchema,
  outputSchema: z.object({ done: z.boolean() }).strict(),
  effect: 'read',
  permission: 'automatic',
  timeoutMs: 20,
  maxResultBytes: SMALL_RESULT_BYTES,
  maxCallsPerRun: 2,
  handle: () =>
    new Promise((resolve) => setTimeout(() => resolve({ done: true }), 500)),
};

/** A read tool whose handler throws (for TOOL_FAILED tests). */
export const throwErrorTool: ToolRegistration = {
  name: EXAMPLE_TOOL_NAMES.throwError,
  version: 1,
  ownerModule: EXAMPLES_MODULE_ID,
  description: 'Always throw (used to exercise safe failure handling).',
  inputSchema: z.object({}).strict(),
  jsonInputSchema: emptyJsonSchema,
  outputSchema: z.object({}).strict(),
  effect: 'read',
  permission: 'automatic',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxResultBytes: SMALL_RESULT_BYTES,
  maxCallsPerRun: 2,
  handle: () => {
    throw new Error('synthetic handler failure');
  },
};

/** A read tool returning a value that violates its own output schema. */
export const badOutputTool: ToolRegistration = {
  name: EXAMPLE_TOOL_NAMES.badOutput,
  version: 1,
  ownerModule: EXAMPLES_MODULE_ID,
  description: 'Return a value that fails output validation.',
  inputSchema: z.object({}).strict(),
  jsonInputSchema: emptyJsonSchema,
  outputSchema: z.object({ value: z.number() }).strict(),
  effect: 'read',
  permission: 'automatic',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxResultBytes: SMALL_RESULT_BYTES,
  maxCallsPerRun: 2,
  handle: () => ({ unexpected: true }),
};

export const EXAMPLE_TOOLS: ToolRegistration[] = [
  addNumbersTool,
  echoTool,
  writeNoteTool,
  sleepTool,
  throwErrorTool,
  badOutputTool,
];

/** Register all synthetic example tools on a registry (dev/test-only). */
export function registerExampleTools(registry: ToolRegistry): void {
  for (const tool of EXAMPLE_TOOLS) {
    registry.register(tool);
  }
}
