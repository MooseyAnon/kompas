// Capture every page and tab of a running design preview.
//
//   npm run preview:design                 (in one terminal)
//   npm run preview:screens -- <out-dir>   (in another)
//
// Options (env): PREVIEW_URL, PREVIEW_WIDTHS="1440,1024,430", CHROME_PATH,
// PREVIEW_ONLY="jobs,settings" to limit pages.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const url =
  process.env.PREVIEW_URL ?? 'http://127.0.0.1:5199/scripts/design-preview/';
const outDir = path.resolve(process.argv[2] ?? 'out/design-screens');
const widths = (process.env.PREVIEW_WIDTHS ?? '1440').split(',').map(Number);
const only = process.env.PREVIEW_ONLY?.split(',');
const pages = ['home', 'jobs', 'interviews', 'applications', 'settings'].filter(
  (id) => !only || only.includes(id),
);

fs.mkdirSync(outDir, { recursive: true });

async function launch() {
  if (process.env.CHROME_PATH) {
    return chromium.launch({ executablePath: process.env.CHROME_PATH });
  }
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Chrome or Edge found; set CHROME_PATH.');
}

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(700);
}

const browser = await launch();
const written = [];
try {
  for (const width of widths) {
    const page = await browser.newPage({
      viewport: { width, height: Math.round(width * 0.625) },
    });
    for (const destination of pages) {
      await page.goto(url);
      await page.getByTestId('app-shell').waitFor({ timeout: 15_000 });
      if (['jobs', 'interviews'].includes(destination)) {
        await page.getByTestId(`nav-${destination}`).click();
      } else if (destination !== 'home') {
        // Profile & applications and Settings live in the name menu.
        await page.getByTestId('nav-account').click();
        await page.getByTestId(`nav-${destination}`).click();
      }
      await settle(page);

      // Pages switch sections with pill tabs; Settings uses a section nav.
      let tabs = page.locator('main [role="tablist"]').first().getByRole('tab');
      if ((await tabs.count()) === 0) {
        tabs = page.locator('main [data-testid^="settings-nav-"]');
      }
      const count = await tabs.count();
      const shots = count ? [...Array(count).keys()] : [null];
      for (const index of shots) {
        let name = destination;
        if (index !== null) {
          const tab = tabs.nth(index);
          name += `--${slug((await tab.innerText()) || `tab-${index}`)}`;
          await tab.click();
          await settle(page);
        }
        const file = path.join(outDir, `${name}--${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        written.push(file);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${written.length} screenshots to ${outDir}`);
