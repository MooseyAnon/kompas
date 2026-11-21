import assert from 'node:assert/strict';
import {
  call,
  checkViewports,
  contains,
  openDestination,
  selectModel,
  visible,
  waitFor,
} from './harness.mjs';
import { writePdf } from './fixtures.mjs';

async function editProfile(page, name) {
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Edit professional details' })
    .waitFor({ state: 'hidden' });
  assert.equal(
    (await call(page, 'identity', 'profile.get')).profile.displayName,
    name,
  );
}

async function addTargets(page, roles) {
  for (const role of roles) {
    await page.getByRole('button', { name: 'Add target', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Target role', exact: true })
      .fill(role);
    await page
      .getByRole('button', { name: 'Save target', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Add target role', exact: true })
      .waitFor({ state: 'hidden' });
    const { items } = await call(page, 'identity', 'targets.list');
    assert.ok(
      items.some((item) => item.roleTitle === role),
      'User-entered target was not saved',
    );
  }
}

async function assertIdentity(page, name, roles) {
  const { profile } = await call(page, 'identity', 'profile.get');
  const { items } = await call(page, 'identity', 'targets.list');
  assert.equal(profile.displayName, name);
  assert.deepEqual(
    items.map((item) => item.roleTitle).sort(),
    [...roles].sort(),
  );
}

export async function profileSmoke(harness) {
  let session = await harness.launch();
  const roles = ['Researcher', 'Designer'];

  await harness.step(
    'edit profile and career targets through the UI',
    async () => {
      const { page } = session;
      await openDestination(page, 'profile');
      await editProfile(page, 'Profile smoke');
      await page.getByRole('tab', { name: 'Targets', exact: true }).click();
      await addTargets(page, roles);
      await checkViewports(
        page,
        page.getByRole('button', { name: 'Add target', exact: true }),
      );
    },
  );

  await harness.step(
    'keyboard navigation and saved identity survive relaunch',
    async () => {
      await session.page
        .getByRole('tab', { name: 'Education', exact: true })
        .click();
      await session.page.keyboard.press('ArrowRight');
      assert.equal(
        await session.page
          .getByRole('tab', { name: 'Skills', exact: true })
          .getAttribute('aria-selected'),
        'true',
      );
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({ profile });
      await assertIdentity(session.page, 'Profile smoke', roles);
      await openDestination(session.page, 'profile');
      await contains(
        session.page.getByTestId('profile-view-overview'),
        'Profile smoke',
      );
    },
  );

  await harness.step(
    'review and explicitly confirm an imported CV through Documents',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      const pickFile = await writePdf(harness.temporaryDirectory('profile-cv'));
      session = await harness.launch({ profile, pickFile });
      await reviewCv(session.page);
      await assertIdentity(session.page, 'UI-reviewed CV Tester', roles);
    },
  );
}

async function reviewCv(page) {
  await selectModel(page, 'mock-cv');
  await openDestination(page, 'profile');
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await confirmCv(page, 'Profile smoke');
}

async function confirmCv(page, originalName) {
  await page.getByRole('button', { name: 'Choose file', exact: true }).click();
  const proposal = page.getByRole('textbox', {
    name: 'Proposed displayName',
    exact: true,
  });
  await visible(proposal);
  assert.equal(
    (await call(page, 'identity', 'profile.get')).profile.displayName,
    originalName,
  );
  await proposal.fill('UI-reviewed CV Tester');
  await page.getByRole('checkbox', { name: /^Confirm displayName/ }).check();
  await page
    .getByRole('button', {
      name: 'Confirm selected profile, experience and skills',
      exact: true,
    })
    .click();
  await waitFor(
    () => call(page, 'identity', 'profile.get'),
    (value) => value.profile.displayName === 'UI-reviewed CV Tester',
    'reviewed CV fields saved',
  );
}

async function beginOnboarding(page, route) {
  await visible(page.getByTestId('onboarding'));
  assert.equal(
    (await call(page, 'system', 'onboarding.status.get')).completed,
    false,
  );
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await visible(
    page.getByRole('heading', { name: 'Workspace readiness', exact: true }),
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: route, exact: true }).click();
}

async function checkInitialReadiness(page) {
  await visible(
    page.getByRole('heading', {
      name: 'Your next chapter starts here',
      exact: true,
    }),
  );
  await checkViewports(
    page,
    page.getByRole('button', { name: 'Get started', exact: true }),
  );
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await visible(
    page.getByRole('heading', { name: 'Workspace readiness', exact: true }),
  );
  await checkViewports(
    page,
    page.getByRole('button', { name: 'Configure local AI', exact: true }),
  );
  await page
    .getByRole('button', { name: 'Configure local AI', exact: true })
    .click();
  await visible(page.getByTestId('settings-view-local-ai'));
  await page
    .getByRole('button', { name: 'Back to setup', exact: true })
    .click();
  await visible(
    page.getByRole('heading', { name: 'Workspace readiness', exact: true }),
  );
}

async function enterWithoutModel(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await contains(page.getByRole('status'), 'CV parsing requires');
  assert.equal(
    await page
      .getByRole('button', { name: 'Import a CV', exact: true })
      .isEnabled(),
    false,
  );
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await beginOnboarding(page, 'Enter manually');
  await editProfile(page, 'Onboarding fixture');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await addTargets(page, ['Analyst', 'Writer']);
}

async function configureCvFixture(page) {
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByRole('button', { name: 'Configure local AI', exact: true })
    .click();
  await visible(page.getByTestId('settings-view-local-ai'));
  // Use the IPC fixture so this smoke never needs installed Ollama models.
  await selectModel(page, 'mock-cv');
  await page
    .getByRole('button', { name: 'Back to setup', exact: true })
    .click();
  await contains(page.getByRole('status'), 'ready for CV parsing');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const modelCard = page
    .getByRole('heading', { name: 'Local model', exact: true })
    .locator('..');
  await contains(modelCard, 'Ready');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
}

export async function onboardingSmoke(harness) {
  let session = await harness.launch({ onboarding: true });

  await harness.step(
    'welcome precedes model setup and Settings returns to readiness',
    () => checkInitialReadiness(session.page),
  );

  await harness.step(
    'missing model blocks CV but permits manual identity entry',
    () => enterWithoutModel(session.page),
  );

  await harness.step(
    'unfinished setup retains edits and explicit skip persists',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({ profile, onboarding: true });
      await visible(session.page.getByTestId('onboarding'));
      await assertIdentity(session.page, 'Onboarding fixture', [
        'Analyst',
        'Writer',
      ]);
      assert.equal(
        (await call(session.page, 'system', 'onboarding.status.get')).completed,
        false,
      );
      await session.page
        .getByRole('button', { name: 'Skip onboarding', exact: true })
        .click();
      await visible(session.page.getByTestId('page-home'));
      await harness.stop(session);
      session = await harness.launch({ profile, onboarding: true });
      await visible(session.page.getByTestId('page-home'));
      assert.equal(
        (await call(session.page, 'system', 'onboarding.status.get')).completed,
        true,
      );
    },
  );

  await harness.step(
    'configured model parses a CV and only confirmed facts reach the workspace',
    async () => {
      const pickFile = await writePdf(
        harness.temporaryDirectory('onboarding-cv'),
      );
      session = await harness.launch({ onboarding: true, pickFile });
      const { page } = session;
      await configureCvFixture(page);
      await beginOnboarding(page, 'Import a CV');
      await visible(page.getByTestId('profile-view-documents'));
      await confirmCv(page, '');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await visible(page.getByTestId('profile-view-targets'));
      await page
        .getByRole('button', { name: 'Skip for now', exact: true })
        .click();
      await visible(
        page.getByRole('heading', {
          name: 'Enter your workspace',
          exact: true,
        }),
      );
      await page
        .getByRole('button', { name: 'Open my workspace', exact: true })
        .click();
      await visible(page.getByTestId('page-home'));
      assert.equal(
        (await call(page, 'system', 'onboarding.status.get')).completed,
        true,
      );
      await assertIdentity(page, 'UI-reviewed CV Tester', []);
    },
  );
}
