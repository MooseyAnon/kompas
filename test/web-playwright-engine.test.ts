import { EventEmitter } from 'node:events';
import type { BrowserContext, Route } from 'playwright-core';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_LIMITS } from '../src/shared/contracts';
import { createPlaywrightAdapter } from '../src/main/modules/web/adapters/playwright/playwright-adapter';
import {
  BROWSER_IDLE_MS,
  createPlaywrightEngine as createEngine,
  type PlaywrightEngineDeps,
} from '../src/main/modules/web/adapters/playwright/playwright-engine';
import type {
  InstalledBrowser,
  PlatformBrowserResolver,
} from '../src/main/modules/web/adapters/playwright/browser-resolver';

function createPlaywrightEngine(deps: PlaywrightEngineDeps) {
  return createEngine({ userDataPath: '/test/user-data', ...deps });
}

function installed(id: 'chrome' | 'msedge'): PlatformBrowserResolver {
  return {
    platform: 'darwin',
    discover: (): InstalledBrowser[] => [
      { id, displayName: id, detected: true, supported: true, channel: id },
    ],
  };
}

function fakePage() {
  const events = new EventEmitter();
  let closed = false;
  return {
    emit: events.emit.bind(events),
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    isClosed: () => closed,
    close: vi.fn(async () => {
      closed = true;
      events.emit('close');
    }),
    route: vi.fn(
      async (_pattern: string, _handler: (route: Route) => void) => {},
    ),
    goto: vi.fn(async () => ({ status: () => 200 })),
    url: () => 'https://example.org/',
    title: vi.fn(async () => 'Example'),
    content: vi.fn(async () => '<html>Example</html>'),
    evaluate: vi.fn(async () => 'HeadlessChrome/123'),
    waitForTimeout: vi.fn(async (_ms: number) => {}),
  };
}

function fakeBrowser(pageFactory = fakePage) {
  const events = new EventEmitter();
  let connected = true;
  const close = vi.fn(async () => {
    connected = false;
    events.emit('disconnected');
  });
  const pages: ReturnType<typeof fakePage>[] = [];
  const browser = {
    on: events.on.bind(events),
    browser: () => ({ isConnected: () => connected }),
    pages: () => [],
    route: vi.fn(
      async (_pattern: string, _handler: (route: Route) => void) => {},
    ),
    close: vi.fn(async () => {
      await Promise.all(
        pages.filter((page) => !page.isClosed()).map((page) => page.close()),
      );
      await close();
      events.emit('close');
    }),
    newCDPSession: vi.fn(async () => ({ send: vi.fn(), detach: vi.fn() })),
    newPage: vi.fn(async () => {
      const template = pageFactory();
      const events = new EventEmitter();
      let closed = false;
      const page = {
        ...template,
        emit: events.emit.bind(events),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
        isClosed: () => closed,
        close: vi.fn(async () => {
          closed = true;
          events.emit('close');
        }),
      };
      pages.push(page);
      return page;
    }),
  };
  return {
    browser: browser as unknown as BrowserContext,
    pages,
    fallbackRoute: browser.route,
    close: browser.close,
    disconnect: () => {
      connected = false;
      events.emit('close');
    },
  };
}

