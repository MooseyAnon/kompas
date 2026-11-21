import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { call, request, selectModel, waitFor } from './harness.mjs';
import { writeDocx, writePdf } from './fixtures.mjs';
import { migrationSmoke } from './migration.mjs';
import { audioSmoke } from './media.mjs';
import { webSmoke } from './web.mjs';

const SAFE_DIAGNOSTIC_KEYS = new Set([
  'id',
  'operation',
  'status',
  'startedAt',
  'finishedAt',
  'durationMs',
  'firstTokenMs',
  'providerId',
  'modelId',
  'inputTokens',
  'outputTokens',
  'toolCalls',
  'errorCode',
]);

async function checkRendererBoundary(page) {
  const ping = await call(page, 'system', 'ping');
  assert.equal(ping.storageReady, true);
  const exposed = await page.evaluate(() =>
    ['require', 'process', 'ipcRenderer'].filter((name) => name in window),
  );
  assert.deepEqual(exposed, [], 'Renderer exposed privileged globals');

  for (const [module, action, payload, version, code] of [
    ['system', 'unknown', {}, 1, 'NOT_FOUND'],
    ['system', 'ping', {}, 999, 'VERSION_UNSUPPORTED'],
    [
      'identity',
      'profile.update',
      { patch: { displayName: 42 } },
      1,
      'INVALID_INPUT',
    ],
    ['inference', 'generate', {}, 1, 'NOT_FOUND'],
    ['inference', 'tools.execute', {}, 1, 'NOT_FOUND'],
  ]) {
    const result = await request(page, module, action, payload, version);
    assert.equal(result.ok, false, `${module}.${action} should be rejected`);
    assert.equal(result.error.code, code);
  }
}

async function checkWorker(page) {
  const status = await waitFor(
    () => call(page, 'inference', 'status.get'),
    (value) => value.worker.state === 'ready',
    'inference worker ready',
    { summarize: (value) => ({ state: value.worker.state }) },
  );
  assert.equal(status.worker.protocolVersion, 1);

  const generated = await call(page, 'inference', '__dev.selfTest');
  assert.equal(generated.status, 'completed');
  assert.equal(generated.output, 'echo:ping');

  const recovery = await call(page, 'inference', '__dev.crashRecover');
  assert.equal(recovery.crashedCode, 'RETRIES_EXHAUSTED');
  assert.equal(recovery.crashedLastCode, 'WORKER_EXITED');
  assert.equal(recovery.recoveredStatus, 'completed');
  assert.equal(recovery.workerStateAfter, 'ready');

  const tools = await call(page, 'inference', '__dev.toolSelfTest');
  assert.equal(tools.status, 'completed');
  assert.equal(tools.output, 'sum=5');
  assert.equal(tools.toolResults, 1);
  assert.equal(tools.deniedOutput, 'tool-denied');

  const { items } = await call(page, 'inference', 'diagnostics.list', {
    limit: 10,
  });

  for (const item of items) {
    assert.ok(
      Object.keys(item).every((key) => SAFE_DIAGNOSTIC_KEYS.has(key)),
      'Diagnostics exposed private fields',
    );
  }
}

async function importDraft(page) {
  const imported = await call(page, 'documents', 'import', { category: 'cv' });
  assert.equal(imported.cancelled, false);
  const document = imported.item;
  assert.ok(document.sizeBytes > 0);
  assert.equal('relativePath' in document || 'path' in document, false);
  await selectModel(page, 'mock-cv');
  const started = await call(page, 'cvImports', 'start', {
    documentId: document.id,
  });
  const { item } = await waitFor(
    () => call(page, 'cvImports', 'get', { importId: started.item.id }),
    (value) => value.item.status !== 'processing',
    'CV extraction completes',
    {
      summarize: (value) => ({
        status: value.item.status,
        errorCode: value.item.diagnostics.errorCode,
      }),
    },
  );
  assert.ok(
    item.status === 'ready' || item.status === 'partial',
    'CV extraction did not produce a reviewable draft',
  );
  assert.ok(item.draft?.modelProvenance, 'Model provenance missing');
  assert.equal(item.draft.profile.displayName.value, 'Smoke Tester');
  assert.equal(item.appliedStatus, 'not_applied');

  return { document, draft: item };
}

