import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { expect, it } from 'vitest';
import { createPlaywrightEngine } from '../src/main/modules/web/adapters/playwright/playwright-engine';

// Explicit opt-in: uses installed Chrome, never downloads a browser. The profile
// and local fixture contain synthetic state only and are removed after shutdown.
it.skipIf(process.env.WEB_BROWSER_SMOKE !== '1')(
  'persists cookies and local storage across pages, browser restarts and engine restarts',
  async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'web-profile-smoke-'));
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url === '/seed') {
        response.setHeader(
          'Set-Cookie',
          'session=synthetic; Max-Age=3600; Path=/; SameSite=Lax',
        );
      }
      response.end(`<html><body><script>
        ${request.url === '/seed' ? "localStorage.setItem('identity', 'synthetic');" : ''}
        document.body.textContent = JSON.stringify({cookie: document.cookie,
          storage: localStorage.getItem('identity'), ua: navigator.userAgent});
      </script></body></html>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    const origin = `http://127.0.0.1:${address.port}`;
    let context: BrowserContext | undefined;
    let launches = 0;
    const makeEngine = () =>
      createPlaywrightEngine({
        userDataPath,
        launchChromium: async (profile, options) => {
          launches += 1;
          context = await chromium.launchPersistentContext(profile, options);
          return context;
        },
      });
    let engine = makeEngine();
    const options = (signal = new AbortController().signal) => ({
      signal,
      deadline: Date.now() + 15_000,
      settleMs: 0,
      allowLoopback: true,
    });
    const read = async () => {
      const page = await engine.open(`${origin}/read`, options());
      try {
        const state = JSON.parse(await page.visibleText());
        expect(state.cookie).toBe('session=synthetic');
        expect(state.storage).toBe('synthetic');
        expect(state.ua).toContain('Chrome/');
        expect(state.ua).not.toContain('HeadlessChrome');
      } finally {
        await page.close();
      }
    };
    try {
      expect(
        (await engine.inventory({ verifyLaunch: true })).browsers.find(
          (b) => b.id === 'chrome',
        )?.launchVerified,
      ).toBe(true);
      await (await engine.open(`${origin}/seed`, options())).close();
      await read();
      expect(launches).toBe(1);

      const abort = new AbortController();
      const [first, second] = await Promise.all([
        engine.open(`${origin}/read`, options(abort.signal)),
        engine.open(`${origin}/read`, options()),
      ]);
      abort.abort();
      await first.close();
      expect(await second.visibleText()).toContain('synthetic');
      await second.close();

      // Closing the actual persistent context flushes the profile to disk.
      await context!.close();
      await read();
      expect(launches).toBe(2);
      await engine.shutdown!();
      // Exercise the production lazy loader as well as the injectable launcher.
      engine = createPlaywrightEngine({ userDataPath });
      await read();
    } finally {
      await engine.shutdown!();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(userDataPath, { recursive: true, force: true });
    }
  },
  60_000,
);
