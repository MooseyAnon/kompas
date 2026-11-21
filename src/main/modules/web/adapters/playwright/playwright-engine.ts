import type { BrowserContext, Page, Route } from 'playwright-core';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  BrowserInfo,
  WebBrowserId,
} from '../../../../../shared/contracts';
import { WEB_LIMITS } from '../../../../../shared/contracts';
import { isAllowedRequestUrl } from '../../url-safety';
import { WebError } from '../../web.error';
import {
  createBrowserResolver,
  selectLaunchableBrowser,
  type InstalledBrowser,
  type PlatformBrowserResolver,
} from './browser-resolver';
import { buildIdentity, type BrowserIdentity } from './browser-identity';
import {
  DUCKDUCKGO_EXTRACTION,
  SEARCH_READY_SELECTOR,
} from './search-strategy';
import type {
  BrowserEngine,
  BrowserInventory,
  OpenPageOptions,
  PageHandle,
  SearchExtraction,
} from './types';

const LAUNCH_TIMEOUT_MS = 15_000;
export const BROWSER_IDLE_MS = 120_000;
const MAX_ACTIVE_PAGES = 2;
const MAX_QUEUED_PAGES = 8;

/** Upper bound on waiting for the search results view to render. */
const SEARCH_READY_MAX_MS = 10_000;

/** Short settle so a just-appeared result is fully populated before read. */
const SEARCH_SETTLE_MS = 500;

/**
 * Launch args. We use Chrome's **new** headless mode (`--headless=new`) — the
 * real Chrome code path (real GPU, `window.chrome`), not the old
 * `chrome-headless-shell`. It is passed to the browser directly; Playwright is
 * launched with `headless: false` so it does not inject the old headless flag.
 * No window exists, so no window-position/throttling args are needed.
 */
const NEW_HEADLESS_ARGS = ['--headless=new'];

/** Minimal surface of `playwright-core` we depend on (lazy-loaded). */
interface ChromiumLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: {
      channel?: string;
      headless?: boolean;
      timeout?: number;
      args?: string[];
      acceptDownloads: boolean;
      serviceWorkers: 'block';
      bypassCSP: boolean;
      ignoreHTTPSErrors: boolean;
      javaScriptEnabled: boolean;
    },
  ): Promise<BrowserContext>;
}

export interface PlaywrightEngineDeps {
  resolver?: PlatformBrowserResolver;
  /** Injectable Chromium launcher (defaults to lazy `playwright-core`). */
  launchChromium?: ChromiumLauncher['launchPersistentContext'];
  /** Defaults lazily to Electron's app.getPath('userData'). */
  userDataPath?: string;
}

interface RunningBrowser {
  context: BrowserContext;
  channel: string;
  identity: Promise<BrowserIdentity>;
}

/**
 * Production {@link BrowserEngine} backed by `playwright-core` driving an
 * **installed** Chrome/Edge via launch channels. No browser is bundled or
 * downloaded. All Playwright types are confined to this file.
 */
export function createPlaywrightEngine(
  deps: PlaywrightEngineDeps = {},
): BrowserEngine {
  const engine = new PlaywrightEngine(deps);

  return {
    inventory: (options) => engine.inventory(options),
    open: (url, options) => engine.open(url, options),
    shutdown: () => engine.shutdown(),
  };
}