async function confirmDraft(page, draft) {
  const confirmation = {
    importId: draft.id,
    profile: {
      displayName: 'Reviewed Smoke Tester',
      location: 'Confirmed in smoke',
    },
    experiences: [
      {
        decision: 'add',
        value: { category: 'project', roleTitle: 'Reviewed PDF project' },
      },
    ],
  };
  const applied = await call(
    page,
    'identity',
    'profile.applyImport',
    confirmation,
  );
  assert.equal(applied.alreadyApplied, false);
  assert.equal(applied.experiences.length, 1);
  const repeated = await call(
    page,
    'identity',
    'profile.applyImport',
    confirmation,
  );
  assert.equal(repeated.alreadyApplied, true);
  assert.equal(repeated.experiences[0].id, applied.experiences[0].id);
}

async function checkStoredDraft(page, expected) {
  const { item } = await call(page, 'cvImports', 'get', {
    importId: expected.draft.id,
  });
  assert.ok(
    isDeepStrictEqual(item.draft, expected.draft.draft),
    'Review draft changed across restart',
  );
  const { profile } = await call(page, 'identity', 'profile.get');
  assert.equal(profile.displayName, 'Reviewed Smoke Tester');
  assert.equal(profile.location, 'Confirmed in smoke');
  const { items } = await call(page, 'cvImports', 'list');
  assert.ok(items.some((value) => value.id === item.id));
  assert.ok(
    items.every((value) => !('draft' in value)),
    'List exposed private drafts',
  );
  assert.equal(
    (await call(page, 'documents', 'open', { id: expected.document.id }))
      .opened,
    true,
  );
}

async function checkManagedFileRemoval(session, document, externalFile) {
  const originals = path.join(session.profile, 'documents', 'originals');
  assert.ok(fs.readdirSync(originals).length > 0, 'Managed document missing');
  await call(session.page, 'documents', 'remove', { id: document.id });
  assert.equal((await call(session.page, 'documents', 'list')).items.length, 0);
  assert.equal(
    fs.readdirSync(originals).length,
    0,
    'Managed file was not removed',
  );
  assert.ok(fs.existsSync(externalFile), 'External source was removed');
}

export async function coreSmoke(harness) {
  const directory = harness.temporaryDirectory('documents');
  const pdf = await writePdf(directory);
  let session = await harness.launch({ pickFile: pdf });
  let imported;

  await harness.step(
    'sandbox, validated IPC, real worker recovery and tool authorization',
    async () => {
      await checkRendererBoundary(session.page);
      await checkWorker(session.page);
    },
  );

  await harness.step('PDF draft requires explicit confirmation', async () => {
    const before = (await call(session.page, 'identity', 'profile.get'))
      .profile;
    imported = await importDraft(session.page);
    assert.ok(
      isDeepStrictEqual(
        (await call(session.page, 'identity', 'profile.get')).profile,
        before,
      ),
      'Import changed canonical identity before confirmation',
    );
    await confirmDraft(session.page, imported.draft);
  });

  await harness.step(
    'confirmed identity and managed files persist across relaunch',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({ profile, pickFile: pdf });
      await checkStoredDraft(session.page, imported);
      await checkManagedFileRemoval(session, imported.document, pdf);
    },
  );

  await harness.step(
    'DOCX extraction also produces an unconfirmed draft',
    async () => {
      const { profile } = session;
      await harness.stop(session);
      session = await harness.launch({
        profile,
        pickFile: await writeDocx(directory),
      });
      const before = (await call(session.page, 'identity', 'profile.get'))
        .profile;
      await importDraft(session.page);
      assert.ok(
        isDeepStrictEqual(
          (await call(session.page, 'identity', 'profile.get')).profile,
          before,
        ),
        'DOCX import changed canonical identity before confirmation',
      );
    },
  );

  await harness.step(
    'real packaged audio capture, playback and durable transcription',
    async () => {
      session = await audioSmoke(harness, session);
    },
  );
  await harness.step(
    'installed browser reads static and JS-rendered fixtures through IPC',
    () => webSmoke(harness, session),
  );
  await harness.step(
    'populated older database upgrades without data loss',
    () => migrationSmoke(harness),
  );
}
