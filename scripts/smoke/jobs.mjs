import assert from 'node:assert/strict';
import {
  call,
  checkViewports,
  contains,
  openDestination,
  request,
  selectModel,
  visible,
  waitFor,
} from './harness.mjs';
import { discoveryConfig } from './fixtures.mjs';

const FIXTURE_ENV = {
  CW_DISCOVERY_FIXTURE: '1',
  CW_DISCOVERY_FIXTURE_JOBS: '1',
};
const LISTING_URL = 'https://uk.linkedin.com/jobs/view/software-intern-7654321';
const CANONICAL_URL = 'https://boards.greenhouse.io/acme/jobs/3456789';

function readRun(page, id) {
  return call(page, 'jobDiscovery', 'runs.workflow.state.get', { id }).then(
    (value) => value.state,
  );
}

function waitForRun(page, id, accept, label) {
  return waitFor(() => readRun(page, id), accept, label, {
    summarize: (state) => ({
      status: state.status,
      counts: state.counts,
      diagnostics: state.diagnostics.map((item) => item.code),
    }),
  });
}

async function openRun(page) {
  await openDestination(page, 'jobs');
  await page.getByRole('tab', { name: 'Discover', exact: true }).click();
  await page.getByRole('button', { name: 'Open run', exact: true }).click();
  await visible(page.getByTestId('jobs-run-detail'));
}

async function planAndExecuteRun(page) {
  const { item: saved } = await call(
    page,
    'jobDiscovery',
    'savedSearches.create',
    {
      config: discoveryConfig(),
    },
  );
  const { item } = await call(page, 'jobDiscovery', 'runs.start', {
    savedSearchId: saved.id,
  });
  const planned = await readRun(page, item.id);
  assert.equal(planned.workActive, false);
  assert.equal(planned.counts.admitted, 0);
  await call(page, 'jobDiscovery', 'runs.workflow.execute', { id: item.id });

  return item.id;
}

export async function discoverySmoke(harness) {
  let session = await harness.launch({ env: { CW_DISCOVERY_FIXTURE: '1' } });
  let id;

  await harness.step(
    'explicit execution publishes partial evidence and an actionable model failure',
    async () => {
      const { page } = session;
      id = await planAndExecuteRun(page);
      const state = await waitForRun(
        page,
        id,
        (value) =>
          value.counts.verified === 1 &&
          value.candidates[0]?.extraction.status === 'failed',
        'verified candidate despite unavailable model',
      );
      assert.equal(state.status, 'running');
      assert.equal(state.candidates[0].extraction.reason, 'MODEL_UNAVAILABLE');
      const rejected = await request(
        page,
        'jobDiscovery',
        'runs.workflow.state.get',
        { id, url: 'file:///private' },
      );
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, 'INVALID_INPUT');
      await openRun(page);
      const candidate = page.getByTestId(
        `jobs-candidate-${state.candidates[0].sourceId}`,
      );
      await candidate.getByText('Details', { exact: true }).click();
      await contains(candidate, LISTING_URL);
      await contains(candidate, CANONICAL_URL);
      await checkViewports(
        page,
        candidate.getByText('Details', { exact: true }),
      );
    },
  );

  await harness.step(
    'cancelled discovery retains evidence after restart',
    async () => {
      await session.page
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
      await session.page
        .getByRole('button', { name: 'Confirm cancel', exact: true })
        .click();
      await waitForRun(
        session.page,
        id,
        (state) => state.status === 'cancelled',
        'explicit cancellation',
      );
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({
        profile,
        env: { CW_DISCOVERY_FIXTURE: '1' },
      });
      const durable = await readRun(session.page, id);
      assert.equal(durable.status, 'cancelled');
      assert.equal(durable.counts.verified, 1);
      assert.equal(durable.discovery.submitted, null);
    },
  );
}

async function saveSearch(page) {
  await openDestination(page, 'jobs');
  await page.getByTestId('jobs-new').click();
  const editor = page.getByTestId('jobs-editor');
  await editor.getByLabel(/^Search name/).fill('Packaged Jobs acceptance');
  await editor
    .getByLabel(/^Target roles/)
    .fill('Software Intern\nData Analyst');
  await editor.getByRole('checkbox', { name: 'Indeed', exact: true }).uncheck();
  await editor.getByRole('checkbox', { name: 'LinkedIn', exact: true }).check();
  await editor.getByText('Advanced run limits', { exact: true }).click();

  for (const [label, value] of [
    ['Queries', '2'],
    ['New candidates', '2'],
    ['Collection pages', '1'],
    ['Targeted searches per candidate', '1'],
    ['Pages per targeted search', '1'],
    ['Concurrent web operations', '2'],
  ]) {
    await editor.getByLabel(new RegExp(`^${label} ·`)).fill(value);
  }

  await editor
    .getByRole('button', { name: 'Save search', exact: true })
    .click();
  const { items } = await waitFor(
    () => call(page, 'jobDiscovery', 'savedSearches.list'),
    (value) => value.items.length === 1,
    'UI search saved',
  );
  assert.deepEqual(items[0].config.intent.targetRoles, [
    'Software Intern',
    'Data Analyst',
  ]);
  assert.deepEqual(items[0].config.sources.collectionProviders, ['linkedin']);
  assert.equal(items[0].config.run.maxNewCandidates, 2);
  await editor
    .getByRole('button', { name: 'Preview saved queries', exact: true })
    .click();
  const { queries } = await call(page, 'jobDiscovery', 'runs.preview', {
    savedSearchId: items[0].id,
  });

  for (const query of queries) {
    await visible(editor.getByText(query, { exact: true }));
  }

  await editor
    .getByRole('button', { name: 'Back to saved searches', exact: true })
    .click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await visible(page.getByTestId('jobs-run-detail'));

  return (await call(page, 'jobDiscovery', 'runs.list')).items[0].id;
}

