import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/main/core/tools/tool-registry';
import {
  EXAMPLE_TOOL_NAMES,
  addNumbersTool,
  registerExampleTools,
} from '../src/main/core/tools/example-tools';
import type { ToolRegistration } from '../src/main/core/tools/tool-types';

function baseTool(overrides: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    name: 'examples.add_numbers',
    version: 1,
    ownerModule: 'examples',
    description: 'Add two numbers.',
    inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
    jsonInputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    outputSchema: z.object({ sum: z.number() }).strict(),
    effect: 'read',
    permission: 'automatic',
    timeoutMs: 1000,
    maxResultBytes: 1024,
    maxCallsPerRun: 3,
    handle: (args) => ({ sum: (args as { a: number; b: number }).a }),
    ...overrides,
  };
}

describe('ToolRegistry registration', () => {
  it('registers a valid tool and exposes it via listAll', () => {
    const registry = new ToolRegistry();
    registry.register(baseTool());
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.has('examples.add_numbers')).toBe(true);
  });

  it('rejects a duplicate tool name', () => {
    const registry = new ToolRegistry();
    registry.register(baseTool());
    expect(() => registry.register(baseTool())).toThrow();
  });

  it('rejects an invalid (non-namespaced) name', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(baseTool({ name: 'Bad Name' }))).toThrow();
    expect(() => registry.register(baseTool({ name: 'ab' }))).toThrow();
  });

  it('rejects a non-positive version', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(baseTool({ version: 0 }))).toThrow();
  });

  it('rejects an out-of-range timeout or result budget', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(baseTool({ timeoutMs: 10_000_000 })),
    ).toThrow();
    expect(() => registry.register(baseTool({ maxResultBytes: 0 }))).toThrow();
  });
});

describe('ToolRegistry discovery (default-deny)', () => {
  it('lists only owner-allowed and context-allowed tools', () => {
    const registry = new ToolRegistry();
    registerExampleTools(registry);

    // The owner sees its read/write tools (write still requires approval later).
    const ownerAllowed = registry
      .listAllowed({ callerModule: 'examples' })
      .map((t) => t.name);
    expect(ownerAllowed).toContain(EXAMPLE_TOOL_NAMES.addNumbers);

    // A different module with no allowlist grant sees nothing.
    const strangerAllowed = registry.listAllowed({ callerModule: 'identity' });
    expect(strangerAllowed).toHaveLength(0);
  });

  it('honours allowlistContexts for non-owner callers', () => {
    const registry = new ToolRegistry();
    registry.register(
      baseTool({
        name: 'examples.shared_tool',
        allowlistContexts: ['interviews'],
      }),
    );
    expect(
      registry.listAllowed({ callerModule: 'interviews' }).map((t) => t.name),
    ).toContain('examples.shared_tool');
    expect(registry.listAllowed({ callerModule: 'documents' })).toHaveLength(0);
  });

  it('never lists a disabled tool', () => {
    const registry = new ToolRegistry();
    const handle = vi.fn();
    registry.register(
      baseTool({
        name: 'examples.disabled_tool',
        permission: 'disabled',
        handle,
      }),
    );
    expect(registry.listAllowed({ callerModule: 'examples' })).toHaveLength(0);
  });

  it('reduces a tool to a safe model-facing definition only', () => {
    const registry = new ToolRegistry();
    registry.register(addNumbersTool);
    const [def] = registry.listAllowed({ callerModule: 'examples' });
    expect(Object.keys(def).sort()).toEqual([
      'description',
      'inputSchema',
      'name',
      'version',
    ]);
  });
});
