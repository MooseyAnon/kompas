// Real-browser screenshots of the 07.4 Quick-fire runner fixture. The page
// and session controller are real; the backend is scripted in the fixture.
// Chrome's fake media device drives the real recorder (no microphone used).
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const destination = process.env.CW_INTERVIEW_SCREENSHOT_DIR;
if (!destination || !fs.statSync(destination).isDirectory()) {
  throw new Error('CW_INTERVIEW_SCREENSHOT_DIR must be an existing directory');
}

const SIZES = [
  ['wide', 1440, 900],
  ['compact', 620, 760],
  ['short', 1100, 520],
];
const EMBARGO =
  /score|\/\s*100\b|%|met the bar|below the bar|unscored|strength|pass mark/i;

/** Each shot: fixture state, element to await, optional interaction. */
const SHOTS = [
  {
    name: 'q1-generating',
    state: 'q1-generating',
    ready: 'quick-fire-background',
  },
  {
    name: 'next-pending',
    state: 'next-pending',
    ready: 'quick-fire-next-pending',
  },
  {
    name: 'recording',
    state: 'recording',
    ready: 'interview-voice-record',
    async act(page) {
      await page.locator('[data-testid="interview-voice-record"]').click();
      await page.locator('[data-testid="interview-recording"]').waitFor();
      await page.waitForTimeout(1600);
    },
  },
  {
    name: 'all-answered',
    state: 'final-pending',
    ready: 'quick-fire-request-results',
  },
  {
    name: 'final-pending',
    state: 'final-pending',
    ready: 'quick-fire-request-results',
    async act(page) {
      await page.locator('[data-testid="quick-fire-request-results"]').click();
      await page
        .locator('[data-testid="quick-fire-results-pending"]')
        .waitFor();
    },
  },
  {
    name: 'synthesis',
    state: 'synthesis',
    ready: 'quick-fire-results-pending',
  },
  {
    name: 'results',
    state: 'results',
    ready: 'quick-fire-result-round-5',
    published: true,
  },
];

const server = await createServer({
  configFile: false,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}/test/fixtures/quick-fire-preview.html`;
  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ];
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless: true, args });
      break;
    } catch {
      // Try the next installed browser.
    }
  }
  if (!browser)
    throw new Error('No installed Chrome or Edge for visual fixture');

  for (const [size, width, height] of SIZES) {
    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`${base}?state=${shot.state}`);
      await page.locator(`[data-testid="${shot.ready}"]`).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await shot.act?.(page);
      await page.waitForTimeout(400);

      const layout = await page.evaluate(() => {
        const outlet = document.querySelector('.interviews-outlet');
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          pageOverflow: document.documentElement.scrollHeight > innerHeight + 2,
          text: outlet.textContent,
          decorationsHidden: [
            ...document.querySelectorAll(
              '.interview-status-art, .meadow-card-corner, .interview-recording-levels',
            ),
          ].every((node) => node.getAttribute('aria-hidden') === 'true'),
          decorationsInert: [
            ...document.querySelectorAll(
              '.interview-status-art, .meadow-card-corner',
            ),
          ].every((node) => getComputedStyle(node).pointerEvents === 'none'),
          submitVisible: (() => {
            const submit = document.querySelector(
              '[data-testid="interview-composer-submit"]',
            );
            if (!submit) return null;
            const box = submit.getBoundingClientRect();
            const bounds = outlet.getBoundingClientRect();
            return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
          })(),
        };
      });
      const failures = [];
      if (layout.overflow || layout.pageOverflow) failures.push('overflow');
      if (!layout.decorationsHidden || !layout.decorationsInert)
        failures.push('decorations not aria-hidden/inert');
      if (!shot.published && EMBARGO.test(layout.text))
        failures.push('assessment cue before publication');
      if (size === 'short' && layout.submitVisible === false)
        failures.push('Submit hidden on a short window');
      if (failures.length)
        throw new Error(`${shot.name} at ${size}: ${failures.join(', ')}`);

      if (shot.name === 'recording') {
        const recording = await page
          .locator('.interview-recording')
          .evaluate((node) => ({
            text: node.textContent,
            stop: !!node.querySelector(
              '[data-testid="interview-recording-stop"]',
            ),
            levels: node.querySelectorAll('.interview-recording-levels > *')
              .length,
          }));
        if (!recording.text.includes('Recording') || !recording.stop)
          throw new Error(
            `recording signal failed: ${JSON.stringify(recording)}`,
          );
      }

      await page.screenshot({
        path: path.join(destination, `quick-fire-${shot.name}-${size}.png`),
      });
      await page.close();
    }
  }

  // Reduced motion stops the waiting and recording animations.
  for (const shot of SHOTS.filter((item) =>
    ['next-pending', 'recording', 'synthesis'].includes(item.name),
  )) {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.goto(`${base}?state=${shot.state}`);
    await page.locator(`[data-testid="${shot.ready}"]`).waitFor();
    await shot.act?.(page);
    const durations = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.interview-status-halo, .interview-status-bubble, .interview-status-sprig, .interview-recording-ring, .interview-recording-badge svg',
        ),
      ]
        .map((node) => getComputedStyle(node))
        .filter((style) => style.animationName !== 'none')
        .map((style) => style.animationDuration),
    );
    if (durations.some((value) => !/^(0s|1e-05s|0\.00001s)$/.test(value)))
      throw new Error(
        `Reduced motion still animates ${shot.name}: ${durations.join(', ')}`,
      );
    await page.close();
  }

  console.log(
    `Quick-fire fixture: ${SHOTS.length} states × ${SIZES.length} sizes, embargo, short Submit, recording, reduced motion PASS (${destination})`,
  );
} finally {
  await browser?.close();
  await server.close();
}
