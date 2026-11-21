import assert from 'node:assert/strict';
import {
  call,
  checkViewports,
  contains,
  openDestination,
  visible,
  waitFor,
} from './harness.mjs';

async function openApplications(page) {
  await openDestination(page, 'jobs');
  await page.getByRole('tab', { name: 'Applications', exact: true }).click();
  await visible(page.getByTestId('applications-board'));
}

async function createApplication(page) {
  await page
    .getByRole('button', { name: 'Add application', exact: true })
    .click();
  const form = page.getByTestId('application-create');
  await form
    .getByRole('button', { name: 'Enter manually', exact: true })
    .first()
    .click();
  await form.getByLabel('Company *', { exact: true }).fill('Example Employer');
  await form.getByLabel('Role *', { exact: true }).fill('Platform Engineer');
  await form.getByLabel(/^Current category/).selectOption('interview');
  await form
    .getByLabel('Specific stage label *', { exact: true })
    .fill('Technical Round 1');
  await form
    .getByRole('button', { name: 'Save application', exact: true })
    .click();
  await visible(page.getByTestId('application-detail'));

  return (await call(page, 'applications', 'list', { limit: 20 })).items[0].id;
}

async function updateApplication(page, id) {
  const detail = page.getByTestId('application-detail');
  await detail
    .getByLabel('Specific stage label *', { exact: true })
    .fill('Technical Round 2');
  await detail
    .getByRole('button', { name: 'Record stage event', exact: true })
    .click();
  await waitFor(
    () => call(page, 'applications', 'get', { id }),
    (value) => value.item.stages.length === 2,
    'second stage persisted',
  );
  await detail
    .getByLabel(/^Manually capture original JD/)
    .fill('Original role duties and requirements.');
  await detail
    .getByRole('button', { name: 'Capture JD once', exact: true })
    .click();
  await visible(detail.getByText('Read full saved JD', { exact: true }));
  await detail
    .getByLabel('New note', { exact: true })
    .fill('Follow up with recruiter.');
  await detail.getByRole('button', { name: 'Add note', exact: true }).click();
  await contains(detail, 'Follow up with recruiter.');
}

async function archiveAndRestore(page, id) {
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Archive application', exact: true })
    .click();
  await visible(
    page.getByRole('button', { name: 'Restore application', exact: true }),
  );
  assert.ok(
    (await call(page, 'applications', 'get', { id })).item.application
      .archivedAt,
  );
  await page
    .getByRole('button', { name: 'Restore application', exact: true })
    .click();
  await visible(
    page.getByRole('button', { name: 'Archive application', exact: true }),
  );
  await page
    .getByRole('button', { name: 'Back to Applications', exact: true })
    .click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await visible(
    page.getByRole('button', {
      name: 'Open application: Platform Engineer at Example Employer',
      exact: true,
    }),
  );
}

async function checkUrlFallback(page) {
  await page
    .getByRole('button', { name: 'Add application', exact: true })
    .click();
  const form = page.getByTestId('application-create');
  // Invalid reserved domain exercises the manual fallback without a live website.
  await form
    .getByLabel('Job URL (optional for manual entry)', { exact: true })
    .fill('https://example.invalid/jobs/role');
  await form
    .getByRole('button', { name: 'Preview job URL', exact: true })
    .click();
  await waitFor(
    () =>
      form
        .getByRole('button', { name: 'Preview job URL', exact: true })
        .isEnabled(),
    Boolean,
    'URL preview settles',
    { timeout: 40000 },
  );
  await form
    .getByRole('button', { name: 'Enter manually', exact: true })
    .first()
    .click();
  assert.equal(
    await form
      .getByLabel('Job URL (optional for manual entry)', { exact: true })
      .inputValue(),
    'https://example.invalid/jobs/role',
  );
  assert.equal(
    (await call(page, 'applications', 'list', { limit: 20 })).items.length,
    1,
    'Preview created an application without confirmation',
  );
}

export async function applicationsSmoke(harness) {
  let session = await harness.launch();
  let id;

  await harness.step('manually create and update an application', async () => {
    await openApplications(session.page);
    id = await createApplication(session.page);
    await updateApplication(session.page, id);
    await checkViewports(
      session.page,
      session.page.getByRole('button', { name: 'Add note', exact: true }),
    );
    await archiveAndRestore(session.page, id);
    await checkUrlFallback(session.page);
  });

  await harness.step(
    'stage history, original JD and notes survive restart',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({ profile });
      const { item } = await call(session.page, 'applications', 'get', { id });
      assert.equal(item.stages.length, 2);
      assert.equal(
        item.application.currentStage.stageLabel,
        'Technical Round 2',
      );
      assert.equal(
        item.snapshot?.descriptionText,
        'Original role duties and requirements.',
      );
      assert.equal(item.notes.length, 1);
      assert.equal(item.application.archivedAt, null);
      await openApplications(session.page);
      await session.page
        .getByRole('button', {
          name: 'Open application: Platform Engineer at Example Employer',
          exact: true,
        })
        .click();
      await contains(
        session.page.getByTestId('application-detail'),
        'Technical Round 2',
      );
    },
  );
}