class PlaywrightEngine {
  private readonly resolver: PlatformBrowserResolver;
  private running: RunningBrowser | undefined;
  private launching: Promise<RunningBrowser> | undefined;
  private closing: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Page slots currently held by open operations. */
  private active = 0;
  private readonly pages = new Set<Page>();
  /** FIFO of slot grants for operations waiting on {@link MAX_ACTIVE_PAGES}. */
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly deps: PlaywrightEngineDeps) {
    this.resolver = deps.resolver ?? createBrowserResolver();
  }

  private throwIfStopped(): void {
    if (this.stopped) throw new WebError('CANCELLED');
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private startIdleTimer(): void {
    if (this.stopped || this.active !== 0 || !this.running) return;

    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.active === 0) void this.closeBrowser();
    }, BROWSER_IDLE_MS);
  }

  private closeBrowser(): Promise<void> {
    this.clearIdleTimer();
    if (!this.running) return this.closing ?? Promise.resolve();

    const instance = this.running;
    this.running = undefined;
    this.closing = instance.context
      .close()
      .catch(() => {})
      .then(() => {
        this.closing = undefined;
      });

    return this.closing;
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.waiting[0]?.();
    this.startIdleTimer();
  }

  private async launch(channel: string): Promise<BrowserContext> {
    const profilePath = join(
      this.deps.userDataPath ?? electronUserDataPath(),
      'web-browser-profiles',
      channel,
    );
    const options = launchOptions(channel);
    if (this.deps.launchChromium) {
      return this.deps.launchChromium(profilePath, options);
    }

    // Call the launcher on the chromium object so playwright keeps its `this`
    // binding (its internal `_playwright` wiring). Extracting the method
    // detaches the receiver and breaks the launcher.
    const chromium = await loadChromium();

    return chromium.launchPersistentContext(profilePath, options);
  }

  /** Return a connected browser for `channel`, launching it at most once. */
  private async acquireBrowser(channel: string): Promise<RunningBrowser> {
    this.clearIdleTimer();
    this.throwIfStopped();
    if (this.closing) await this.closing;
    this.throwIfStopped();

    const reusable =
      this.running?.channel === channel &&
      this.running.context.browser()?.isConnected();
    if (reusable) return this.running!;

    if (this.running) {
      // The installed-browser selection changed (or the process disconnected).
      // Never tear down pages belonging to another in-flight operation.
      if (this.pages.size > 0 || this.active > 1) {
        throw new WebError('BROWSER_UNAVAILABLE');
      }
      await this.closeBrowser();
    }

    this.throwIfStopped();
    this.launching ??= this.startLaunch(channel);

    const instance = await this.launching;
    if (instance.channel !== channel) throw new WebError('BROWSER_UNAVAILABLE');

    return instance;
  }

  private startLaunch(channel: string): Promise<RunningBrowser> {
    const pending: Promise<RunningBrowser> = this.launch(channel)
      .then((context) => this.attachContext(context, channel))
      .catch((error: unknown) => {
        if (error instanceof WebError) throw error;
        throw new WebError('BROWSER_LAUNCH_FAILED');
      })
      .finally(() => {
        if (this.launching === pending) this.launching = undefined;
      });

    return pending;
  }

  /** Guard a freshly launched context and make it the running browser. */
  private async attachContext(
    context: BrowserContext,
    channel: string,
  ): Promise<RunningBrowser> {
    await this.closeIfStopped(context);

    try {
      // Page routing takes precedence. This strict fallback also guards
      // the first popup request, which page.route cannot intercept.
      await context.route('**/*', (route) => routeRequest(route));
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }

    await this.closeIfStopped(context);

    const instance: RunningBrowser = {
      context,
      channel,
      identity: deriveBrowserIdentity(context),
    };
    context.on('close', () => {
      if (this.running === instance) {
        this.running = undefined;
        this.clearIdleTimer();
      }
    });
    this.running = instance;

    return instance;
  }

  private async closeIfStopped(context: BrowserContext): Promise<void> {
    if (!this.stopped) return;

    await context.close().catch(() => {});
    throw new WebError('CANCELLED');
  }

  /**
   * Reserve one of the bounded page slots, waiting FIFO when all are busy.
   * Returns an idempotent release function.
   */
  private async reserve(options: OpenPageOptions): Promise<() => void> {
    this.assertUsable(options);
    this.clearIdleTimer();

    if (this.active < MAX_ACTIVE_PAGES) {
      this.active += 1;
    } else if (this.waiting.length >= MAX_QUEUED_PAGES) {
      throw new WebError('PROVIDER_UNAVAILABLE');
    } else {
      await this.waitForSlot(options);
    }

    try {
      this.assertUsable(options);
    } catch (error) {
      this.releaseSlot();
      throw error;
    }

    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private waitForSlot(options: OpenPageOptions): Promise<void> {
    return waitBounded(options, (finish) => {
      const grant = () => {
        this.active += 1;
        finish();
      };
      this.waiting.push(grant);

      return () => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
      };
    });
  }

  private assertUsable(options: OpenPageOptions): void {
    throwIfCancelled(options.signal);
    this.throwIfStopped();
    throwIfExpired(options.deadline);
  }

  async inventory(
    options: { verifyLaunch?: boolean } = {},
  ): Promise<BrowserInventory> {
    const installed = this.resolver.discover();
    const selected = selectLaunchableBrowser(installed);
    const verifyLaunch = options.verifyLaunch === true;
    const verified =
      verifyLaunch && selected?.channel
        ? await this.verifyBrowserLaunch(selected.channel)
        : false;

    const browsers = installed
      .slice(0, WEB_LIMITS.maxBrowsers)
      .map((browser) =>
        describeBrowser(
          browser,
          verifyLaunch && browser.id === selected?.id,
          verified,
        ),
      );

    return {
      browsers,
      ...(selected ? { selectedId: selected.id } : {}),
    };
  }

  private async verifyBrowserLaunch(channel: string): Promise<boolean> {
    try {
      await this.acquireBrowser(channel);
      this.startIdleTimer();

      return true;
    } catch {
      return false;
    }
  }

  async open(url: string, options: OpenPageOptions): Promise<PageHandle> {
    const selected = selectLaunchableBrowser(this.resolver.discover());
    if (!selected?.channel) {
      throw new WebError('BROWSER_UNAVAILABLE');
    }

    const release = await this.reserve(options);
    let page: Page | undefined;
    let closed = false;
    let cleanupPromise: Promise<void> | undefined;

    const onAbort = () => {
      void cleanup();
    };

    const cleanup = async () => {
      if (closed) return cleanupPromise;
      closed = true;
      options.signal.removeEventListener('abort', onAbort);
      cleanupPromise = (async () => {
        if (page) {
          this.pages.delete(page);
          page.removeListener('close', onAbort);
          if (!page.isClosed()) await page.close().catch(() => {});
        }
        release();
      })();

      return cleanupPromise;
    };

    try {
      const instance = await this.acquireBrowser(selected.channel);
      throwIfCancelled(options.signal);
      throwIfExpired(options.deadline);

      const identity = await instance.identity;
      this.assertUsable(options);

      page = await instance.context.newPage();
      this.pages.add(page);
      page.on('close', onAbort);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (this.stopped || options.signal.aborted)
        throw new WebError('CANCELLED');
      throwIfExpired(options.deadline);

      await applyUserAgent(instance.context, page, identity);
      throwIfCancelled(options.signal);
      throwIfExpired(options.deadline);

      const handle = await navigate(page, selected, url, options);

      return { ...handle, close: cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.clearIdleTimer();
    while (this.waiting.length > 0) this.waiting[0]();
    await Promise.allSettled([...this.pages].map((page) => page.close()));
    if (this.launching) await this.launching.catch(() => {});
    await this.closeBrowser();
  }
}

function electronUserDataPath(): string {
  const electron = requireFromHere('electron') as typeof import('electron');

  return electron.app.getPath('userData');
}

function launchOptions(channel: string) {
  return {
    channel,
    headless: false,
    timeout: LAUNCH_TIMEOUT_MS,
    args: NEW_HEADLESS_ARGS,
    acceptDownloads: false,
    // Safety depends on routing every navigation/subresource through our URL
    // guard. Playwright routing cannot cover all service-worker traffic, so
    // retain this restriction until equivalent network enforcement exists.
    serviceWorkers: 'block' as const,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
  };
}

/** Diagnostic, path-free description of one installed browser. */
function describeBrowser(
  browser: InstalledBrowser,
  isVerifiedCandidate: boolean,
  verified: boolean,
): BrowserInfo {
  let launchVerified: boolean | null = null;
  let reason: string | undefined;

  if (isVerifiedCandidate) {
    launchVerified = verified;
    if (!verified) reason = 'Installed but failed to launch.';
  } else if (browser.detected === false) {
    reason = 'Not installed.';
  } else if (!browser.supported) {
    reason = 'Not supported by the no-download browser reader.';
  }

  return {
    id: browser.id,
    displayName: browser.displayName,
    detected: browser.detected,
    supported: browser.supported,
    launchVerified,
    ...(reason ? { reason } : {}),
  };
}

/**
 * A persistent context cannot change its UA after launch. Apply the same
 * normalized native UA to this page without context-wide state.
 */
async function applyUserAgent(
  context: BrowserContext,
  page: Page,
  identity: BrowserIdentity,
): Promise<void> {
  if (!identity.userAgent) return;

  const session = await context.newCDPSession(page);
  await session.send('Emulation.setUserAgentOverride', {
    userAgent: identity.userAgent,
  });
  // Keep the session attached until page.close(): detaching immediately
  // resets Chrome's emulation override before navigation.
}

async function navigate(
  page: Page,
  selected: InstalledBrowser,
  url: string,
  options: OpenPageOptions,
): Promise<Omit<PageHandle, 'close'>> {
  await page.route('**/*', (route) =>
    routeRequest(route, options.allowLoopback),
  );

  page.on('download', (download) => void download.cancel().catch(() => {}));
  page.on('popup', (popup) => void popup.close().catch(() => {}));
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));

  const remaining = remainingMs(options.deadline);
  let status: number | null = null;
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: remaining,
    });
    status = response ? response.status() : null;
  } catch {
    if (options.signal.aborted) {
      throw new WebError('CANCELLED');
    }
    if (Date.now() >= options.deadline) {
      throw new WebError('TIMEOUT');
    }
    throw new WebError('NAVIGATION_FAILED');
  }

  await settlePage(page, options);

  const browserId: WebBrowserId = selected.id;
  const finalUrl = page.url();

  return {
    browserId,
    requestedUrl: url,
    finalUrl,
    status,
    title: () => page.title(),
    content: () => page.content(),
    visibleText: () =>
      page.evaluate(() => document.body?.innerText ?? '') as Promise<string>,
    extractSearch: () => extractSearch(page, options.deadline),
  };
}

