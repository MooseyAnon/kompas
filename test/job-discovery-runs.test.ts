import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { planQueries } from '../src/main/modules/job-discovery/query-planner';
import { RunBudget } from '../src/main/modules/job-discovery/run-budget';
import { AdapterRegistry } from '../src/main/modules/web/adapter-registry';
import { WebService } from '../src/main/modules/web/web.service';
import { createDispatcher } from '../src/main/ipc/dispatcher';
import { createJobDiscoveryModule } from '../src/main/modules/job-discovery/job-discovery.module';
import {
  newJobDiscoveryConfiguration,
  type JobDiscoveryConfigurationV1,
} from '../src/shared/contracts';

let dir: string;
let storage: Storage;
let searches: SavedSearchesService;
let runs: DiscoveryRunsService;
const config = (): JobDiscoveryConfigurationV1 => ({
  ...newJobDiscoveryConfiguration(),
  name: 'Engineering internships',
  intent: {
    ...newJobDiscoveryConfiguration().intent,
    targetRoles: ['Engineering Intern'],
    seniority: 'internship',
    location: 'United Kingdom',
    targetYear: 2027,
    companies: ['Acme'],
    keywords: ['summer'],
  },
});
function wire() {
  searches = new SavedSearchesService(new SavedSearchesRepository(storage.db));
  runs = new DiscoveryRunsService(
    new DiscoveryRunsRepository(storage.db),
    searches,
  );
}
function send(action: string, payload: unknown) {
  return createAppDispatcher({
    getAppVersion: () => 'test',
    isStorageReady: () => true,
    storage,
  }).dispatch({
    requestId: crypto.randomUUID(),
    module: 'jobDiscovery',
    version: 1,
    action: `runs.${action}`,
    payload,
  });
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-discovery-runs-'));
  storage = openStorage(dir);
  wire();
});
afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deterministic query planning', () => {
  it('uses distinct internship and placement queries, then optional company and keyword variants', () => {
    const value = config();
    const plan = planQueries(value);
    expect(plan).toHaveLength(4);
    expect(plan[0]).toContain('Engineering Intern');
    expect(plan[1]).toContain('Engineering placement');
    expect(plan[2]).toContain('Acme');
    expect(plan[3]).toContain('summer');
    expect(
      plan.every((q) => q.includes('United Kingdom') && q.includes('2027')),
    ).toBe(true);
    expect(new Set(plan.map((q) => q.toLowerCase())).size).toBe(4);
    expect(planQueries(value)).toEqual(plan);
  });
  it('round-robins across five roles before variants, capped at four total', () => {
    const value = config();
    value.intent.targetRoles = [
      'Engineer',
      'Designer',
      'Analyst',
      'Scientist',
      'Architect',
    ];
    value.intent.keywords = Array.from({ length: 10 }, (_, i) => `skill ${i}`);
    value.intent.companies = Array.from(
      { length: 10 },
      (_, i) => `company ${i}`,
    );
    expect(planQueries(value).map((q) => q.split(' ')[0])).toEqual(
      value.intent.targetRoles.slice(0, 4),
    );
    value.query.maxQueries = 1;
    expect(planQueries(value)).toHaveLength(1);
    value.intent.location = null;
    expect(planQueries(value)[0]).not.toMatch(/London|United Kingdom/);
  });
  it('dedupes normalized variants and refuses impossible mandatory query text instead of truncating', () => {
    const value = config();
    value.intent.seniority = null;
    value.intent.targetRoles = ['  Engineering   Intern  '];
    value.intent.companies = [' engineering intern ', ' ENGINEERING INTERN '];
    value.intent.keywords = [];
    expect(planQueries(value)).toHaveLength(2);
    value.intent.targetRoles = ['Engineering ' + 'X'.repeat(110)];
    value.intent.location = 'L'.repeat(200);
    expect(() => planQueries(value)).toThrow(/limit/);
    value.intent.location = null;
    value.query.maxQueries = 5;
    expect(() => planQueries(value)).toThrow();
  });
});

