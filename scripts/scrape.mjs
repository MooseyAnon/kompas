import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';

// ---- Configuration ----
const HEADLESS = true;

const SELECTORS = [
  //   'a[data-testid="result-title-a"]',
  'article[data-testid="result"], li[data-layout="organic"], div.result__body',
  // '.another-selector',
];

// Set SELECTORS = [] to save the full HTML.
// -----------------------

const url = process.argv[2];
const output = process.argv[3] ?? 'page.html';

if (!url) {
  console.error('Usage: node scrape.mjs "<url>" [output.html]');
  process.exit(1);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: HEADLESS,
  args: ['--window-size=1280,900'],
});

try {
  const probe = await browser.newContext();
  const rawUA = await (
    await probe.newPage()
  ).evaluate(() => navigator.userAgent);
  await probe.close();

  const cleanUA = rawUA.replace(/HeadlessChrome/g, 'Chrome');
  const major = (cleanUA.match(/Chrome\/(\d+)/) || [])[1] || '156';

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    userAgent: cleanUA,
    extraHTTPHeaders: {
      'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="24"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();

  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  if (SELECTORS.length > 0) {
    // Wait for at least one matching element to appear.
    await page
      .locator(SELECTORS.join(', '))
      .first()
      .waitFor({
        state: 'attached',
        timeout: 10000,
      })
      .catch(() => {
        console.warn('No matching elements appeared within 10 seconds.');
      });
  } else {
    await page
      .waitForLoadState('networkidle', {
        timeout: 10000,
      })
      .catch(() => {});
  }

  let html;

  if (SELECTORS.length === 0) {
    html = await page.content();
  } else {
    const fragments = [];

    for (const selector of SELECTORS) {
      const elements = page.locator(selector);
      const count = await elements.count();

      console.log(`Selector: ${selector} | Found: ${count}`);

      const matches = await elements.evaluateAll((nodes) =>
        nodes.map((node) => node.outerHTML),
      );

      fragments.push(...matches);
    }

    html = [
      '<!DOCTYPE html>',
      '<html><head><meta charset="utf-8"></head><body>',
      ...fragments,
      '</body></html>',
    ].join('\n');
  }

  await writeFile(output, html, 'utf8');

  console.log(`URL: ${page.url()}`);
  console.log(`HTTP: ${response?.status() ?? 'unknown'}`);
  console.log(`Saved: ${output} (${html.length} characters)`);

  if (!HEADLESS) {
    console.log('Press Enter to close browser...');
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once('data', resolve);
    });
  }

  await context.close();
} finally {
  await browser.close();
}
