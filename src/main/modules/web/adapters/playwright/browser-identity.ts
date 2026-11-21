/**
 * Pure User-Agent normalization for the Playwright engine. No browser or
 * `playwright-core` dependency, so it is unit-testable.
 *
 * New headless Chrome is the real Chrome binary. In a secure context its
 * `Sec-CH-UA` client-hint brands are already a normal `"Google Chrome"`
 * identity — the browser's *only* automation tell is the literal
 * `HeadlessChrome` **product token in the UA string**. We therefore normalize
 * just that token and leave the browser's native client hints untouched (forcing
 * them, especially unsolicited high-entropy hints, would be redundant and could
 * itself look abnormal).
 */

export interface BrowserIdentity {
  /** Normalized UA, or `undefined` to leave the browser default unchanged. */
  userAgent?: string;
}

/** Normalize a UA string by replacing only the `HeadlessChrome` product token. */
export function normalizeUserAgent(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome/g, 'Chrome');
}

/** Build the normalized identity from the browser's own UA (if any). */
export function buildIdentity(userAgent: string): BrowserIdentity {
  return userAgent ? { userAgent: normalizeUserAgent(userAgent) } : {};
}
