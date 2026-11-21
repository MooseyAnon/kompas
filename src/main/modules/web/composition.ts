import type { WebBrowsersListOutput } from '../../../shared/contracts';
import type { TelemetryService } from '../telemetry/telemetry.service';
import { AdapterRegistry } from './adapter-registry';
import { createDdsSearchAdapter } from './adapters/dds-adapter';
import { createPlaywrightAdapter } from './adapters/playwright/playwright-adapter';
import { createPlaywrightEngine } from './adapters/playwright/playwright-engine';
import type { BrowserEngine } from './adapters/playwright/types';
import { WebService } from './web.service';

/**
 * Environment flag that enables the bounded, smoke-only loopback exception for
 * `readPage`. It lets the packaged smoke harness read a local fixture server
 * over `127.0.0.1`. It is NEVER set in ordinary production use; a negative test
 * asserts that loopback URLs are rejected when it is unset.
 */
const LOOPBACK_FIXTURE_FLAG = 'CW_ALLOW_LOOPBACK_FIXTURES';

/**
 * Production composition for the Web domain. This is the only layer (besides the
 * adapters themselves) permitted to know which concrete adapters exist.
 *
 * Stage 009.2 registers both the `duck-duck-scrape` search adapter and the
 * Playwright adapter (which implements `readPage` and a fallback `search`),
 * without changing the public WebService API.
 */
export function createDefaultWebService(
  options: {
    telemetry?: TelemetryService;
    /** Injectable engine for tests; defaults to the real playwright-core engine. */
    engine?: BrowserEngine;
    /** Explicit loopback override for tests; defaults to the env flag. */
    allowLoopback?: boolean;
  } = {},
): WebService {
  const engine = options.engine ?? createPlaywrightEngine();
  const allowLoopback =
    options.allowLoopback ?? process.env[LOOPBACK_FIXTURE_FLAG] === '1';

  const playwright = createPlaywrightAdapter({ engine, allowLoopback });

  const registry = new AdapterRegistry([
    createDdsSearchAdapter(),
    playwright.adapter,
  ]);

  const browserInventory: () => Promise<WebBrowsersListOutput> = async () => {
    const inventory = await playwright.inventory();

    return inventory.selectedId
      ? { browsers: inventory.browsers, selectedId: inventory.selectedId }
      : { browsers: inventory.browsers };
  };

  return new WebService({
    registry,
    telemetry: options.telemetry,
    browserInventory,
    shutdownBrowser: () => engine.shutdown?.() ?? Promise.resolve(),
  });
}
