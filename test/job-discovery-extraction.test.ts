import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import {
  validateJdOutput,
  jdModelSchema,
  interpretJd,
  jdSource,
  type JdInference,
} from '../src/main/modules/job-discovery/jd-extraction';
import { normalizePage } from '../src/main/modules/web/page-normalizer';
import {
  jsonSchemaObjectSchema,
  newJobDiscoveryConfiguration,
  type GenerationResult,
  type PageReadResult,
} from '../src/shared/contracts';
import { createAppDispatcher } from '../src/main/core/registry';

const url = 'https://acme.example/jobs/intern-123';
const text =
  'Acme seeks a Software Intern in London. Responsibilities: develop reliable software. Requires TypeScript and 3+ years of professional experience. Python is a plus. Remote work. Salary £40,000.';
const page: PageReadResult = {
  requestedUrl: url,
  url,
  title: 'Software Intern - Acme',
  status: 200,
  html: '<main>Job</main>',
  text,
  providerId: 'fake',
  browserId: 'fake',
  truncated: { html: false, text: false },
};
const field = (value: string, evidence: string) => ({ text: value, evidence });
const output = () => ({
  schemaVersion: 1,
  classification: 'job_description',
  title: field('Software Intern', 'Software Intern - Acme'),
  company: field('Acme', 'Acme seeks'),
  location: field('London', 'in London'),
  responsibilities: [
    field('develop reliable software', 'develop reliable software'),
  ],
  requiredSkills: [
    field('TypeScript', 'Requires TypeScript'),
    field('Rust', 'Requires TypeScript'),
  ],
  preferredSkills: [field('Python', 'Python is a plus')],
  educationRequirements: [],
  minimumYearsExperience: field('3', '3+ years of professional experience'),
  seniority: {
    value: 'internship',
    evidence: 'Software Intern',
    reason: 'Intern is a role designation.',
  },
  estimatedExperienceBand: {
    value: '0-2',
    evidence: 'Software Intern',
    reason: 'Intern roles are often entry-level; estimate only.',
  },
  employmentType: field('', ''),
  workArrangement: field('Remote', 'Remote work'),
  salaryText: field('£40,000', 'Salary £40,000'),
  inferences: [],
});

