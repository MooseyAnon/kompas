import { expect, it, vi } from 'vitest';
import { ImportPreviewService } from '../src/main/modules/applications/import-preview.service';
import { createApplicationsModule } from '../src/main/modules/applications/applications.module';
import {
  importPreviewOutput,
  manualCreateApplicationInput,
  type PageReadResult,
} from '../src/shared/contracts';
import { WebError } from '../src/main/modules/web/web.error';

const url = 'https://acme.example/jobs/software-intern';
const page: PageReadResult = {
  requestedUrl: url,
  url,
  status: 200,
  title: 'Software Intern - Acme',
  html: '<main>Job</main>',
  text: 'Acme seeks a Software Intern in London. Responsibilities: develop reliable software and collaborate with the team. Requirements include careful testing and effective communication across departments.',
  providerId: 'fixture',
  browserId: 'fixture',
  truncated: { html: false, text: false },
};
const field = (text: string, evidence = text) => ({ text, evidence });
const modelOutput = {
  schemaVersion: 1,
  classification: 'job_description',
  title: field('Software Intern'),
  company: field('Acme'),
  location: field('London'),
  responsibilities: [],
  requiredSkills: [],
  preferredSkills: [],
  educationRequirements: [],
  minimumYearsExperience: field('', ''),
  seniority: null,
  estimatedExperienceBand: null,
  employmentType: field('', ''),
  workArrangement: field('', ''),
  salaryText: field('', ''),
  inferences: [],
};
function setup(read: PageReadResult = page, output: unknown = modelOutput) {
  const web = { readPage: vi.fn(async () => read), search: vi.fn() };
  const inference = {
    getSettingsSnapshot: vi.fn(async () => ({
      settings: {
        providerId: 'ollama',
        modelId: 'local',
        generationTimeoutMs: 1000,
      },
      resolvedModel: {
        providerId: 'ollama',
        id: 'local',
        installed: true,
        locality: 'local',
        contextLength: 32000,
      },
    })),
    generate: vi.fn(async () => ({
      status: 'completed',
      output,
      toolCalls: [],
      providerId: 'ollama',
      modelId: 'local',
      requestId: crypto.randomUUID(),
    })),
  };
  return {
    service: new ImportPreviewService(web, inference as never),
    web,
    inference,
  };
}

it('returns grounded suggestions and an intact, manually confirmable snapshot without discovery writes', async () => {
  const { service, web, inference } = setup();
  const result = await service.preview({ url });
  expect(importPreviewOutput.parse(result)).toMatchObject({
    suppliedUrl: url,
    observedUrl: url,
    readSucceeded: true,
    extractionSucceeded: true,
    snapshotAvailable: true,
    companyName: 'Acme',
    roleTitle: 'Software Intern',
    location: 'London',
    reason: null,
  });
  expect(result.snapshot).toMatchObject({
    source: 'manual',
    sourceUrl: url,
    descriptionText: page.text,
  });
  expect(
    manualCreateApplicationInput.safeParse({
      companyName: 'Acme',
      roleTitle: 'Software Intern',
      snapshot: result.snapshot,
    }).success,
  ).toBe(true);
  expect(
    manualCreateApplicationInput.safeParse({
      companyName: 'Acme',
      roleTitle: 'Software Intern',
      snapshot: { ...result.snapshot, source: 'web' },
    }).success,
  ).toBe(false);
  expect(web.readPage).toHaveBeenCalledTimes(1);
  expect(web.search).not.toHaveBeenCalled();
  expect(inference.generate).toHaveBeenCalledTimes(1);
});

it('rejects invalid and private URLs before fetching', async () => {
  const { service, web } = setup();
  for (const invalid of [
    'file:///etc/passwd',
    'http://127.0.0.1/',
    'https://localhost/',
    'not-a-url',
  ])
    await expect(service.preview({ url: invalid })).rejects.toThrow();
  expect(web.readPage).not.toHaveBeenCalled();
});

it('retains manual fallback on blocked, redirected, truncated, generic or model-failed pages', async () => {
  const blocked = setup();
  blocked.web.readPage.mockRejectedValueOnce(new WebError('RATE_LIMITED'));
  expect(await blocked.service.preview({ url })).toMatchObject({
    readSucceeded: false,
    webError: 'RATE_LIMITED',
    suppliedUrl: url,
  });
  const changed = setup({ ...page, requestedUrl: 'https://other.example/' });
  expect(await changed.service.preview({ url })).toMatchObject({
    readSucceeded: false,
    snapshotAvailable: false,
  });
  for (const read of [
    { ...page, status: 403 },
    { ...page, truncated: { html: false, text: true } },
    { ...page, text: 'Careers at Acme' },
  ]) {
    const { service, inference } = setup(read);
    expect((await service.preview({ url })).snapshotAvailable).toBe(false);
    expect(inference.generate).not.toHaveBeenCalled();
  }
  const malformed = setup(page, { nonsense: true });
  expect(await malformed.service.preview({ url })).toMatchObject({
    extractionSucceeded: false,
    snapshotAvailable: true,
    reason: 'extraction_failed',
  });
  const ungrounded = setup(page, {
    ...modelOutput,
    company: field('Invented'),
  });
  expect(await ungrounded.service.preview({ url })).toMatchObject({
    extractionSucceeded: false,
    companyName: null,
  });
  const noModel = new ImportPreviewService({ readPage: async () => page });
  expect(await noModel.preview({ url })).toMatchObject({
    snapshotAvailable: true,
    reason: 'model_unavailable',
  });
});

it('refuses oversized original text rather than returning a partial snapshot', async () => {
  const { service } = setup({ ...page, text: page.text + 'é'.repeat(30000) });
  expect(await service.preview({ url })).toMatchObject({
    snapshotAvailable: false,
    snapshot: null,
    reason: 'snapshot_too_large',
  });
});

it('registers a validated Applications v1 command when Web is available', () => {
  const service = setup().service;
  const module = createApplicationsModule({} as never, service);
  expect(module.commands['imports.preview']).toBeDefined();
  expect(
    module.commands['imports.preview'].input.safeParse({ url, extra: true })
      .success,
  ).toBe(false);
});
