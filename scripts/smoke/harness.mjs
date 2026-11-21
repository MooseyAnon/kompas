import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { SmokeLifecycle } from '../smoke-lifecycle.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const APP_BINARY = path.join(
  REPO_ROOT,
  'out',
  'Kompas-darwin-arm64',
  'Kompas.app',
  'Contents',
  'MacOS',
  'Kompas',
);
const WAIT_MS = 20000;
const POLL_MS = 100;
const WIDE_VIEWPORT = { width: 1440, height: 900 };
const COMPACT_VIEWPORT = { width: 620, height: 520 };

/**
 * Poll observable state, retaining only a caller-supplied safe status summary.
 * @template T
 * @param {() => Promise<T>} read
 * @param {(value: T) => boolean} accept
 * @param {string} label
 * @param {{timeout?: number, summarize?: (value: T) => unknown}} options
 */
export async function waitFor(
  read,
  accept,
  label,
  { timeout = WAIT_MS, summarize = () => undefined } = {},
) {
  const deadline = Date.now() + timeout;
  let value;

  do {
    value = await read();

    if (accept(value)) {
      return value;
    }

    await delay(POLL_MS);
  } while (Date.now() < deadline);

  const summary = summarize(value);
  throw new Error(
    `Timed out: ${label}${summary === undefined ? '' : `; observed ${JSON.stringify(summary)}`}`,
  );
}

/** Raw envelopes are retained for rejection checks; payloads never enter error messages. */
export function request(page, module, action, payload = {}, version = 1) {
  return page.evaluate((envelope) => window.career.request(envelope), {
    module,
    version,
    action,
    payload,
  });
}

export async function call(page, module, action, payload = {}) {
  const response = await request(page, module, action, payload);
  assert.equal(
    response.ok,
    true,
    `${module}.${action}: ${response.error?.code ?? 'missing response'}`,
  );

  return response.data;
}

export async function selectModel(page, modelId = 'mock-interview') {
  await call(page, 'inference', 'settings.update', {
    patch: { providerId: 'mock', modelId },
  });
}

export async function openDestination(page, destination) {
  await page.getByTestId(`home-command-destination-${destination}`).click();
  await page.getByTestId(`${destination}-page`).waitFor();
}

export async function visible(locator) {
  await locator.waitFor({ state: 'visible' });
}

export async function contains(locator, text) {
  await waitFor(
    () => locator.textContent(),
    (value) => value?.includes(text),
    `visible fixture content: ${text}`,
  );
  await visible(locator);
}

/** Exercise real scrolling and hit targets instead of assuming a particular layout. */
export async function checkReachable(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ trial: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  assert.equal(overflow, false, 'Page has horizontal overflow');
}

export async function checkViewports(page, control) {
  for (const viewport of [WIDE_VIEWPORT, COMPACT_VIEWPORT]) {
    await page.setViewportSize(viewport);
    await checkReachable(page, control);
  }

  await page.setViewportSize(WIDE_VIEWPORT);
}

async function devToolsPort(profile) {
  return waitFor(
    async () => {
      try {
        return Number.parseInt(
          fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8'),
          10,
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;

        return null;
      }
    },
    (port) => Number.isInteger(port) && port > 0,
    'packaged DevTools endpoint',
  );
}

/** Owns app processes separately from browser connections, including reset relaunches. */
class SmokeHarness {
  lifecycle = new SmokeLifecycle(APP_BINARY);

  sessions = new Set();

  steps = [];

  failureStep;

  constructor(phase) {
    this.phase = phase;
  }

  temporaryDirectory(name) {
    return this.lifecycle.tempDirectory(path.join(os.tmpdir(), `cw-${name}-`));
  }

  async step(label, operation) {
    this.steps.push(label);
    console.log(`[smoke] ${this.phase}: ${label}`);

    try {
      return await operation();
    } catch (error) {
      this.failureStep ??= this.steps.join(' / ');
      throw new Error(`${this.phase} / ${label}: ${error.message}`, {
        cause: error,
      });
    } finally {
      this.steps.pop();
    }
  }

  async attach(profile, port) {
    this.lifecycle.check();
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${port ?? (await devToolsPort(profile))}`,
    );
    const session = { browser, profile, page: null };
    this.sessions.add(session);
    const context = browser.contexts()[0];
    session.page = context.pages()[0] ?? (await context.waitForEvent('page'));
    session.page.setDefaultTimeout(WAIT_MS);
    await session.page.waitForFunction(
      () => typeof window.career?.request === 'function',
    );
    await session.page.setViewportSize(WIDE_VIEWPORT);

    return session;
  }

  async launch({
    profile = this.temporaryDirectory(this.phase),
    pickFile = '',
    env = {},
    onboarding = false,
  } = {}) {
    assert.ok(fs.existsSync(APP_BINARY), 'Run npm run package before smoke');
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    const child = spawn(
      APP_BINARY,
      ['--remote-debugging-port=0', `--user-data-dir=${profile}`],
      {
        env: {
          ...process.env,
          CAREER_SMOKE: '1',
          CAREER_SMOKE_PICK_FILE: pickFile,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    this.lifecycle.ownChild(child, profile);
    // Drain output without logging private application content.
    child.stdout.resume();
    child.stderr.resume();
    await once(child, 'spawn');
    const session = await this.attach(profile);
    session.child = child;

    if (!onboarding) {
      await call(session.page, 'system', 'onboarding.complete');
      await session.page.reload();
      await session.page.getByTestId('page-home').waitFor();
    }

    return session;
  }

  async stop(session) {
    await this.lifecycle.stopProfile(session.profile);
    await session.browser.close();
    this.sessions.delete(session);
  }

  async captureFailure() {
    const directory =
      process.env.CW_SMOKE_ARTIFACT_DIR ??
      fs.mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-failure-'));
    fs.mkdirSync(directory, { recursive: true });
    let index = 0;

    for (const { page } of this.sessions) {
      if (!page || page.isClosed()) continue;

      try {
        const file = path.join(directory, `${this.phase}-${index++}.png`);
        await page.screenshot({ path: file, timeout: 3000 });
        console.error(
          `[smoke] ${this.failureStep ?? 'launch'}: screenshot ${file}`,
        );
      } catch {
        console.error('[smoke] Failure screenshot unavailable');
      }
    }
  }

  async close() {
    // runSmoke still owns final cleanup if a stop fails partway through.
    for (const session of this.sessions) {
      try {
        await this.stop(session);
      } catch (error) {
        this.lifecycle.cleanupErrors.push(error);
      }
    }
  }
}

export function createHarness(phase) {
  return new SmokeHarness(phase);
}
