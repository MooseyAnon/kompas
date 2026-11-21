import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  call,
  openDestination,
  request,
  visible,
  waitFor,
} from './harness.mjs';

const CONFIRMATION = 'DELETE ALL APPLICATION DATA';

async function checkResetGuards(page, externalDirectory) {
  const invalid = await request(page, 'storage', 'reset.start', {
    confirmation: CONFIRMATION,
    path: externalDirectory,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  const capture = await call(page, 'audio', 'capture.begin');
  const busy = await request(page, 'storage', 'reset.start', {
    confirmation: CONFIRMATION,
  });
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, 'CONFLICT');
  await call(page, 'audio', 'capture.cancel', {
    captureId: capture.captureId,
    token: capture.token,
  });
}

async function confirmReset(page) {
  await openDestination(page, 'settings');
  await page.getByTestId('settings-nav-storage').click();
  await page.getByTestId('storage-open-reset').click();
  const dialog = page.getByRole('dialog');
  await visible(dialog);
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Delete and restart', exact: true })
      .isEnabled(),
    false,
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(
    (await call(page, 'identity', 'profile.get')).profile.displayName,
    'Before reset',
  );
  await page.getByTestId('storage-open-reset').click();
  await dialog.getByRole('textbox').fill(CONFIRMATION);
  await dialog
    .getByRole('button', { name: 'Delete and restart', exact: true })
    .click();
}

async function waitForReplacement(profile, oldPort) {
  return waitFor(
    async () => {
      try {
        const port = Number.parseInt(
          fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8'),
          10,
        );

        if (!Number.isInteger(port) || port === oldPort) return null;

        const response = await fetch(`http://127.0.0.1:${port}/json`, {
          signal: AbortSignal.timeout(1000),
        });
        const targets = await response.json();

        return targets.some((target) => target.type === 'page') ? port : null;
      } catch {
        return null;
      }
    },
    Boolean,
    'automatic packaged relaunch after reset',
    { timeout: 30000 },
  );
}

export async function resetSmoke(harness) {
  const session = await harness.launch();
  const external = harness.temporaryDirectory('external');
  const sentinel = path.join(external, 'original');
  fs.writeFileSync(sentinel, 'keep external original');
  const managed = path.join(
    session.profile,
    'documents',
    'originals',
    'test-owned',
  );
  fs.writeFileSync(managed, 'owned');

  await harness.step(
    'reset rejects arbitrary paths and active recordings; Cancel preserves data',
    async () => {
      await call(session.page, 'identity', 'profile.update', {
        patch: { displayName: 'Before reset' },
      });
      await checkResetGuards(session.page, external);
      const usage = await call(session.page, 'storage', 'usage.get');
      assert.ok(
        usage.categories.find((item) => item.category === 'documents').bytes >=
          5,
      );
    },
  );

  await harness.step(
    'confirmed reset automatically relaunches into a fresh workspace',
    async () => {
      const oldPort = Number.parseInt(
        fs.readFileSync(
          path.join(session.profile, 'DevToolsActivePort'),
          'utf8',
        ),
        10,
      );
      const exited = once(session.child, 'exit');
      await confirmReset(session.page);
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Reset did not quit the original app')),
            20000,
          );
          timer.unref();
        }),
      ]);
      const port = await waitForReplacement(session.profile, oldPort);
      const fresh = await harness.attach(session.profile, port);
      await visible(fresh.page.getByTestId('onboarding'));
      assert.equal(
        (await call(fresh.page, 'identity', 'profile.get')).profile.displayName,
        '',
      );
      assert.equal(
        (await call(fresh.page, 'documents', 'list')).items.length,
        0,
      );
      assert.equal(fs.existsSync(managed), false);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep external original');
      const usage = await call(fresh.page, 'storage', 'usage.get');
      assert.equal(usage.partial, false);
      assert.equal(
        usage.categories.find((item) => item.category === 'documents').bytes,
        0,
      );
      await fresh.page
        .getByRole('button', { name: 'Skip onboarding', exact: true })
        .click();
      await visible(fresh.page.getByTestId('page-home'));
    },
  );
}
