// Isolated real-browser inspection of the presentation fixture; no app route.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const destination = process.env.CW_CARD_SCREENSHOT_DIR;
if (!destination || !fs.statSync(destination).isDirectory()) {
  throw new Error('CW_CARD_SCREENSHOT_DIR must be an existing directory');
}

const server = await createServer({
  configFile: false,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/test/fixtures/cards-preview.html`;
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

  for (const [name, width, height] of [
    ['wide', 1100, 780],
    ['compact', 430, 800],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url);
    await page.locator('[data-testid="main-card"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const main = page.locator('[data-testid="main-card"]');
    const nested = page.locator('[data-testid="nested-card"]');
    const cardButton = page.getByRole('button', { name: 'Model 4B · Select' });
    if (
      (await main.evaluate((node) => getComputedStyle(node).boxShadow)) ===
        'none' ||
      (await nested.evaluate((node) => getComputedStyle(node).boxShadow)) !==
        'none' ||
      (await main.evaluate((node) => getComputedStyle(node).overflow)) !==
        'visible' ||
      (await page.evaluate(() => document.documentElement.scrollWidth)) > width
    ) {
      throw new Error(`Card visual/layout check failed at ${width}px`);
    }
    await cardButton.focus();
    await page.keyboard.press('Enter');
    if ((await cardButton.getAttribute('aria-pressed')) !== 'true') {
      throw new Error('Keyboard card activation failed');
    }
    await cardButton.hover();
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="model-card"]');
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      button.append(probe);
      const selected =
        getComputedStyle(button).borderColor === getComputedStyle(probe).color;
      probe.remove();
      return selected;
    });
    const summary = page.locator('.ui-disclosure-summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    if (
      !(await page
        .locator('[data-testid="technical-details"]')
        .evaluate((node) => node.open))
    ) {
      throw new Error('Keyboard disclosure activation failed');
    }
    await page.screenshot({
      path: path.join(destination, `cards-${name}.png`),
      fullPage: true,
    });
    await page.close();
  }

  const reduced = await browser.newPage({ reducedMotion: 'reduce' });
  await reduced.goto(url);
  const duration = await reduced
    .locator('.ui-disclosure-summary svg')
    .evaluate((node) => getComputedStyle(node).transitionDuration);
  if (duration !== '1e-05s' && duration !== '0.00001s' && duration !== '0s') {
    throw new Error(`Reduced motion still animates the chevron: ${duration}`);
  }
  await reduced.close();
  console.log(
    `Card fixture: wide, compact, keyboard, reduced motion PASS (${destination})`,
  );
} finally {
  await browser?.close();
  await server.close();
}
