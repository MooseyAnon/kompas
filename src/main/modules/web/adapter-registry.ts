import type { WebCapability } from '../../../shared/contracts';
import { CAPABILITY_HANDLER, type WebAdapter } from './capabilities';

/**
 * Registry of web adapters. Validates at registration that:
 *  - adapter IDs are unique;
 *  - every declared capability has a matching callable handler;
 *  - no handler is advertised that the adapter does not implement.
 *
 * The registry never imports a concrete adapter; composition supplies them.
 */
export class AdapterRegistry {
  private readonly byId = new Map<string, WebAdapter>();

  constructor(adapters: WebAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: WebAdapter): void {
    const id = adapter.id?.trim();
    if (!id) {
      throw new Error('Web adapter id must be a non-empty string.');
    }

    if (this.byId.has(id)) {
      throw new Error(`Duplicate web adapter id: ${id}`);
    }

    if (adapter.capabilities.length === 0) {
      throw new Error(`Web adapter "${id}" declares no capabilities.`);
    }

    const seen = new Set<WebCapability>();
    for (const capability of adapter.capabilities) {
      if (seen.has(capability)) {
        throw new Error(
          `Web adapter "${id}" declares capability "${capability}" twice.`,
        );
      }
      seen.add(capability);

      const handlerName = CAPABILITY_HANDLER[capability];
      if (typeof adapter[handlerName] !== 'function') {
        throw new Error(
          `Web adapter "${id}" declares "${capability}" but has no handler.`,
        );
      }
    }

    this.byId.set(id, adapter);
  }

  get(id: string): WebAdapter | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** All registered adapters that implement the given capability. */
  supporting(capability: WebCapability): WebAdapter[] {
    const handlerName = CAPABILITY_HANDLER[capability];

    return [...this.byId.values()].filter(
      (adapter) =>
        adapter.capabilities.includes(capability) &&
        typeof adapter[handlerName] === 'function',
    );
  }
}