/**
 * Results load via XHR after `domcontentloaded`; wait (bounded by the shared
 * deadline) for the results/no-results/challenge view so we never extract or
 * close before results render.
 */
async function extractSearch(
  page: Page,
  deadline: number,
): Promise<SearchExtraction> {
  const readyBudget = Math.min(SEARCH_READY_MAX_MS, remainingMs(deadline));
  if (readyBudget > 0) {
    await page
      .waitForSelector(SEARCH_READY_SELECTOR, { timeout: readyBudget })
      .catch(() => {});

    const settle = Math.min(SEARCH_SETTLE_MS, remainingMs(deadline));
    if (settle > 0) {
      await page.waitForTimeout(settle).catch(() => {});
    }
  }

  return page.evaluate(DUCKDUCKGO_EXTRACTION) as Promise<SearchExtraction>;
}

function routeRequest(route: Route, allowLoopback = false): void {
  const request = route.request();
  if (!isAllowedRequestUrl(request.url(), { allowLoopback })) {
    void route.abort();
    return;
  }

  void route.continue();
}

/** Give client-side rendering a bounded, cancellable moment to settle. */
async function settlePage(page: Page, options: OpenPageOptions): Promise<void> {
  throwIfCancelled(options.signal);
  throwIfExpired(options.deadline);

  const settleMs = options.settleMs ?? WEB_LIMITS.renderSettleMs;
  if (settleMs <= 0) return;

  await waitBounded(options, (finish) => {
    page.waitForTimeout(settleMs).then(
      () => finish(interruption(options) ?? undefined),
      () => finish(interruption(options) ?? new WebError('NAVIGATION_FAILED')),
    );

    return () => {};
  });

  throwIfCancelled(options.signal);
  throwIfExpired(options.deadline);
}

