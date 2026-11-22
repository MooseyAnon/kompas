import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { createJobDiscoveryModule } from '../src/main/modules/job-discovery/job-discovery.module';
import { createAppDispatcher } from '../src/main/core/registry';
import type { WebService } from '../src/main/modules/web/web.service';
import { WebError } from '../src/main/modules/web/web.error';
import type { JdInference } from '../src/main/modules/job-discovery/jd-extraction';
import {
  newJobDiscoveryConfiguration,
  type GenerationResult,
  type PageReadResult,
  type WebSearchOutput,
} from '../src/shared/contracts';

const listing = 'https://uk.linkedin.com/jobs/view/software-intern-1234567';
const collection = 'https://uk.linkedin.com/jobs/search/';
const canonical = 'https://boards.greenhouse.io/acme/jobs/3456789';
const description =
  'Acme seeks a Software Intern in London. Responsibilities include developing software, testing TypeScript applications and collaborating with colleagues. Requirements include TypeScript and clear communication with the engineering team.';
const jobPage: PageReadResult = {
  requestedUrl: canonical,
  url: canonical,
  title: 'Software Intern - Acme',
  status: 200,
  html: `<main><h1>Software Intern - Acme</h1><p>${description}</p></main>`,
  text: description,
  providerId: 'fake',
  browserId: 'fake',
  truncated: { html: false, text: false },
};
const collectionPage: PageReadResult = {
  ...jobPage,
  requestedUrl: collection,
  url: collection,
  title: 'Jobs',
  text: '',
  html: '',
  structured: {
    schemaVersion: 1,
    url: collection,
    title: 'Jobs',
    scripts: [],
    stylesheets: [],
    truncated: false,
    content: {
      blocks: [
        {
          type: 'list',
          ordered: false,
          items: [
            {
              text: 'Software Intern Acme London 1 day ago',
              links: [
                { text: 'Software Intern', href: listing },
                { text: 'Acme', href: 'https://www.linkedin.com/company/acme' },
              ],
            },
          ],
        },
      ],
    },
  },
};
const hit = (url: string) => ({ title: 'Software Intern', url, rank: 1 });
const result = (url?: string): WebSearchOutput => ({
  providerId: 'fake',
  results: url ? [hit(url)] : [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let storage: Storage;
let dir: string;
afterEach(() => {
  storage?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(
  web: {
    search: (
      query: string,
      options?: { signal?: AbortSignal },
    ) => Promise<WebSearchOutput>;
    readPage: (
      url: string,
      options?: { signal?: AbortSignal },
    ) => Promise<PageReadResult>;
  },
  inference?: JdInference,
  configure: (
    config: ReturnType<typeof newJobDiscoveryConfiguration>,
  ) => void = () => {},
  clock?: () => Date,
) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-workflow-'));
  storage = openStorage(dir);
  const repo = new DiscoveryRunsRepository(storage.db);
  const searches = new SavedSearchesService(
    new SavedSearchesRepository(storage.db),
  );
  const config = newJobDiscoveryConfiguration();
  config.name = 'Internships';
  config.intent.targetRoles = [
    'Software Intern',
    'Developer Intern',
    'Data Intern',
  ];
  configure(config);
  const saved = searches.create({ config });
  const service = new DiscoveryRunsService(
    repo,
    searches,
    clock,
    web,
    undefined,
    inference,
    {
      listConfirmedSkills: () => [],
      getProfile: () => ({ location: 'London' }),
    },
  );
  const run = service.start({ savedSearchId: saved.id });
  return { service, repo, saved, run };
}

function model() {
  const generate = vi.fn(
    async () =>
      ({
        requestId: crypto.randomUUID(),
        providerId: 'ollama',
        modelId: 'local',
        status: 'completed',
        toolCalls: [],
        usage: null,
        output: {
          schemaVersion: 1,
          classification: 'job_description',
          title: null,
          company: null,
          location: null,
          responsibilities: [],
          requiredSkills: [{ text: 'TypeScript', evidence: 'TypeScript' }],
          preferredSkills: [],
          educationRequirements: [],
          minimumYearsExperience: null,
          seniority: null,
          estimatedExperienceBand: null,
          employmentType: null,
          workArrangement: null,
          salaryText: null,
          inferences: [],
        },
      }) as GenerationResult,
  );
  const inference: JdInference = {
    getModelDetails: async () => ({
      maxContextTokens: 32_000,
      configuredContextTokens: null,
      supportsContextOverride: true,
    }),
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
    generate,
  };
  return { inference, generate };
}

it('acknowledges once and reaches verified JD and an honest unscored match before later broad search settles', async () => {
  const later = deferred<WebSearchOutput>();
  const searchCalls: string[] = [];
  const reads: string[] = [];
  let active = 0;
  let peak = 0;
  let laterWaiting = false;
  let readDuringWait = false;
  const { inference, generate } = model();
  const { service, run } = setup(
    {
      search: async (query) => {
        searchCalls.push(query);
        active++;
        peak = Math.max(peak, active);
        try {
          if (query.includes('Acme')) return result(canonical);
          if (query.includes('Developer Intern')) {
            laterWaiting = true;
            return await later.promise;
          }
          return result(collection);
        } finally {
          active--;
        }
      },
      readPage: async (url) => {
        reads.push(url);
        active++;
        peak = Math.max(peak, active);
        readDuringWait ||= laterWaiting;
        try {
          return url === collection ? collectionPage : jobPage;
        } finally {
          active--;
        }
      },
    },
    inference,
  );
  const command = createJobDiscoveryModule(
    new SavedSearchesService(new SavedSearchesRepository(storage.db)),
    service,
  ).commands['runs.workflow.execute'];
  expect(command).toBeDefined();
  expect(command!.input.safeParse({ id: run.id }).success).toBe(true);
  expect(command!.input.safeParse({ id: run.id, url: canonical }).success).toBe(
    false,
  );
  expect(service.executeWorkflow({ id: run.id })).toEqual({ accepted: true });
  expect(service.executeWorkflow({ id: run.id })).toEqual({ accepted: true });
  await vi.waitFor(() =>
    expect(searchCalls.some((q) => q.includes('Developer Intern'))).toBe(true),
  );
  await vi.waitFor(() =>
    expect(service.matches({ id: run.id })[0]).toMatchObject({
      status: 'unscored',
      reason: 'NO_CONFIRMED_SKILLS',
      coverage: null,
    }),
  );
  expect(service.get({ id: run.id }).status).toBe('running');
  const candidate = service.candidates({ id: run.id })[0];
  expect(candidate.canonicalUrl).toBe(canonical);
  expect(
    service.extractions({ id: run.id, sourceId: candidate.sourceId })[0].status,
  ).toBe('extracted');
  expect(reads).toContain(canonical); // A page read progressed while broad search was pending.
  expect(readDuringWait).toBe(true);
  expect(peak).toBeLessThanOrEqual(
    run.configSnapshot.run.maxConcurrentWebOperations,
  );
  expect(
    searchCalls.indexOf(searchCalls.find((q) => q.includes('Acme'))!),
  ).toBeLessThan(
    searchCalls.indexOf(
      searchCalls.find((q) => q.includes('Developer Intern'))!,
    ),
  );
  expect(generate).toHaveBeenCalledTimes(1);
  later.resolve(result());
  await vi.waitFor(() =>
    expect(service.get({ id: run.id }).status).toBe('completed'),
  );
  expect(service.get({ id: run.id }).stats).toMatchObject({
    targetedSearches: 1,
    targetedPagesRead: 1,
    extractions: 1,
  });
});

it('finishes with a deadline failure when a late search cannot supply evidence', async () => {
  let time = Date.now();
  const { service, run } = setup(
    {
      search: async () => {
        time += 200;
        return result(collection);
      },
      readPage: async () => {
        throw new Error('deadline must prevent reading');
      },
    },
    undefined,
    (config) => {
      config.run.deadlineMs = 100;
    },
    () => new Date(time),
  );
  service.executeWorkflow({ id: run.id });
  await vi.waitFor(() =>
    expect(service.get({ id: run.id }).status).toBe('failed'),
  );
  expect(
    service.get({ id: run.id }).diagnostics.map((item) => item.code),
  ).toContain('DEADLINE_REACHED');
  expect(service.get({ id: run.id }).stats.newCandidates).toBe(0);
});

it('treats a successful empty search as completed, with no invented opportunity', async () => {
  const { service, run } = setup(
    {
      search: async () => result(),
      readPage: async () => {
        throw new Error('unexpected page read');
      },
    },
    undefined,
    (config) => {
      config.query.maxQueries = 1;
    },
  );
  service.executeWorkflow({ id: run.id });
  await vi.waitFor(() =>
    expect(service.get({ id: run.id }).status).toBe('completed'),
  );
  expect(service.get({ id: run.id }).stats.newCandidates).toBe(0);
  expect(service.candidates({ id: run.id })).toEqual([]);
});

it('respects a frozen one-Web-operation ceiling across search and page reads', async () => {
  const { inference } = model();
  let active = 0;
  let peak = 0;
  const withinWeb = async <T>(work: () => Promise<T>): Promise<T> => {
    active++;
    peak = Math.max(peak, active);
    try {
      return await work();
    } finally {
      active--;
    }
  };
  const { service, run } = setup(
    {
      search: (query) =>
        withinWeb(async () =>
          result(query.includes('Acme') ? canonical : collection),
        ),
      readPage: (url) =>
        withinWeb(async () => (url === collection ? collectionPage : jobPage)),
    },
    inference,
    (config) => {
      config.query.maxQueries = 1;
      config.run.maxConcurrentWebOperations = 1;
    },
  );
  service.executeWorkflow({ id: run.id });
  await vi.waitFor(() =>
    expect(service.get({ id: run.id }).status).toBe('completed'),
  );
  expect(peak).toBe(1);
  expect(service.matches({ id: run.id })).toHaveLength(1);
});

it('validates and acknowledges the registered IPC action before a pending search completes', async () => {
  const pending = deferred<WebSearchOutput>();
  const web = {
    search: vi.fn(async () => pending.promise),
    readPage: async () => jobPage,
  };
  const { run } = setup(web);
  const dispatcher = createAppDispatcher({
    getAppVersion: () => 'test',
    isStorageReady: () => true,
    storage,
    web: web as unknown as WebService,
  });
  const send = (action: string, payload: unknown) =>
    dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'jobDiscovery',
      version: 1,
      action,
      payload,
    });
  expect(
    await send('runs.workflow.execute', { id: run.id, url: canonical }),
  ).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  });
  expect(await send('runs.workflow.execute', { id: run.id })).toMatchObject({
    ok: true,
    data: { accepted: true },
  });
  expect(await send('runs.workflow.execute', { id: run.id })).toMatchObject({
    ok: true,
    data: { accepted: true },
  });
  expect(await send('runs.get', { id: run.id })).toMatchObject({
    ok: true,
    data: { item: { status: 'running' } },
  });
  expect(web.search).toHaveBeenCalledTimes(1);
  expect(await send('runs.resolve', { id: run.id })).toMatchObject({
    ok: false,
    error: { code: 'CONFLICT' },
  });
  expect(await send('runs.cancel', { id: run.id })).toMatchObject({
    ok: true,
    data: { item: { status: 'cancelled' } },
  });
  pending.resolve(result());
  await vi.waitFor(() => expect(web.search).toHaveBeenCalledTimes(1));
  // The detached coordinator must settle before this test closes its SQLite handle.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it('polls validated state without starting any work and distinguishes queued search from JD-ready', async () => {
  const later = deferred<WebSearchOutput>();
  const { inference, generate } = model();
  const web = {
    search: vi.fn(async (query: string) =>
      query.includes('Developer Intern')
        ? later.promise
        : result(query.includes('Acme') ? canonical : collection),
    ),
    readPage: vi.fn(async (url: string) =>
      url === collection ? collectionPage : jobPage,
    ),
    searchProgress: vi.fn(() => ({
      queueLength: 1,
      position: null,
      state: 'waiting' as const,
      waitingMs: 40,
      nextEligibleAt: null,
    })),
  };
  const { service, run } = setup(web, inference);
  const dispatcher = createAppDispatcher({
    getAppVersion: () => 'test',
    isStorageReady: () => true,
    storage,
    web: web as unknown as WebService,
  });
  const state = async () =>
    dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'jobDiscovery',
      version: 1,
      action: 'runs.workflow.state.get',
      payload: { id: run.id },
    });
  expect((await state()).ok).toBe(true);
  expect(
    await dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'jobDiscovery',
      version: 1,
      action: 'runs.workflow.state.get',
      payload: { id: run.id, url: canonical },
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  for (let n = 0; n < 3; n++) await state();
  expect(web.search).not.toHaveBeenCalled();
  expect(web.readPage).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(service.matches({ id: run.id })).toEqual([]);
  service.executeWorkflow({ id: run.id });
  await vi.waitFor(() =>
    expect(service.workflowState({ id: run.id }).counts.jdReady).toBe(1),
  );
  const snapshot = service.workflowState({ id: run.id });
  expect(snapshot).toMatchObject({
    status: 'running',
    workActive: true,
    counts: { admitted: 1, verified: 1, jdReady: 1, matched: 1, failed: 0 },
    discovery: { search: { state: 'waiting', position: null } },
    candidates: [
      {
        extraction: { status: 'succeeded' },
        match: { reason: 'NO_CONFIRMED_SKILLS', freshness: 'unknown_skills' },
      },
    ],
  });
  expect(Object.values(snapshot.milestones).every(Boolean)).toBe(true);
  expect(await state()).toMatchObject({
    ok: true,
    data: { state: { counts: { jdReady: 1 } } },
  });
  const before = [
    web.search.mock.calls.length,
    web.readPage.mock.calls.length,
    generate.mock.calls.length,
  ];
  for (let n = 0; n < 5; n++) await state();
  expect([
    web.search.mock.calls.length,
    web.readPage.mock.calls.length,
    generate.mock.calls.length,
  ]).toEqual(before);
  later.resolve(result());
  await vi.waitFor(() => expect(service.isActive()).toBe(false));
  expect(service.workflowState({ id: run.id }).discovery.submitted).toBeNull();
});