let storage: Storage;
let dir: string;
afterEach(() => {
  storage?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(
  inference?: JdInference,
  verified = true,
  capturedPage = page,
) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-jd-'));
  storage = openStorage(dir);
  const repo = new DiscoveryRunsRepository(storage.db);
  const searches = new SavedSearchesService(
    new SavedSearchesRepository(storage.db),
  );
  const config = newJobDiscoveryConfiguration();
  config.name = 'Interns';
  config.intent.targetRoles = ['Software Intern'];
  const saved = searches.create({ config });
  const service = new DiscoveryRunsService(
    repo,
    searches,
    undefined,
    undefined,
    undefined,
    inference,
  );
  const run = service.start({ savedSearchId: saved.id });
  repo.observe(
    run.id,
    {
      provider: 'linkedin',
      key: '123',
      discoveredUrl: 'https://www.linkedin.com/jobs/view/123',
      collectionUrl: null,
      title: 'Software Intern',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date().toISOString(),
  );
  repo.finish(run.id, 'completed', new Date().toISOString());
  const candidate = service.candidates({ id: run.id })[0];
  const captureId = repo.capture(
    candidate,
    capturedPage,
    new Date().toISOString(),
  )!;
  if (verified)
    repo.resolutionResult(
      run.id,
      candidate.sourceId,
      'verified',
      { captureId, verifierVersion: 1 },
      url,
      new Date().toISOString(),
    );
  return {
    service,
    repo,
    runId: run.id,
    sourceId: candidate.sourceId,
    captureId,
  };
}

function model(
  reply: unknown = output(),
): JdInference & { generate: ReturnType<typeof vi.fn> } {
  return {
    getSettingsSnapshot: async () => ({
      settings: {
        mode: 'local_only',
        providerId: 'ollama',
        modelId: 'local',
        generationTimeoutMs: null,
        updatedAt: new Date().toISOString(),
      },
      resolvedModel: {
        providerId: 'ollama',
        id: 'local',
        displayName: 'Local',
        installed: true,
        locality: 'local',
        contextLength: 32_000,
      },
      warnings: [],
    }),
    generate: vi.fn(
      async () =>
        ({
          requestId: crypto.randomUUID(),
          providerId: 'ollama',
          modelId: 'local',
          status: 'completed',
          output: reply,
          toolCalls: [],
          usage: null,
        }) as GenerationResult,
    ),
  };
}

it('uses a nested schema, thinking-off, whole source and literal evidence for separately grounded skills', async () => {
  expect(jsonSchemaObjectSchema.safeParse(jdModelSchema).success).toBe(true);
  const inference = model();
  const { service, runId, sourceId, captureId } = fixture(inference);
  const [attempt] = await service.retryExtraction({ id: runId, sourceId });
  expect(attempt).toMatchObject({
    status: 'extracted',
    captureId,
    errorCode: null,
  });
  expect(attempt.jd?.requiredSkills.map((s) => s.text)).toEqual(['TypeScript']);
  expect(attempt.jd?.preferredSkills.map((s) => s.text)).toEqual(['Python']);
  expect(attempt.jd?.minimumYearsExperience?.value).toBe(3);
  expect(attempt.jd?.seniority?.evidence).toBe('Software Intern');
  expect(attempt.diagnostics).toContain('requiredSkills.1');
  const [request] = inference.generate.mock.calls[0];
  expect(request).toMatchObject({
    thinking: false,
    toolNames: [],
    responseFormat: { type: 'json_schema' },
  });
  expect(request.messages[1].content).toContain(text);
  expect(service.candidates({ id: runId })[0].resolutionStatus).toBe(
    'extracted',
  );
  expect(storage.db.pragma('foreign_key_check')).toEqual([]);
  expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(() =>
    storage.db
      .prepare('UPDATE job_jd_extractions SET diagnostics_json=? WHERE id=?')
      .run('[]', attempt.id),
  ).toThrow();
});

it('extracts from complete visible text when a long structured block is capped', async () => {
  const inference = model();
  const ending = 'END_OF_VISIBLE_JOB_DESCRIPTION';
  const fullText = `${text} ${'Additional details. '.repeat(130)} ${ending}`;
  const html = `<main><h1>${page.title}</h1><p>${fullText}</p></main>`;
  const capturedPage = {
    ...page,
    html,
    text: fullText,
    structured: normalizePage({ url, title: page.title, html }),
  };
  expect(capturedPage.structured.truncated).toBe(true);
  expect(
    capturedPage.structured.content.blocks.some(
      (block) => 'text' in block && block.text.includes(ending),
    ),
  ).toBe(false);
  const { service, repo, runId, sourceId } = fixture(
    inference,
    true,
    capturedPage,
  );
  expect(
    (await service.retryExtraction({ id: runId, sourceId }))[0],
  ).toMatchObject({
    status: 'extracted',
    errorCode: null,
  });
  expect(inference.generate.mock.calls[0][0].messages[1].content).toContain(
    ending,
  );
  expect(repo.verifiedCapture(runId, sourceId)?.rawReadPage).toEqual(
    capturedPage,
  );
  for (const truncated of [
    { html: true, text: false },
    { html: false, text: true },
  ]) {
    expect(() => jdSource({ ...capturedPage, truncated })).toThrow(
      'RESOURCE_LIMIT',
    );
  }
});

it('honours a longer global target without exceeding Discovery’s remaining budget', async () => {
  const inference = model();
  const original = inference.getSettingsSnapshot;
  inference.getSettingsSnapshot = async () => {
    const snapshot = await original();
    return {
      ...snapshot,
      settings: { ...snapshot.settings, generationTimeoutMs: 900_000 },
    };
  };
  const signal = new AbortController().signal;

  const extended = await interpretJd(page, inference, signal, 1_200_000);
  expect(extended.provenance.timeoutMs).toBe(1_200_000);
  expect(inference.generate.mock.calls[0][0].limits.timeoutMs).toBe(1_200_000);

  const bounded = await interpretJd(page, inference, signal, 4_000);
  expect(bounded.provenance.timeoutMs).toBe(4_000);
  expect(inference.generate.mock.calls[1][0].limits.timeoutMs).toBe(4_000);
});

it('sanitizes malformed fields, unsupported salary and inferred years without failing the overall document', () => {
  const raw = {
    ...output(),
    salaryText: { text: '£90,000', evidence: 'Salary £40,000' },
    minimumYearsExperience: field('8', 'Software Intern'),
    requiredSkills: [null, field('TypeScript', 'Requires TypeScript')],
  };
  const { jd, diagnostics } = validateJdOutput(raw, `${page.title}\n${text}`);
  expect(jd.salaryText).toBeNull();
  expect(jd.minimumYearsExperience).toBeNull();
  expect(jd.requiredSkills.map((s) => s.text)).toEqual(['TypeScript']);
  expect(diagnostics).toEqual(
    expect.arrayContaining(['salaryText', 'minimumYearsExperience']),
  );
});

it('retains original capture on invalid JSON and retries from the same capture without fetching', async () => {
  const inference = model('{not JSON');
  const { service, runId, sourceId, captureId, repo } = fixture(inference);
  expect(
    (await service.retryExtraction({ id: runId, sourceId }))[0].errorCode,
  ).toBe('INVALID_SCHEMA');
  expect(repo.verifiedCapture(runId, sourceId)?.id).toBe(captureId);
  inference.generate.mockImplementation(async () => ({
    requestId: crypto.randomUUID(),
    providerId: 'ollama',
    modelId: 'local',
    status: 'completed',
    output: output(),
    toolCalls: [],
    usage: null,
  }));
  const attempts = await service.retryExtraction({ id: runId, sourceId });
  expect(attempts.map((item) => item.status)).toEqual(['extracted', 'failed']);
  await expect(
    service.retryExtraction({ id: runId, sourceId }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(
    storage.db
      .prepare('SELECT count(*) AS n FROM job_opportunity_captures')
      .get(),
  ).toEqual({ n: 1 });
  storage.close();
  storage = openStorage(dir);
  const reopened = new DiscoveryRunsRepository(storage.db);
  expect(
    reopened.extractions(runId, sourceId)?.map((item) => item.status),
  ).toEqual(['extracted', 'failed']);
});

it('records a model outage as retryable without inventing an extraction', async () => {
  const inference = model();
  inference.generate.mockRejectedValueOnce(new Error('provider unavailable'));
  const { service, runId, sourceId } = fixture(inference);
  const [first] = await service.retryExtraction({ id: runId, sourceId });
  expect(first).toMatchObject({
    status: 'failed',
    errorCode: 'MODEL_FAILED',
    jd: null,
  });
  expect(
    (await service.retryExtraction({ id: runId, sourceId }))[0].status,
  ).toBe('extracted');
  expect(inference.generate).toHaveBeenCalledTimes(2);
});

it('refuses a verified page that cannot fit the model context without shortening the original', async () => {
  const inference = model();
  const longPage = {
    ...page,
    text: `${text} ${'Responsibilities and requirements. '.repeat(800)}`,
  };
  const { service, repo, runId, sourceId } = fixture(inference, true, longPage);
  expect(
    (await service.retryExtraction({ id: runId, sourceId }))[0],
  ).toMatchObject({ status: 'failed', errorCode: 'RESOURCE_LIMIT' });
  expect(inference.generate).not.toHaveBeenCalled();
  expect(repo.verifiedCapture(runId, sourceId)?.rawReadPage.text).toBe(
    longPage.text,
  );
});

it('rejects unverified and collection/login pages, with no model invocation', async () => {
  const inference = model();
  const { service, runId, sourceId } = fixture(inference, false);
  await expect(
    service.retryExtraction({ id: runId, sourceId }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(inference.generate).not.toHaveBeenCalled();
  expect(() =>
    validateJdOutput({ ...output(), classification: 'unknown' }, text),
  ).toThrow('NOT_JOB_DESCRIPTION');
});

it('validates scoped IPC requests and refuses a login page even if a stored link claims verification', async () => {
  const inference = model();
  const { runId, sourceId, repo } = fixture(inference, true, {
    ...page,
    title: 'Sign in',
    text: 'Please log in',
  });
  const service = new DiscoveryRunsService(
    repo,
    new SavedSearchesService(new SavedSearchesRepository(storage.db)),
    undefined,
    undefined,
    undefined,
    inference,
  );
  expect(
    (await service.retryExtraction({ id: runId, sourceId }))[0].errorCode,
  ).toBe('NOT_JOB_DESCRIPTION');
  expect(inference.generate).not.toHaveBeenCalled();
  const dispatcher = createAppDispatcher({
    getAppVersion: () => 'test',
    isStorageReady: () => true,
    storage,
  });
  const send = (action: string, payload: unknown) =>
    dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'jobDiscovery',
      version: 1,
      action,
      payload,
    });
  expect(await send('runs.extractions', { id: runId, sourceId })).toMatchObject(
    { ok: true, data: { items: [{ errorCode: 'NOT_JOB_DESCRIPTION' }] } },
  );
  expect(
    await send('runs.extractions', {
      id: runId,
      sourceId: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(
    await send('runs.retryExtraction', { id: runId, sourceId, url }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await send('runs.extract', { id: crypto.randomUUID() })).toMatchObject(
    { ok: false, error: { code: 'NOT_FOUND' } },
  );
});

it('enforces one active model call and the frozen deadline', async () => {
  let release!: (value: GenerationResult) => void;
  const inference = model();
  inference.generate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { service, runId, sourceId } = fixture(inference);
  const first = service.retryExtraction({ id: runId, sourceId });
  await vi.waitFor(() => expect(inference.generate).toHaveBeenCalledTimes(1));
  await expect(
    service.retryExtraction({ id: runId, sourceId }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  release({
    requestId: crypto.randomUUID(),
    providerId: 'ollama',
    modelId: 'local',
    status: 'completed',
    output: output(),
    toolCalls: [],
    usage: null,
  });
  expect((await first)[0].status).toBe('extracted');
  storage.db
    .prepare('UPDATE job_discovery_runs SET started_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z', runId);
  await expect(service.extract({ id: runId })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});
