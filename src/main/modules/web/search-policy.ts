/** Main-process policy: no renderer or saved-search field can change these limits. */
export const SEARCH_POLICY = Object.freeze({
  minGapMs: 5_000,
  maxGapMs: 65_000,
  maxQueued: 32,
  maxWaitMs: 10 * 60_000,
  attemptTimeoutMs: 20_000,
});

export interface SearchPolicy {
  minGapMs: number;
  maxGapMs: number;
  maxQueued: number;
  maxWaitMs: number;
  attemptTimeoutMs: number;
}

/** Reject non-integer, negative or internally inconsistent policies. */
export function validateSearchPolicy(policy: SearchPolicy): void {
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Web search policy.');
    }
  }

  if (
    policy.maxGapMs < policy.minGapMs ||
    policy.maxQueued < 1 ||
    policy.maxWaitMs < 1 ||
    policy.attemptTimeoutMs < 1
  ) {
    throw new Error('Invalid Web search policy.');
  }
}