it('reconciles a claimed resolution without calling it no_match, retaining the exhausted attempt', async () => {
  const web = {
    search: vi.fn(async () => result()),
    readPage: vi.fn(async () => jobPage),
  };
  const { service, repo, saved, run } = setup(web, undefined, (config) => {
    config.run.maxTransientRetries = 0;
    config.query.maxQueries = 1;
  });
  const observed = repo.observe(
    run.id,
    {
      provider: 'linkedin',
      key: '1234567',
      discoveredUrl: listing,
      collectionUrl: collection,
      title: 'Software Intern',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date().toISOString(),
  )!;
  repo.claimResolution(run.id, observed.sourceId);
  const claimed = service.resolutionDiagnostics({
    id: run.id,
    sourceId: observed.sourceId,
  });
  expect(claimed.attempts).toMatchObject([{ status: 'running', searches: [] }]);
  expect(
    service.workflowState({ id: run.id }).candidates[0].resolution,
  ).toMatchObject({ status: 'pending', attempts: 1, retryAvailable: false });
  storage.close();
  storage = openStorage(dir);
  const recoveredRepo = new DiscoveryRunsRepository(storage.db);
  const recovered = new DiscoveryRunsService(
    recoveredRepo,
    new SavedSearchesService(new SavedSearchesRepository(storage.db)),
    undefined,
    web,
  );
  expect(recovered.workflowState({ id: run.id })).toMatchObject({
    status: 'interrupted',
    workActive: false,
    candidates: [
      {
        resolution: {
          status: 'interrupted',
          reason: 'INTERRUPTED',
          attempts: 1,
          retryAvailable: false,
        },
      },
    ],
  });
  expect(
    recovered.resolutionDiagnostics({ id: run.id, sourceId: observed.sourceId })
      .attempts,
  ).toMatchObject([{ status: 'interrupted', reason: null, searches: [] }]);
  expect(
    recoveredRepo.admitted(run.id, observed.sourceId)?.resolutionReason,
  ).toBeNull();
  for (let n = 0; n < 3; n++) recovered.workflowState({ id: run.id });
  expect(web.search).not.toHaveBeenCalled();
  const next = recovered.start({ savedSearchId: saved.id });
  recovered.executeWorkflow({ id: next.id });
  await vi.waitFor(() =>
    expect(recovered.get({ id: next.id }).status).toBe('completed'),
  );
  expect(recovered.candidates({ id: next.id })).toEqual([]);
  expect(web.search).toHaveBeenCalledTimes(1); // Only the new user-started run searched.
});

it('reconciles a claimed attempt with a remaining retry through a new run', async () => {
  const web = {
    search: vi.fn(async (query: string) =>
      result(query.includes('Acme') ? canonical : collection),
    ),
    readPage: vi.fn(async (url: string) =>
      url === collection ? collectionPage : jobPage,
    ),
  };
  const { repo, saved, run } = setup(web, model().inference, (config) => {
    config.query.maxQueries = 1;
  });
  const observed = repo.observe(
    run.id,
    {
      provider: 'linkedin',
      key: '1234567',
      discoveredUrl: listing,
      collectionUrl: collection,
      title: 'Software Intern',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date().toISOString(),
  )!;
  repo.claimResolution(run.id, observed.sourceId);
  storage.close();
  storage = openStorage(dir);
  const reopened = new DiscoveryRunsService(
    new DiscoveryRunsRepository(storage.db),
    new SavedSearchesService(new SavedSearchesRepository(storage.db)),
    undefined,
    web,
    undefined,
    model().inference,
  );
  const next = reopened.start({ savedSearchId: saved.id });
  reopened.executeWorkflow({ id: next.id });
  await vi.waitFor(() =>
    expect(reopened.get({ id: next.id }).status).toBe('completed'),
  );
  expect(reopened.candidates({ id: next.id })[0]).toMatchObject({
    id: observed.id,
    resolutionAttempts: 2,
    canonicalUrl: canonical,
  });
  expect(
    reopened.resolutionDiagnostics({
      id: next.id,
      sourceId: observed.sourceId,
    }),
  ).toMatchObject({
    totalAttempts: 2,
    attempts: [
      { runId: run.id, sequence: 1, status: 'interrupted' },
      { runId: next.id, sequence: 2, status: 'completed', reason: 'verified' },
    ],
  });
  expect(reopened.workflowState({ id: next.id }).counts.jdReady).toBe(1);
});

it('cancels a claimed resolution before a late page response can become a canonical match', async () => {
  const late = deferred<PageReadResult>();
  const web = {
    search: vi.fn(async (query: string) =>
      result(query.includes('Acme') ? canonical : collection),
    ),
    readPage: vi.fn(async (url: string) =>
      url === collection ? collectionPage : late.promise,
    ),
  };
  const { service, run } = setup(web, undefined, (config) => {
    config.query.maxQueries = 1;
  });
  service.executeWorkflow({ id: run.id });
  await vi.waitFor(() =>
    expect(web.readPage).toHaveBeenCalledWith(canonical, expect.anything()),
  );
  const during = service.workflowState({ id: run.id });
  expect(during.candidates[0].resolution).toMatchObject({
    status: 'active',
    attempts: 1,
    retryAvailable: false,
  });
  service.cancel({ id: run.id });
  const cancelled = service.resolutionDiagnostics({
    id: run.id,
    sourceId: during.candidates[0].sourceId,
  });
  expect(cancelled.attempts[0]).toMatchObject({
    status: 'cancelled',
    reason: null,
    searches: [
      { status: 'completed', results: [{ disposition: 'interrupted' }] },
    ],
  });
  expect(
    service.workflowState({ id: run.id }).candidates[0].resolution,
  ).toMatchObject({
    status: 'skipped',
    reason: 'cancelled',
    retryAvailable: false,
  });
  late.resolve(jobPage);
  await vi.waitFor(() => expect(service.isActive()).toBe(false));
  expect(
    service.workflowState({ id: run.id }).candidates[0].resolution
      .retryAvailable,
  ).toBe(true);
  expect(service.workflowState({ id: run.id }).counts.verified).toBe(0);
  expect(
    service.captures({ id: run.id, sourceId: during.candidates[0].sourceId }),
  ).toEqual([]);
});

it('cancels late search output without admitting or modifying a candidate', async () => {
  const first = deferred<WebSearchOutput>();
  const { service, run } = setup({
    search: async () => first.promise,
    readPage: async () => {
      throw new Error('unexpected');
    },
  });
  service.executeWorkflow({ id: run.id });
  expect(service.cancel({ id: run.id }).status).toBe('cancelled');
  first.resolve(result(collection));
  await vi.waitFor(() => expect(service.isActive()).toBe(false));
  expect(service.candidates({ id: run.id })).toEqual([]);
  expect(() => service.executeWorkflow({ id: run.id })).toThrow(/again/);
});

it('fences a model result that arrives after cancellation without erasing the verified capture', async () => {
  const late = deferred<GenerationResult>();
  const { inference } = model();
  const generate = vi.fn(async () => late.promise);
  inference.generate = generate;
  const { service, run } = setup(
    {
      search: async (query) =>
        result(query.includes('Acme') ? canonical : collection),
      readPage: async (url) => (url === collection ? collectionPage : jobPage),
    },
    inference,
    (config) => {
      config.query.maxQueries = 1;
    },
  );
  service.executeWorkflow({ id: run.id });
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
  const candidate = service.candidates({ id: run.id })[0];
  service.cancel({ id: run.id });
  late.resolve({
    requestId: crypto.randomUUID(),
    providerId: 'ollama',
    modelId: 'local',
    status: 'completed',
    output: {},
    toolCalls: [],
    usage: null,
  });
  await vi.waitFor(() => expect(service.isActive()).toBe(false));
  expect(service.get({ id: run.id }).status).toBe('cancelled');
  expect(service.get({ id: run.id }).stats.extractions).toBe(0);
  expect(service.candidates({ id: run.id })[0].canonicalUrl).toBe(canonical);
  expect(
    service.extractions({ id: run.id, sourceId: candidate.sourceId })[0],
  ).toMatchObject({ status: 'failed', errorCode: 'CANCELLED' });
  expect(service.matches({ id: run.id })).toEqual([]);
});

it('isolates a failed sibling and search outage while retaining the first verified extraction', async () => {
  const page = structuredClone(collectionPage);
  const blocks = page.structured!.content.blocks;
  if (blocks[0].type !== 'list') throw new Error('bad fixture');
  blocks[0].items.push({
    text: 'Software Intern Phantom London',
    links: [
      {
        text: 'Software Intern',
        href: 'https://uk.linkedin.com/jobs/view/software-intern-2345678',
      },
      { text: 'Phantom', href: 'https://www.linkedin.com/company/phantom' },
    ],
  });
  const { inference } = model();
  const { service, run } = setup(
    {
      search: async (query) => {
        if (query.includes('Developer Intern'))
          throw new WebError('PROVIDER_UNAVAILABLE');
        return result(
          query.includes('Acme') || query.includes('Phantom')
            ? canonical
            : collection,
        );
      },
      readPage: async (url) => (url === collection ? page : jobPage),
    },
    inference,
    (config) => {
      config.run.maxTransientRetries = 0;
      config.run.maxTargetedSearchesPerCandidate = 1;
    },
  );
  service.executeWorkflow({ id: run.id });
  await vi.waitFor(() =>
    expect(service.get({ id: run.id }).status).toBe('partial'),
  );
  const candidates = service.candidates({ id: run.id });
  expect(candidates).toHaveLength(2);
  expect(candidates.find((item) => item.company === 'Acme')?.canonicalUrl).toBe(
    canonical,
  );
  expect(
    candidates.find((item) => item.company === 'Phantom')?.canonicalUrl,
  ).toBeNull();
  expect(service.matches({ id: run.id })).toHaveLength(1);
  expect(
    service
      .get({ id: run.id })
      .diagnostics.some((item) => item.code === 'WEB_UNAVAILABLE'),
  ).toBe(true);
});

it('reuses a verified capture after a cancelled run without repeating resolution or interpretation', async () => {
  const { inference, generate } = model();
  const targeted = vi.fn(async () => result(canonical));
  const { service, repo, saved, run } = setup(
    {
      search: async (query) =>
        query.includes('Acme') ? targeted() : result(collection),
      readPage: async (url) => (url === collection ? collectionPage : jobPage),
    },
    inference,
    (config) => {
      config.query.maxQueries = 1;
    },
  );
  const observed = repo.observe(
    run.id,
    {
      provider: 'linkedin',
      key: '1234567',
      discoveredUrl: listing,
      collectionUrl: collection,
      title: 'Software Intern',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date().toISOString(),
  )!;
  const captureId = repo.capture(observed, jobPage, new Date().toISOString())!;
  repo.resolutionResult(
    run.id,
    observed.sourceId,
    'verified',
    { captureId },
    canonical,
    new Date().toISOString(),
  );
  service.cancel({ id: run.id });
  const next = service.start({ savedSearchId: saved.id });
  service.executeWorkflow({ id: next.id });
  await vi.waitFor(() =>
    expect(service.get({ id: next.id }).status).toBe('completed'),
  );
  expect(service.candidates({ id: next.id })[0].id).toBe(observed.id);
  expect(
    service.extractions({ id: next.id, sourceId: observed.sourceId })[0]
      .captureId,
  ).toBe(captureId);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(targeted).not.toHaveBeenCalled();
  const third = service.start({ savedSearchId: saved.id });
  service.executeWorkflow({ id: third.id });
  await vi.waitFor(() =>
    expect(service.get({ id: third.id }).status).toBe('completed'),
  );
  expect(service.get({ id: third.id }).stats.newCandidates).toBe(0);
  expect(generate).toHaveBeenCalledTimes(1);
});

it('records a new exact alias but never admits it twice in one run', () => {
  const { repo, service, run } = setup({
    search: async () => result(),
    readPage: async () => jobPage,
  });
  const original = repo.observe(
    run.id,
    {
      provider: 'greenhouse',
      key: 'first',
      discoveredUrl: canonical,
      collectionUrl: null,
      title: 'Software Intern',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date().toISOString(),
  )!;
  repo.observe(
    run.id,
    {
      provider: 'greenhouse',
      key: 'second',
      discoveredUrl: `${canonical}?utm_source=board`,
      collectionUrl: null,
      title: 'Software Intern',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date().toISOString(),
  );
  expect(service.candidates({ id: run.id })).toHaveLength(1);
  expect(service.get({ id: run.id }).stats).toMatchObject({
    inspectedCandidates: 2,
    newCandidates: 1,
  });
  const aliases = storage.db
    .prepare(
      `SELECT opportunity_id FROM job_opportunity_sources WHERE opportunity_id=?`,
    )
    .all(original.id);
  expect(aliases).toHaveLength(2);
  const alias = storage.db
    .prepare(`SELECT id FROM job_opportunity_sources WHERE source_key='second'`)
    .get() as { id: string };
  expect(() =>
    storage.db
      .prepare(
        `UPDATE job_discovery_run_items SET admitted=1 WHERE run_id=? AND source_id=?`,
      )
      .run(run.id, alias.id),
  ).toThrow(/admission/);
});
