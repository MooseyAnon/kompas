import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/main/modules/web/adapter-registry';
import type { WebAdapter } from '../src/main/modules/web/capabilities';

function searchAdapter(id: string): WebAdapter {
  return {
    id,
    capabilities: ['search'],
    async search() {
      return [];
    },
  };
}

describe('web adapter registry', () => {
  it('accepts a search-only adapter and exposes it for the capability', () => {
    const registry = new AdapterRegistry([searchAdapter('dds')]);
    expect(registry.has('dds')).toBe(true);
    expect(registry.supporting('search').map((a) => a.id)).toEqual(['dds']);
    expect(registry.supporting('readPage')).toEqual([]);
  });

  it('rejects a duplicate adapter id', () => {
    const registry = new AdapterRegistry([searchAdapter('dds')]);
    expect(() => registry.register(searchAdapter('dds'))).toThrow(/Duplicate/);
  });

  it('rejects an adapter declaring a capability with no handler', () => {
    const bad: WebAdapter = {
      id: 'broken',
      capabilities: ['search'],
      // no search handler
    };
    expect(() => new AdapterRegistry([bad])).toThrow(/no handler/);
  });

  it('rejects a reader capability without a readPage handler', () => {
    const bad: WebAdapter = {
      id: 'reader',
      capabilities: ['readPage'],
    };
    expect(() => new AdapterRegistry([bad])).toThrow(/no handler/);
  });

  it('rejects an empty id and empty capability list', () => {
    expect(
      () =>
        new AdapterRegistry([
          { id: '', capabilities: ['search'], search: async () => [] },
        ]),
    ).toThrow(/non-empty/);
    expect(() => new AdapterRegistry([{ id: 'x', capabilities: [] }])).toThrow(
      /no capabilities/,
    );
  });

  it('accepts an adapter advertising both capabilities when both handlers exist', () => {
    const both: WebAdapter = {
      id: 'playwright',
      capabilities: ['search', 'readPage'],
      async search() {
        return [];
      },
      async readPage() {
        return {};
      },
    };
    const registry = new AdapterRegistry([both]);
    expect(registry.supporting('search').map((a) => a.id)).toEqual([
      'playwright',
    ]);
    expect(registry.supporting('readPage').map((a) => a.id)).toEqual([
      'playwright',
    ]);
  });
});