/** CANCELLED or TIMEOUT if the operation can no longer continue. */
function interruption(options: OpenPageOptions): WebError | null {
  if (options.signal.aborted) return new WebError('CANCELLED');
  if (Date.now() >= options.deadline) return new WebError('TIMEOUT');

  return null;
}

/**
 * Wait until `start` calls `finish`, rejecting with CANCELLED on abort or
 * TIMEOUT at the deadline. `start` is not called when already aborted, and
 * its returned cleanup runs exactly once when the wait settles.
 */
function waitBounded(
  options: OpenPageOptions,
  start: (finish: (error?: WebError) => void) => () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // Replaced by the real cleanup once `start` has registered the waiter.
    let stop: () => void = () => {};

    const finish = (error?: WebError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      stop();
      if (error) reject(error);
      else resolve();
    };

    const onAbort = () => finish(new WebError('CANCELLED'));
    const timer = setTimeout(
      () => finish(new WebError('TIMEOUT')),
      remainingMs(options.deadline),
    );

    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    stop = start(finish);
    if (settled) stop();
  });
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * Read the launched browser's own User-Agent from a throwaway `about:blank`
 * page (no network) and normalize **only** the `HeadlessChrome` token to a
 * regular Chrome identity. New headless uses the installed Chrome binary; its
 * `Sec-CH-UA` client hints are already a normal `"Google Chrome"` identity in
 * the secure contexts we actually navigate, so we leave them untouched.
 *
 * The UA is derived from the running browser — no hardcoded UA string.
 * Best-effort: on any failure we fall back to no override.
 */
async function deriveBrowserIdentity(
  context: BrowserContext,
): Promise<BrowserIdentity> {
  let probe: Page | undefined;
  try {
    // Chrome supplies an initial blank page for persistent launches. Close all
    // startup pages so only operation-owned pages remain after the probe.
    await Promise.all(context.pages().map((page) => page.close()));
    probe = await context.newPage();
    const userAgent = await probe.evaluate(() => navigator.userAgent);
    return buildIdentity(userAgent);
  } catch {
    return {};
  } finally {
    await probe?.close().catch(() => {});
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WebError('CANCELLED');
  }
}

function throwIfExpired(deadline: number): void {
  if (Date.now() >= deadline) {
    throw new WebError('TIMEOUT');
  }
}

/** Lazy-load `playwright-core` so tests and non-reader paths never import it. */
declare const __filename: string;
const requireFromHere = createRequire(__filename);

async function loadChromium(): Promise<ChromiumLauncher> {
  // A real CJS require (not a dynamic `import()`) keeps playwright-core's
  // internal `_playwright` binding intact in the packaged/bundled main process.
  const mod = requireFromHere('playwright-core') as {
    chromium?: ChromiumLauncher;
    default?: { chromium?: ChromiumLauncher };
  };
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) {
    throw new WebError('BROWSER_LAUNCH_FAILED');
  }
  return chromium;
}
