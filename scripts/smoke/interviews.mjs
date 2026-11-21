import assert from 'node:assert/strict';
import {
  call,
  checkViewports,
  openDestination,
  selectModel,
  visible,
  waitFor,
} from './harness.mjs';

const QUICK_FIRE_QUESTIONS = 5;

function readState(page, sessionId) {
  return call(page, 'interviews', 'workflow.state.get', { sessionId }).then(
    (value) => value.state,
  );
}

function waitForState(page, sessionId, accept, label) {
  return waitFor(() => readState(page, sessionId), accept, label, {
    summarize: (state) => ({
      status: state.session.status,
      phase: state.session.phase,
      operationStatus: state.progress.operationStatus,
      actions: state.availableActions,
    }),
  });
}

async function startPractice(page, method, subject) {
  await page.getByTestId(`method-choice-${method}`).check();
  await page
    .getByRole('textbox', { name: 'Subject', exact: true })
    .fill(subject);

  if (method === 'quick_fire') {
    await page
      .getByLabel('Questions', { exact: true })
      .selectOption(String(QUICK_FIRE_QUESTIONS));
  }

  await page.getByTestId('prepare-start').click();
  const { items } = await call(page, 'interviews', 'sessions.list');

  return items.find((item) => item.subject === subject).id;
}

async function submitAnswer(page, id, text) {
  const before = await waitForState(
    page,
    id,
    (state) =>
      !!state.currentQuestion && state.availableActions.includes('answer'),
    'answerable question',
  );
  // Backend publication precedes the renderer's next polling snapshot.
  await visible(
    page.getByText(before.currentQuestion.question, { exact: true }),
  );
  await page
    .getByRole('textbox', { name: 'Your answer', exact: true })
    .fill(text);
  await page
    .getByRole('button', { name: 'Submit answer', exact: true })
    .click();
  await waitFor(
    () => call(page, 'interviews', 'sessions.transcript', { sessionId: id }),
    (value) =>
      value.items.some((item) => item.type === 'answer' && item.text === text),
    'answer persisted',
    {
      summarize: (value) => ({
        savedAnswers: value.items.filter((item) => item.type === 'answer')
          .length,
      }),
    },
  );
}

async function quickFireJourney(harness, page) {
  const id = await startPractice(
    page,
    'quick_fire',
    'Packaged support operations',
  );
  await visible(page.getByTestId('session-failed'));
  await visible(
    page.getByRole('button', { name: 'Open Local AI settings', exact: true }),
  );
  const failed = await readState(page, id);
  assert.equal(failed.progress.operationStatus, 'failed');
  assert.equal(failed.operationId, null);
  await selectModel(page, 'mock-slow');
  await page.getByTestId('session-retry').click();
  await visible(page.getByTestId('session-preparing'));

  await harness.step(
    'pause and explicitly resume the current interview',
    async () => {
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await visible(page.getByTestId('session-paused'));
      await selectModel(page);
      await page
        .getByRole('button', { name: 'Resume interview', exact: true })
        .click();
      await visible(page.getByTestId('session-question'));
    },
  );

  await checkViewports(
    page,
    page.getByRole('textbox', { name: 'Your answer', exact: true }),
  );

  for (let index = 0; index < QUICK_FIRE_QUESTIONS; index++) {
    await submitAnswer(
      page,
      id,
      `Answer ${index}: I triage by urgency, explain my reasoning, document the resolution and verify the outcome.`,
    );
  }

  await page
    .getByRole('button', { name: 'Get my results', exact: true })
    .click();
  await visible(page.getByTestId('quick-fire-results'));
  const state = await readState(page, id);
  assert.equal(state.session.status, 'completed');
  assert.equal(state.result.reviewedCount, QUICK_FIRE_QUESTIONS);
  assert.equal(state.result.totalRounds, QUICK_FIRE_QUESTIONS);

  return id;
}

async function deepLoopJourney(page) {
  await page.getByTestId('interviews-session-back').click();
  const id = await startPractice(
    page,
    'deep_loop',
    'Packaged relational database design',
  );
  await submitAnswer(
    page,
    id,
    'I would normalize the schema and index foreign keys, measuring read and write trade-offs.',
  );
  await submitAnswer(
    page,
    id,
    'For example I would compare query plans and measure representative workload latency before changing indexes.',
  );
  await waitForState(
    page,
    id,
    (state) => state.availableActions.includes('request_coaching'),
    'review completes and coaching becomes available',
  );
  await page
    .getByRole('button', { name: 'Request coaching', exact: true })
    .click();
  await waitForState(
    page,
    id,
    (state) => state.availableActions.includes('request_reassessment'),
    'explicit coaching completed',
  );
  await page
    .getByRole('button', { name: 'Try reassessment', exact: true })
    .click();
  const reassessment = await waitForState(
    page,
    id,
    (state) => state.availableActions.includes('answer'),
    'linked reassessment question',
  );
  assert.ok(reassessment.currentQuestion);
  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await page
    .getByRole('group', {
      name: 'Abandon this interview? It can’t be resumed.',
      exact: true,
    })
    .getByRole('button', { name: 'Abandon', exact: true })
    .click();
  const ended = await waitForState(
    page,
    id,
    (state) => state.session.status === 'abandoned',
    'explicit abandonment',
  );
  assert.equal(ended.availableActions.includes('continue'), false);
}

export async function interviewsSmoke(harness) {
  let session = await harness.launch();
  let completedId;

  await harness.step(
    'missing-model failure is recoverable; Quick-fire answers publish on request',
    async () => {
      await openDestination(session.page, 'interviews');
      completedId = await quickFireJourney(harness, session.page);
    },
  );

  await harness.step(
    'Deep Loop reviews answers and offers explicit coaching and reassessment',
    () => deepLoopJourney(session.page),
  );

  await harness.step(
    'published results remain readable after relaunch',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({ profile });
      const state = await readState(session.page, completedId);
      assert.equal(state.session.status, 'completed');
      assert.equal(state.result.reviewedCount, QUICK_FIRE_QUESTIONS);
      await openDestination(session.page, 'interviews');
      await session.page
        .getByRole('tab', { name: 'History', exact: true })
        .click();
      await visible(
        session.page.getByRole('list', {
          name: 'Practice sessions',
          exact: true,
        }),
      );
    },
  );
}