async function checkProgressiveCandidates(page, id) {
  const state = await waitForRun(
    page,
    id,
    (value) =>
      value.status === 'running' &&
      value.counts.admitted === 2 &&
      value.counts.jdReady === 1 &&
      value.counts.matched === 1,
    'candidates resolve and extract while another query is pending',
  );
  await page
    .getByRole('button', { name: 'Refresh results', exact: true })
    .click();

  for (const candidate of state.candidates) {
    await visible(page.getByTestId(`jobs-candidate-${candidate.sourceId}`));
  }

  const verified = state.candidates.find(
    (candidate) => candidate.extraction.status === 'succeeded',
  );
  assert.ok(verified, 'No JD-ready candidate');
  const card = page.getByTestId(`jobs-candidate-${verified.sourceId}`);
  await card.getByText('Details', { exact: true }).click();
  await contains(card, CANONICAL_URL);
  await contains(card, LISTING_URL);
  await checkViewports(page, card.getByText('Details', { exact: true }));
  const terminal = await waitForRun(
    page,
    id,
    (value) => value.status !== 'running',
    'remaining discovery query completes',
  );
  assert.equal(terminal.status, 'partial');
  assert.ok(
    terminal.candidates.some(
      (candidate) => candidate.resolution.status === 'failed',
    ),
  );

  return verified.opportunityId;
}

async function reviewAndSave(page, opportunityId) {
  const { item } = await call(page, 'jobDiscovery', 'opportunities.get', {
    opportunityId,
  });
  await page.getByRole('tab', { name: 'Review', exact: true }).click();
  await page
    .getByRole('button', {
      name: `Review ${item.title} at ${item.company}`,
      exact: true,
    })
    .click();
  const detail = page.getByTestId('review-detail');
  await visible(
    detail.getByRole('heading', { name: 'Job description', exact: true }),
  );
  await visible(
    detail.getByRole('link', {
      name: `Open canonical posting: ${CANONICAL_URL}`,
      exact: true,
    }),
  );
  await detail.getByText('Verified posting text', { exact: true }).click();
  await contains(detail, 'Acme seeks a Software Intern');
  await detail.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(
    () => call(page, 'jobDiscovery', 'opportunities.get', { opportunityId }),
    (value) => value.item.decision === 'saved',
    'review Save decision persisted',
  );
}

async function applyOpportunity(page, opportunityId) {
  const detail = page.getByTestId('review-detail');
  await detail.getByRole('button', { name: 'Apply', exact: true }).click();
  const confirmation = page.getByRole('group', {
    name: 'Confirm application handoff',
    exact: true,
  });
  await contains(confirmation, 'does not submit an application');
  await checkViewports(
    page,
    confirmation.getByRole('button', {
      name: 'Confirm Pending application',
      exact: true,
    }),
  );
  await confirmation
    .getByRole('button', { name: 'Confirm Pending application', exact: true })
    .click();
  await visible(page.getByTestId('application-detail'));
  const { item } = await call(page, 'jobDiscovery', 'opportunities.get', {
    opportunityId,
  });
  const { item: application } = await call(page, 'applications', 'get', {
    id: item.applicationId,
  });
  assert.equal(application.application.currentStage.stageLabel, 'Pending');
  assert.equal(application.application.currentStage.stageKind, 'saved');
  assert.equal(application.snapshot?.source, 'web');

  return item.applicationId;
}

export async function jobsSmoke(harness, apply = false) {
  let session = await harness.launch({ env: FIXTURE_ENV });
  let runId;
  let opportunityId;
  let applicationId;

  await harness.step(
    'save and preview a search, then start discovery through the UI',
    async () => {
      await selectModel(session.page);
      runId = await saveSearch(session.page);
    },
  );

  await harness.step(
    'inspect progressively available candidate evidence and job description',
    async () => {
      opportunityId = await checkProgressiveCandidates(session.page, runId);
      await reviewAndSave(session.page, opportunityId);

      if (apply) {
        applicationId = await applyOpportunity(session.page, opportunityId);
      }
    },
  );

  await harness.step(
    'review decisions and handoff remain durable and idempotent',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({ profile, env: FIXTURE_ENV });
      const durable = await readRun(session.page, runId);
      assert.equal(durable.status, 'partial');
      assert.equal(durable.counts.jdReady, 1);
      const { item } = await call(
        session.page,
        'jobDiscovery',
        'opportunities.get',
        { opportunityId },
      );
      assert.equal(item.decision, 'saved');

      if (apply) {
        assert.equal(
          item.applicationId,
          applicationId,
          'Application link was lost on restart',
        );
        const again = await call(
          session.page,
          'jobDiscovery',
          'opportunities.apply',
          {
            opportunityId,
            confirmUnverified: false,
            withoutSnapshot: false,
            allowDuplicate: false,
          },
        );
        assert.equal(
          again.applicationId,
          applicationId,
          'Repeat Apply created a duplicate application',
        );
      }
    },
  );
}
