// Isolated real-browser inspection of the 07.3 interview primitives fixture;
// no app route and no production data. Mirrors scripts/card-visual.mjs.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const destination = process.env.CW_INTERVIEW_SCREENSHOT_DIR;
if (!destination || !fs.statSync(destination).isDirectory()) {
  throw new Error('CW_INTERVIEW_SCREENSHOT_DIR must be an existing directory');
}

const STATES = [
  'status-large',
  'status-compact',
  'recording',
  'transcription',
  'error',
  'feedback',
];
const SIZES = [
  ['wide', 1100, 780],
  ['compact', 560, 760],
];

async function checkRecordingSignal(page) {
  const recording = await page
    .locator('.interview-recording')
    .evaluate((node) => ({
      text: node.textContent,
      ring: getComputedStyle(node.querySelector('.interview-recording-ring'))
        .animationName,
      stopVisible: !!node.querySelector('[data-testid$="-stop"]'),
    }));

  if (
    !recording.text.includes('Recording') ||
    recording.ring === 'none' ||
    !recording.stopVisible
  ) {
    throw new Error(`recording signal failed: ${JSON.stringify(recording)}`);
  }
}

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
  const base = `http://127.0.0.1:${address.port}/test/fixtures/interview-primitives-preview.html`;
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next installed browser.
    }
  }
  if (!browser)
    throw new Error('No installed Chrome or Edge for visual fixture');

  for (const [size, width, height] of SIZES) {
    for (const state of STATES) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`${base}?state=${state}`);
      await page.locator('[data-testid="fixture-card"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      // Let entry animations settle so screenshots are stable.
      await page.waitForTimeout(500);

      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        statuses: [...document.querySelectorAll('[role="status"]')].map(
          (node) => node.textContent,
        ),
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
        percent: /\d+\s?%/.test(
          document.querySelector('.interview-status')?.textContent ?? '',
        ),
      }));
      if (
        layout.overflow ||
        !layout.decorationsHidden ||
        !layout.decorationsInert ||
        layout.percent
      )
        throw new Error(
          `${state} at ${size} failed: ${JSON.stringify(layout)}`,
        );

      if (state === 'recording') {
        await checkRecordingSignal(page);
      }

      await page.screenshot({
        path: path.join(destination, `interview-${state}-${size}.png`),
        fullPage: true,
      });
      await page.close();
    }
  }

  // Phrases rotate on the documented cadence and only the label is announced.
  const rotation = await browser.newPage({
    viewport: { width: 1100, height: 780 },
  });
  await rotation.goto(`${base}?state=status-large`);
  const phrase = rotation.locator('[data-testid="fixture-status-phrase"]');
  const first = await phrase.textContent();
  await rotation.waitForTimeout(4300);
  const second = await phrase.textContent();
  if (first === second) throw new Error('Status phrase did not rotate');
  await rotation.close();

  // Reduced motion stops the bubble, sprig and recording animations.
  for (const state of ['status-large', 'status-compact', 'recording']) {
    const reduced = await browser.newPage({ reducedMotion: 'reduce' });
    await reduced.goto(`${base}?state=${state}`);
    await reduced.locator('[data-testid="fixture-card"]').waitFor();
    const durations = await reduced.evaluate(() =>
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
        `Reduced motion still animates ${state}: ${durations.join(', ')}`,
      );
    await reduced.close();
  }

  console.log(
    `Interview primitives fixture: ${STATES.length} states × ${SIZES.length} sizes, rotation, reduced motion PASS (${destination})`,
  );
} finally {
  await browser?.close();
  await server.close();
}