describe('run persistence and IPC', () => {
  it('projects run-scoped queue progress through validated IPC without exposing other run IDs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const web = new WebService({
      registry: new AdapterRegistry([
        {
          id: 'fake',
          capabilities: ['search'],
          search: async (query) => {
            if (query === 'manual') await gate;
            return [];
          },
        },
      ]),
      preferences: { search: ['fake'], readPage: [] },
    });
    const manual = web.search('manual');
    const saved = searches.create({ config: config() });
    const run = new DiscoveryRunsService(
      new DiscoveryRunsRepository(storage.db),
      searches,
      undefined,
      web,
    );
    const started = run.start({ savedSearchId: saved.id });
    const execution = run.execute({ id: started.id });
    const dispatcher = createDispatcher([
      createJobDiscoveryModule(searches, run),
    ]);
    const sendProgress = (id: string) =>
      dispatcher.dispatch({
        requestId: crypto.randomUUID(),
        module: 'jobDiscovery',
        version: 1,
        action: 'runs.searchProgress',
        payload: { id },
      });
    // The executor's first Web attempt joins the already active manual attempt.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await sendProgress(started.id)).toMatchObject({
      ok: true,
      data: {
        progress: {
          operationActive: true,
          queueLength: 1,
          position: 1,
          state: 'waiting',
        },
      },
    });
    expect(await sendProgress(crypto.randomUUID())).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    run.cancel({ id: started.id });
    await execution;
    expect(web.searchProgress(started.id)).toMatchObject({
      position: null,
      state: 'idle',
      queueLength: 0,
    });
    release();
    await manual;
  });
  it('freezes a deep config/plan, preserves them on edit and toggle, and cancels idempotently', async () => {
    const original = config();
    const saved = searches.create({ config: original });
    const preview = await send('preview', { savedSearchId: saved.id });
    expect(preview).toMatchObject({
      ok: true,
      data: { queries: planQueries(original) },
    });
    const started = await send('start', { savedSearchId: saved.id });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('start failed');
    const run = (started.data as { item: ReturnType<typeof runs.start> }).item;
    expect(run.status).toBe('running');
    expect(run.configSnapshot).toEqual(original);
    expect(run.stats).toMatchObject({ queriesPlanned: 4, newCandidates: 0 });
    original.name = 'Later edit';
    original.run.maxNewCandidates = 1;
    searches.update({ id: saved.id, config: original });
    searches.setActive({ id: saved.id, active: false });
    expect(runs.get({ id: run.id })).toEqual(run);
    expect((await send('start', { savedSearchId: saved.id })).ok).toBe(false);
    expect(await send('cancel', { id: run.id })).toMatchObject({
      ok: true,
      data: {
        item: {
          status: 'cancelled',
          diagnostics: [{ code: 'CANCELLED_BY_USER' }],
        },
      },
    });
    expect(await send('cancel', { id: run.id })).toMatchObject({
      ok: true,
      data: {
        item: {
          status: 'cancelled',
          diagnostics: [{ code: 'CANCELLED_BY_USER' }],
        },
      },
    });
    expect(runs.get({ id: run.id }).diagnostics).toHaveLength(1);
    expect(runs.get({ id: run.id }).configSnapshot).toEqual(run.configSnapshot);
    expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
  it('rejects overlap, inactive and invalid caps through public boundary and SQL', async () => {
    const saved = searches.create({ config: config() });
    const second = searches.create({ config: config() });
    const run = runs.start({ savedSearchId: saved.id });
    expect(await send('start', { savedSearchId: second.id })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    expect(
      await send('start', { savedSearchId: second.id, profileId: 'foreign' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(() => runs.start({ savedSearchId: second.id })).toThrow(/running/);
    const raw = storage.db
      .prepare(
        `SELECT config_snapshot_json,query_plan_json FROM job_discovery_runs WHERE id=?`,
      )
      .get(run.id) as { config_snapshot_json: string; query_plan_json: string };
    expect(() =>
      storage.db
        .prepare(
          `UPDATE job_discovery_runs SET query_plan_json='["overwritten"]' WHERE id=?`,
        )
        .run(run.id),
    ).toThrow();
    expect(() =>
      storage.db
        .prepare(
          `UPDATE job_discovery_runs SET config_snapshot_json='{}' WHERE id=?`,
        )
        .run(run.id),
    ).toThrow();
    expect(
      storage.db
        .prepare(
          `SELECT config_snapshot_json,query_plan_json FROM job_discovery_runs WHERE id=?`,
        )
        .get(run.id),
    ).toEqual(raw);
    runs.cancel({ id: run.id });
    searches.setActive({ id: second.id, active: false });
    expect(await send('start', { savedSearchId: second.id })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    const bad = {
      ...config(),
      query: { strategy: 'deterministic_v1' as const, maxQueries: 5 },
    };
    expect(() => searches.update({ id: saved.id, config: bad })).toThrow();
    expect((await send('start', { savedSearchId: saved.id })).ok).toBe(true);
  });
  it('reconciles once on real storage restart, retains history and admits a new run', () => {
    const saved = searches.create({ config: config() });
    const first = runs.start({ savedSearchId: saved.id });
    storage.close();
    storage = openStorage(dir);
    wire();
    const recovered = runs.get({ id: first.id });
    expect(recovered).toMatchObject({
      status: 'interrupted',
      finishedAt: expect.any(String),
      diagnostics: [{ code: 'INTERRUPTED_ON_RESTART' }],
    });
    expect(recovered.queryPlan).toEqual(first.queryPlan);
    expect(recovered.configSnapshot).toEqual(first.configSnapshot);
    expect(runs.start({ savedSearchId: saved.id }).status).toBe('running');
    expect(storage.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('denies foreign run access and foreign saved searches, with safe pagination', async () => {
    let instant = Date.parse('2026-11-04T12:00:00.000Z');
    runs = new DiscoveryRunsService(
      new DiscoveryRunsRepository(storage.db),
      searches,
      () => new Date((instant += 1000)),
    );
    const now = new Date().toISOString();
    storage.db
      .prepare(
        `INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES ('foreign','',?,?)`,
      )
      .run(now, now);
    const foreignSearch = crypto.randomUUID();
    storage.db
      .prepare(`INSERT INTO job_saved_searches VALUES (?,'foreign',?,?,?)`)
      .run(foreignSearch, JSON.stringify(config()), now, now);
    const foreignRun = crypto.randomUUID();
    storage.db
      .prepare(`INSERT INTO job_discovery_runs (id,profile_id,saved_search_id,status,config_snapshot_json,query_plan_json,stats_json,started_at)
      VALUES (?,'foreign',?,'running',?,?,?,?)`)
      .run(
        foreignRun,
        foreignSearch,
        JSON.stringify(config()),
        JSON.stringify(['Engineering Intern']),
        JSON.stringify({
          queriesPlanned: 1,
          collectionPagesRead: 0,
          inspectedCandidates: 0,
          newCandidates: 0,
          targetedSearches: 0,
          targetedPagesRead: 0,
          extractions: 0,
          transientRetries: 0,
        }),
        now,
      );
    for (const action of ['get', 'cancel']) {
      expect(await send(action, { id: foreignRun })).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });
    }
    expect(await send('start', { savedSearchId: foreignSearch })).toMatchObject(
      { ok: false, error: { code: 'NOT_FOUND' } },
    );
    expect(await send('list', { cursor: foreignRun })).toMatchObject({
      ok: true,
      data: { items: [], nextCursor: null },
    });
    const saved = searches.create({ config: config() });
    const one = runs.start({ savedSearchId: saved.id });
    runs.cancel({ id: one.id });
    const two = runs.start({ savedSearchId: saved.id });
    expect(runs.list({ limit: 1 })).toMatchObject({
      items: [{ id: two.id }],
      nextCursor: two.id,
    });
    expect(runs.list({ limit: 1, cursor: two.id })).toMatchObject({
      items: [{ id: one.id }],
      nextCursor: null,
    });
    expect(storage.db.pragma('foreign_key_check')).toEqual([]);
  });
});

it('executor gate derives limits only from frozen snapshot and honours clock/abort', () => {
  const saved = searches.create({ config: config() });
  const run = runs.start({ savedSearchId: saved.id });
  const clock = () => Date.parse(run.startedAt) + 100;
  const controller = new AbortController();
  const guard = new RunBudget(run, clock, controller.signal);
  expect(guard.canAdmit({ ...run.stats, newCandidates: 9 })).toBe(true);
  expect(guard.canAdmit({ ...run.stats, newCandidates: 10 })).toBe(false);
  expect(guard.canInspect({ ...run.stats, inspectedCandidates: 100 })).toBe(
    false,
  );
  expect(
    guard.canReadCollection({ ...run.stats, collectionPagesRead: 5 }),
  ).toBe(false);
  expect(guard.canSearchCandidate(2)).toBe(false);
  expect(guard.canReadTargetedPage(4)).toBe(true);
  expect(guard.canReadTargetedPage(5)).toBe(false);
  expect(guard.canRetry(1)).toBe(false);
  expect(() =>
    new RunBudget(
      run,
      () => Date.parse(run.startedAt) + run.configSnapshot.run.deadlineMs,
    ).assertAvailable(),
  ).toThrow(/deadline/);
  controller.abort();
  expect(() => guard.assertAvailable()).toThrow(/no longer active/);
});
