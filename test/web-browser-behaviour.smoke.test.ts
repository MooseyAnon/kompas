import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { expect, it } from 'vitest';
import { createPlaywrightEngine } from '../src/main/modules/web/adapters/playwright/playwright-engine';

it.skipIf(process.env.WEB_BROWSER_SMOKE !== '1')(
  'renders images, fonts and media in installed Chrome while retaining network safeguards',
  async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'web-behaviour-smoke-'));
    const font = await readFile(
      new URL(
        '../src/renderer/presentation/fonts/Baloo_2/static/Baloo2-Regular.ttf',
        import.meta.url,
      ),
    );
    // A short, silent PCM WAV exercises Chrome's actual media loader.
    const wav = Buffer.alloc(44 + 800);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(800, 40);
    wav.fill(128, 44);
    const requests: string[] = [];
    const userAgents: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      userAgents.push(request.headers['user-agent'] ?? '');
      if (request.url === '/image.svg') {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>',
        );
      } else if (request.url === '/font.ttf') {
        response.setHeader('Content-Type', 'font/ttf');
        response.end(font);
      } else if (request.url === '/audio.wav') {
        response.setHeader('Content-Type', 'audio/wav');
        response.end(wav);
      } else if (request.url === '/sw.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('self.addEventListener("fetch", () => {});');
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end(`<html><head><style>
          @font-face { font-family: Smoke; src: url('/font.ttf'); }
          body { font-family: Smoke; }
        </style></head><body>
          <div id="status">Loading</div>
          <img src="/image.svg"><audio src="/audio.wav" preload="auto"></audio>
          <script>
            const image = document.querySelector('img');
            const audio = document.querySelector('audio');
            Promise.all([
              image.decode(), document.fonts.load('16px Smoke'),
              new Promise((resolve, reject) => {
                if (audio.readyState >= 2) resolve();
                else { audio.onloadeddata = resolve; audio.onerror = reject; }
              }),
              navigator.serviceWorker.register('/sw.js').then(
                (registration) => registration ? 'registered' : 'blocked', () => 'blocked'
              )
            ]).then((values) => {
              document.querySelector('#status').textContent = JSON.stringify({
                image: image.naturalWidth, font: document.fonts.check('16px Smoke'),
                media: audio.readyState >= 2, serviceWorker: values[3], ua: navigator.userAgent
              });
            });
          </script>
        </body></html>`);
      }
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
    const engine = createPlaywrightEngine({
      userDataPath,
      launchChromium: async (profile, options) => {
        launches += 1;
        context = await chromium.launchPersistentContext(profile, options);
        return context;
      },
    });
    const options = () => ({
      signal: new AbortController().signal,
      deadline: Date.now() + 15_000,
      settleMs: 0,
    });
    try {
      const page = await engine.open(origin, {
        ...options(),
        allowLoopback: true,
      });
      await expect
        .poll(() => page.visibleText(), { timeout: 10_000 })
        .toContain('"media":true');
      const state = JSON.parse(await page.visibleText());
      expect(state).toMatchObject({
        image: 16,
        font: true,
        media: true,
        serviceWorker: 'blocked',
      });
      expect(state.ua).not.toContain('HeadlessChrome');
      const nativeVersion = context!.browser()!.version().split('.')[0];
      expect(state.ua).toContain(`Chrome/${nativeVersion}.`);
      expect(userAgents.every((ua) => ua === state.ua)).toBe(true);
      expect(requests).toEqual(
        expect.arrayContaining(['/image.svg', '/font.ttf', '/audio.wav']),
      );
      expect(requests).not.toContain('/sw.js');
      expect(context!.serviceWorkers()).toHaveLength(0);
      // The same loopback server must remain inaccessible to ordinary operations.
      await expect(
        engine.open(`${origin}/disallowed`, options()),
      ).rejects.toMatchObject({ code: 'NAVIGATION_FAILED' });
      expect(requests).not.toContain('/disallowed');
      expect(await page.visibleText()).toContain('"media":true');
      expect(launches).toBe(1);
      await page.close();
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