function options(signal = new AbortController().signal) {
  return { signal, deadline: Date.now() + 30_000 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe.each(['chrome', 'msedge'] as const)('shared %s browser', (channel) => {
  it('waits the full read default after navigation before extracting delayed DOM content', async () => {
    vi.useFakeTimers();
    const page = fakePage();
    let navigatedAt = 0;
    page.goto.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      navigatedAt = Date.now();
      return { status: () => 200 };
    });
    page.waitForTimeout.mockImplementation(
      (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    );
    page.content.mockImplementation(async () =>
      Date.now() - navigatedAt >= 2_500
        ? '<html>Rendered jobs</html>'
        : '<html>Loading</html>',
    );
    const instance = fakeBrowser(() => page);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const { adapter } = createPlaywrightAdapter({
      engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    const reading = adapter.readPage!('https://example.org/', options());

    await vi.advanceTimersByTimeAsync(999);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
    expect(page.content).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(page.waitForTimeout).toHaveBeenCalledExactlyOnceWith(
      WEB_LIMITS.readPageRenderSettleMs,
    );
    await vi.advanceTimersByTimeAsync(2_999);
    expect(page.title).not.toHaveBeenCalled();
    expect(page.content).not.toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenCalledOnce(); // UA probe only
    await vi.advanceTimersByTimeAsync(1);
    await expect(reading).resolves.toMatchObject({
      html: '<html>Rendered jobs</html>',
      title: 'Example',
    });
    expect(page.content).toHaveBeenCalledOnce();
    expect(instance.pages[1].close).toHaveBeenCalledOnce();
    await engine.shutdown?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels settling promptly, releases a queued read and leaves other reads open', async () => {
    vi.useFakeTimers();
    const page = fakePage();
    page.waitForTimeout.mockImplementation(
      (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    );
    const instance = fakeBrowser(() => page);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const { adapter } = createPlaywrightAdapter({
      engine,
      validateReadUrl: async (url) => ({ ok: true, url }),
    });
    const controller = new AbortController();
    const cancelled = expect(
      adapter.readPage!('https://example.org/', options(controller.signal)),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    const second = adapter.readPage!('https://example.org/', options());
    const queued = adapter.readPage!('https://example.org/', options());

    await vi.advanceTimersByTimeAsync(500);
    expect(instance.pages).toHaveLength(3);
    controller.abort();
    await cancelled;
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.pages).toHaveLength(4);
    expect(instance.pages[1].close).toHaveBeenCalled();
    expect(instance.pages[2].close).not.toHaveBeenCalled();
    expect(instance.pages[3].close).not.toHaveBeenCalled();
    expect(page.content).not.toHaveBeenCalled();
    expect(instance.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_500);
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(instance.pages[3].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await expect(queued).resolves.toMatchObject({ status: 200 });
    expect(page.content).toHaveBeenCalledTimes(2);
    await engine.shutdown?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1_000, 3_000])(
    'returns TIMEOUT without extraction when the deadline is %i ms away',
    async (remainingMs) => {
      vi.useFakeTimers();
      const page = fakePage();
      page.waitForTimeout.mockImplementation(
        (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      );
      const instance = fakeBrowser(() => page);
      const engine = createPlaywrightEngine({
        resolver: installed(channel),
        launchChromium: async () => instance.browser,
      });
      const { adapter } = createPlaywrightAdapter({
        engine,
        validateReadUrl: async (url) => ({ ok: true, url }),
      });
      const timedOut = expect(
        adapter.readPage!('https://example.org/', {
          ...options(),
          deadline: Date.now() + remainingMs,
        }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });

      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(page.content).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
      expect(page.waitForTimeout).toHaveBeenCalledExactlyOnceWith(
        WEB_LIMITS.readPageRenderSettleMs,
      );
      expect(page.title).not.toHaveBeenCalled();
      expect(page.content).not.toHaveBeenCalled();
      expect(page.evaluate).toHaveBeenCalledOnce();
      expect(instance.pages[1].close).toHaveBeenCalledOnce();
      const next = await engine.open('https://example.org/', {
        ...options(),
        settleMs: 0,
      });
      await next.close();
      await engine.shutdown?.();
    },
  );

  it('surfaces settling failures instead of returning a successful page handle', async () => {
    const page = fakePage();
    page.waitForTimeout.mockRejectedValue(new Error('page closed'));
    const instance = fakeBrowser(() => page);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    await expect(
      engine.open('https://example.org/', options()),
    ).rejects.toMatchObject({ code: 'NAVIGATION_FAILED' });
    expect(instance.pages[1].close).toHaveBeenCalledOnce();
    expect(page.content).not.toHaveBeenCalled();
    await engine.shutdown?.();
  });

  it('launches one persistent context, isolates pages and closes after two idle minutes', async () => {
    vi.useFakeTimers();
    const instance = fakeBrowser();
    const launch = vi.fn(async () => instance.browser);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });

    const [first, second] = await Promise.all([
      engine.open('https://example.org/', options()),
      engine.open('https://example.org/', options()),
    ]);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(
      join('/test/user-data', 'web-browser-profiles', channel),
      expect.objectContaining({
        channel,
        headless: false,
        args: ['--headless=new'],
        acceptDownloads: false,
        serviceWorkers: 'block', // routing cannot safely cover service workers
        bypassCSP: false,
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
      }),
    );
    expect(instance.pages).toHaveLength(3); // one UA probe and two independent pages
    expect(instance.pages[1].close).not.toHaveBeenCalled();
    await first.close();
    expect(instance.pages[1].close).toHaveBeenCalledOnce();
    expect(instance.pages[2].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS);
    expect(instance.close).not.toHaveBeenCalled();

    await second.close();
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS - 1);
    expect(instance.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.close).toHaveBeenCalledOnce();
    await engine.shutdown?.();
  });

  it('resets idle time when reused and relaunches after idle expiry', async () => {
    vi.useFakeTimers();
    const firstBrowser = fakeBrowser();
    const secondBrowser = fakeBrowser();
    const launch = vi
      .fn()
      .mockResolvedValueOnce(firstBrowser.browser)
      .mockResolvedValueOnce(secondBrowser.browser);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });

    await (await engine.open('https://example.org/', options())).close();
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS - 1);
    await (await engine.open('https://example.org/', options())).close();
    expect(launch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS);
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    await (await engine.open('https://example.org/', options())).close();
    expect(launch).toHaveBeenCalledTimes(2);
    await engine.shutdown?.();
    expect(secondBrowser.close).toHaveBeenCalledOnce();
  });

  it('cancels one page without closing another, and closes on shutdown', async () => {
    const instance = fakeBrowser();
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const abort = new AbortController();
    const first = await engine.open(
      'https://example.org/',
      options(abort.signal),
    );
    const second = await engine.open('https://example.org/', options());
    abort.abort();
    await first.close();
    expect(instance.close).not.toHaveBeenCalled();
    expect(instance.pages[2].close).not.toHaveBeenCalled();
    await engine.shutdown?.();
    expect(instance.pages[2].close).toHaveBeenCalled();
    expect(instance.close).toHaveBeenCalledOnce();
    await second.close();
    await expect(
      engine.open('https://example.org/', options()),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('uses the running browser for inventory and relaunches after disconnect', async () => {
    vi.useFakeTimers();
    const firstBrowser = fakeBrowser();
    const secondBrowser = fakeBrowser();
    const launch = vi
      .fn()
      .mockResolvedValueOnce(firstBrowser.browser)
      .mockResolvedValueOnce(secondBrowser.browser);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });

    expect(
      (await engine.inventory({ verifyLaunch: true })).browsers[0]
        .launchVerified,
    ).toBe(true);
    expect(
      (await engine.inventory({ verifyLaunch: true })).browsers[0]
        .launchVerified,
    ).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    firstBrowser.disconnect();
    await (await engine.open('https://example.org/', options())).close();
    expect(launch).toHaveBeenCalledTimes(2);
    await engine.shutdown?.();
  });

  it('bounds concurrent pages and lets a queued request use the released slot', async () => {
    const instance = fakeBrowser();
    const launch = vi.fn(async () => instance.browser);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });
    const first = await engine.open('https://example.org/', options());
    const second = await engine.open('https://example.org/', options());
    const thirdPromise = engine.open('https://example.org/', options());

    expect(instance.pages).toHaveLength(3);
    await first.close();
    const third = await thirdPromise;
    expect(instance.pages).toHaveLength(4);
    expect(launch).toHaveBeenCalledOnce();
    await second.close();
    await third.close();
    await engine.shutdown?.();
  });

  it('honors cancellation while waiting for an operation slot', async () => {
    const instance = fakeBrowser();
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const first = await engine.open('https://example.org/', options());
    const second = await engine.open('https://example.org/', options());
    const abort = new AbortController();
    const queued = engine.open('https://example.org/', options(abort.signal));
    abort.abort();
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    await first.close();
    await second.close();
    expect(instance.pages).toHaveLength(3);
    await engine.shutdown?.();
  });

  it('waits for an idle close to finish before launching its replacement', async () => {
    vi.useFakeTimers();
    const firstBrowser = fakeBrowser();
    const secondBrowser = fakeBrowser();
    let finishClose: (() => void) | undefined;
    vi.spyOn(firstBrowser.browser, 'close').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const launch = vi
      .fn()
      .mockResolvedValueOnce(firstBrowser.browser)
      .mockResolvedValueOnce(secondBrowser.browser);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });

    await (await engine.open('https://example.org/', options())).close();
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS);
    const next = engine.open('https://example.org/', options());
    expect(launch).toHaveBeenCalledOnce();
    finishClose?.();
    await (await next).close();
    expect(launch).toHaveBeenCalledTimes(2);
    await engine.shutdown?.();
  });

  it('does not leave a browser running if shutdown occurs during launch', async () => {
    let finishLaunch: ((context: BrowserContext) => void) | undefined;
    const instance = fakeBrowser();
    const launch = vi.fn(
      () =>
        new Promise<BrowserContext>((resolve) => {
          finishLaunch = resolve;
        }),
    );
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });
    const opening = engine.open('https://example.org/', options());
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const shutdown = engine.shutdown?.();
    finishLaunch?.(instance.browser);
    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    await shutdown;
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it('does not relaunch when shutdown overlaps a browser selection change', async () => {
    const instance = fakeBrowser();
    const resolver = installed(channel);
    const launch = vi.fn(async () => instance.browser);
    const engine = createPlaywrightEngine({ resolver, launchChromium: launch });
    await engine.inventory({ verifyLaunch: true });
    let finishClose: (() => void) | undefined;
    vi.spyOn(instance.browser, 'close').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    vi.spyOn(resolver, 'discover').mockImplementation(
      installed(channel === 'chrome' ? 'msedge' : 'chrome').discover,
    );
    const verifying = engine.inventory({ verifyLaunch: true });
    await vi.waitFor(() => expect(finishClose).toBeDefined());
    const shutdown = engine.shutdown?.();
    finishClose!();
    expect((await verifying).browsers[0].launchVerified).toBe(false);
    await shutdown;
    expect(launch).toHaveBeenCalledOnce();
  });

  it('does not navigate when the operation deadline expires during launch', async () => {
    vi.useFakeTimers();
    let finishLaunch: ((context: BrowserContext) => void) | undefined;
    const instance = fakeBrowser();
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: () =>
        new Promise<BrowserContext>((resolve) => {
          finishLaunch = resolve;
        }),
    });
    const opening = engine.open('https://example.org/', {
      signal: new AbortController().signal,
      deadline: Date.now() + 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_001);
    finishLaunch?.(instance.browser);
    await expect(opening).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(instance.pages).toHaveLength(1); // UA probe only
    await engine.shutdown?.();
  });

  it('keeps operation-specific request restrictions on independent pages', async () => {
    const instance = fakeBrowser();
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const first = await engine.open('https://example.org/', {
      ...options(),
      allowLoopback: true,
    });
    const second = await engine.open('https://example.org/', options());
    const route = {
      request: () => ({
        url: () => 'http://127.0.0.1/test',
        resourceType: () => 'document',
      }),
      abort: vi.fn(),
      continue: vi.fn(),
    };
    instance.pages[1].route.mock.calls[0][1](route as unknown as Route);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
    instance.pages[2].route.mock.calls[0][1](route as unknown as Route);
    expect(route.abort).toHaveBeenCalledOnce();
    instance.fallbackRoute.mock.calls[0][1](route as unknown as Route);
    expect(route.abort).toHaveBeenCalledTimes(2); // unowned/popup requests remain guarded
    await first.close();
    expect(await second.title()).toBe('Example');
    await second.close();
    await engine.shutdown?.();
  });

  it('normalizes the native UA once in the shared context and applies it per page', async () => {
    const nativeUA = 'Mozilla/5.0 HeadlessChrome/157.2.3.4 Safari/537.36';
    const instance = fakeBrowser(() => {
      const page = fakePage();
      page.evaluate.mockResolvedValue(nativeUA);
      return page;
    });
    const launch = vi.fn(async () => instance.browser);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });
    const [first, second] = await Promise.all([
      engine.open('https://example.org/', options()),
      engine.open('https://example.org/', options()),
    ]);
    expect(launch).toHaveBeenCalledOnce();
    expect(instance.pages).toHaveLength(3);
    expect(instance.pages[0].evaluate).toHaveBeenCalledOnce();
    expect(instance.pages[0].close).toHaveBeenCalledOnce();
    const sessions = vi.mocked(instance.browser.newCDPSession);
    expect(sessions.mock.calls.map(([page]) => page)).toEqual(
      instance.pages.slice(1),
    );
    for (const result of sessions.mock.results) {
      expect((await result.value).send).toHaveBeenCalledExactlyOnceWith(
        'Emulation.setUserAgentOverride',
        { userAgent: nativeUA.replace('HeadlessChrome/', 'Chrome/') },
      );
    }
    await first.close();
    await second.close();
    await engine.shutdown?.();
  });

  it('continues without a UA override if identity probing fails', async () => {
    const instance = fakeBrowser(() => {
      const page = fakePage();
      page.evaluate.mockRejectedValue(new Error('probe failed'));
      return page;
    });
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const handle = await engine.open('https://example.org/', options());
    expect(instance.browser.newCDPSession).not.toHaveBeenCalled();
    expect(instance.pages[0].close).toHaveBeenCalledOnce();
    expect(await handle.title()).toBe('Example');
    await handle.close();
    await engine.shutdown?.();
  });

  it('allows ordinary resources while rejecting unsafe navigation and network URLs', async () => {
    const instance = fakeBrowser();
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const handle = await engine.open('https://example.org/', options());
    const handlers = [
      instance.pages[1].route.mock.calls[0][1],
      instance.fallbackRoute.mock.calls[0][1],
    ];
    for (const handler of handlers) {
      for (const resourceType of [
        'document',
        'image',
        'media',
        'font',
        'script',
        'fetch',
        'stylesheet',
      ]) {
        for (const url of [
          'https://example.org/resource',
          'http://127.0.0.1/',
          'http://10.0.0.1/',
          'http://169.254.169.254/',
          'http://[::1]/',
          'http://localhost/',
          'file:///etc/passwd',
          'ftp://example.org/',
        ]) {
          const route = {
            request: () => ({
              url: () => url,
              resourceType: () => resourceType,
            }),
            abort: vi.fn(),
            continue: vi.fn(),
          };
          handler(route as unknown as Route);
          expect(route.continue).toHaveBeenCalledTimes(
            url.startsWith('https://example.org/') ? 1 : 0,
          );
          expect(route.abort).toHaveBeenCalledTimes(
            url.startsWith('https://example.org/') ? 0 : 1,
          );
        }
      }
    }
    await handle.close();
    await engine.shutdown?.();
  });

  it('dismisses popups, dialogs and downloads on the owning page only', async () => {
    const instance = fakeBrowser();
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    const first = await engine.open('https://example.org/', options());
    const second = await engine.open('https://example.org/', options());
    const popup = { close: vi.fn(async () => {}) };
    const dialog = { dismiss: vi.fn(async () => {}) };
    const download = { cancel: vi.fn(async () => {}) };
    instance.pages[1].emit('popup', popup);
    instance.pages[1].emit('dialog', dialog);
    instance.pages[1].emit('download', download);
    expect(popup.close).toHaveBeenCalledOnce();
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(download.cancel).toHaveBeenCalledOnce();
    expect(instance.pages[1].close).not.toHaveBeenCalled();
    expect(instance.pages[2].close).not.toHaveBeenCalled();
    expect(await second.title()).toBe('Example');
    await first.close();
    await second.close();
    await engine.shutdown?.();
  });

  it('bounds the queue at eight and releases all pending requests on shutdown', async () => {
    const instance = fakeBrowser();
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: async () => instance.browser,
    });
    await engine.open('https://example.org/', options());
    await engine.open('https://example.org/', options());
    const queued = Array.from({ length: 8 }, () =>
      expect(
        engine.open('https://example.org/', options()),
      ).rejects.toMatchObject({ code: 'CANCELLED' }),
    );
    await expect(
      engine.open('https://example.org/', options()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await engine.shutdown?.();
    await Promise.all(queued);
    expect(instance.pages[1].close).toHaveBeenCalledOnce();
    expect(instance.pages[2].close).toHaveBeenCalledOnce();
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it('recovers after launch and page creation failures without losing slots', async () => {
    const instance = fakeBrowser();
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockResolvedValue(instance.browser);
    const engine = createPlaywrightEngine({
      resolver: installed(channel),
      launchChromium: launch,
    });
    await expect(
      engine.open('https://example.org/', options()),
    ).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' });
    await engine.inventory({ verifyLaunch: true });
    await vi.waitFor(() => expect(instance.pages[0].close).toHaveBeenCalled());
    vi.spyOn(instance.browser, 'newPage').mockRejectedValueOnce(
      new Error('page failed'),
    );
    await expect(
      engine.open('https://example.org/', options()),
    ).rejects.toThrow('page failed');
    const [first, second] = await Promise.all([
      engine.open('https://example.org/', options()),
      engine.open('https://example.org/', options()),
    ]);
    await first.close();
    await second.close();
    await engine.shutdown?.();
  });
});
