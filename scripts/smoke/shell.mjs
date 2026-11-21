import assert from 'node:assert/strict';
import {
  call,
  checkViewports,
  contains,
  openDestination,
  visible,
  waitFor,
} from './harness.mjs';

const GENERATION_TARGET_SECONDS = 900;
const GENERATION_TARGET_MS = GENERATION_TARGET_SECONDS * 1000;

async function chooseWithPalette(page, name) {
  await page.keyboard.press('Meta+k');
  const dialog = page.getByRole('dialog', {
    name: 'Go to a page',
    exact: true,
  });
  await visible(dialog);
  await dialog
    .getByRole('combobox', { name: 'Search pages', exact: true })
    .fill(name);
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await visible(page.getByTestId(`page-${name.toLowerCase()}`));
}

export async function shellSmoke(harness) {
  const { page } = await harness.launch();

  await harness.step(
    'Home search and keyboard navigation open a destination',
    async () => {
      const search = page.getByRole('combobox', {
        name: 'Search home pages',
        exact: true,
      });
      await checkViewports(
        page,
        page.getByRole('option', { name: 'Profile', exact: true }),
      );
      await search.fill('Profile');
      await search.press('Enter');
      await visible(page.getByTestId('profile-page'));
    },
  );

  await harness.step(
    'page palette supports Escape, focus restoration and all destinations',
    async () => {
      const trigger = page.getByRole('button', {
        name: 'Open page palette',
        exact: true,
      });
      await trigger.click();
      const dialog = page.getByRole('dialog', {
        name: 'Go to a page',
        exact: true,
      });
      await visible(dialog);
      await dialog.getByRole('combobox').fill('Settings');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(
        await trigger.evaluate((element) => element === document.activeElement),
        true,
      );

      for (const destination of ['Jobs', 'Interviews', 'Settings', 'Home']) {
        await chooseWithPalette(page, destination);
      }

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await chooseWithPalette(page, 'Profile');
      await visible(page.getByTestId('profile-view-overview'));
    },
  );
}

async function saveTimeout(page) {
  const input = page.getByTestId('ai-timeout-input');
  await input.fill(String(GENERATION_TARGET_SECONDS));
  await page.getByTestId('ai-timeout-save').click();
  await waitFor(
    () => call(page, 'inference', 'settings.get'),
    (value) => value.settings.generationTimeoutMs === GENERATION_TARGET_MS,
    'Local AI timeout saved',
  );
}

export async function settingsSmoke(harness) {
  let session = await harness.launch();

  await harness.step('Local AI settings save through the UI', async () => {
    await openDestination(session.page, 'settings');
    await visible(session.page.getByTestId('ai-status'));
    await saveTimeout(session.page);
    await checkViewports(
      session.page,
      session.page.getByTestId('ai-timeout-input'),
    );
  });

  await harness.step(
    'settings views expose reachable refresh and storage actions',
    async () => {
      const { page } = session;

      for (const [section, control] of [
        ['audio', 'audio-refresh'],
        ['browsers', 'browser-refresh'],
        ['system', 'system-refresh'],
        ['diagnostics', 'diagnostics-refresh'],
        ['storage', 'storage-refresh'],
      ]) {
        await page.getByTestId(`settings-nav-${section}`).click();
        await page.getByTestId(control).click();
        await checkViewports(page, page.getByTestId(control));
      }

      await visible(page.getByTestId('storage-total'));
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
      await dialog.waitFor({ state: 'hidden' });
    },
  );

  await harness.step(
    'saved timeout survives packaged restart and can be reset',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({ profile });
      assert.equal(
        (await call(session.page, 'inference', 'settings.get')).settings
          .generationTimeoutMs,
        GENERATION_TARGET_MS,
      );
      await openDestination(session.page, 'settings');
      assert.equal(
        await session.page.getByTestId('ai-timeout-input').inputValue(),
        String(GENERATION_TARGET_SECONDS),
      );
      await session.page.getByTestId('ai-timeout-reset').click();
      await contains(
        session.page.getByTestId('ai-timeout-effective'),
        '10 min',
      );
    },
  );
}
