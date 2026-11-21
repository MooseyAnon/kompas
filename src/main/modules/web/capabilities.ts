import type { SearchResult, WebCapability } from '../../../shared/contracts';

/**
 * Bounded execution context passed to every adapter handler. `signal` carries
 * cancellation; `deadline` is an absolute `Date.now()` millisecond budget
 * shared across all attempts of one resolve.
 */
export interface CapabilityContext {
  signal: AbortSignal;
  deadline: number;
}

/**
 * An adapter advertises a stable `id` and the subset of capabilities it
 * implements, and provides a callable handler for *only* those capabilities.
 * It is never named or typed as its sole capability, so future adapters may
 * implement any subset (or both) without contract changes.
 */
export interface WebAdapter {
  readonly id: string;
  readonly capabilities: readonly WebCapability[];
  /**
   * Read-only availability probe. Returning `false` (or throwing) causes the
   * resolver to skip this adapter and try the next without recording a failure.
   */
  isAvailable?(): boolean | Promise<boolean>;
  /** Present iff `capabilities` includes `'search'`. */
  search?(query: string, ctx: CapabilityContext): Promise<SearchResult[]>;
  /** Present iff `capabilities` includes `'readPage'` (Stage 009.2). */
  readPage?(url: string, ctx: CapabilityContext): Promise<unknown>;
}

/** Map a capability to the adapter method that implements it. */
export const CAPABILITY_HANDLER: Record<WebCapability, keyof WebAdapter> = {
  search: 'search',
  readPage: 'readPage',
};
