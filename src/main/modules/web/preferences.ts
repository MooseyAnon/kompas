import type { WebCapability } from '../../../shared/contracts';

/**
 * Stable adapter IDs. Kept here so preferences and composition reference the
 * same constants; consuming modules never see these.
 */
export const DDS_ADAPTER_ID = 'duck-duck-scrape';
export const PLAYWRIGHT_ADAPTER_ID = 'playwright';

/**
 * Central, static per-capability preference policy — the single place that
 * declares adapter ordering. It is *data*, not conditional branches inside
 * `search`/`readPage`. Unregistered or non-capable IDs are skipped by the
 * resolver. Reordering here never changes the public WebService API.
 *
 * `playwright` is the **preferred** search adapter: it runs the query through a
 * real installed browser (DuckDuckGo), which is not rejected by the anti-bot
 * anomaly detection that currently blocks the headless `duck-duck-scrape`
 * HTTP client from our IP. `duck-duck-scrape` is kept as the lower-priority
 * fallback (used automatically when no supported browser is installed — see
 * `BROWSER_UNAVAILABLE` being retryable) and can be promoted again once the
 * anomaly-detection block is solved.
 */
export const CAPABILITY_PREFERENCES: Record<WebCapability, readonly string[]> =
  {
    search: [PLAYWRIGHT_ADAPTER_ID, DDS_ADAPTER_ID],
    readPage: [PLAYWRIGHT_ADAPTER_ID],
  };
