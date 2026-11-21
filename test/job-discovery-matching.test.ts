import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import { AppError } from '../src/main/ipc/errors';
import { IdentityRepository } from '../src/main/modules/identity/identity.repository';
import { IdentityService } from '../src/main/modules/identity/identity.service';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import {
  matchRequiredSkills,
  skillKey,
  sortMatches,
} from '../src/main/modules/job-discovery/skill-matcher';
import {
  newJobDiscoveryConfiguration,
  type ExtractedJd,
  type PageReadResult,
} from '../src/shared/contracts';

let storage: Storage;
let dir: string;
afterEach(() => {
  storage?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const url = 'https://acme.example/jobs/123';
const page: PageReadResult = {
  requestedUrl: url,
  url,
  title: 'Engineer - Acme',
  status: 200,
  html: '<main>Job</main>',
  text: 'Acme Engineer in London. Responsibilities: build systems. Requires Python, SQL and Git.',
  providerId: 'fake',
  browserId: 'fake',
  truncated: { html: false, text: false },
};
const jd: ExtractedJd = {
  schemaVersion: 1,
  classification: 'job_description',
  title: null,
  company: null,
  location: { text: 'London', evidence: 'in London' },
  responsibilities: [],
  requiredSkills: ['Python', 'SQL', 'Git'].map((text) => ({
    text,
    evidence: text,
  })),
  preferredSkills: [{ text: 'Rust', evidence: 'Rust' }],
  educationRequirements: [],
  minimumYearsExperience: null,
  seniority: null,
  estimatedExperienceBand: null,
  employmentType: null,
  workArrangement: null,
  salaryText: null,
  inferences: [],
};

function fixture() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-match-'));
  storage = openStorage(dir);
  const identity = new IdentityService(new IdentityRepository(storage.db));
  const repo = new DiscoveryRunsRepository(storage.db);
  const searches = new SavedSearchesService(
    new SavedSearchesRepository(storage.db),
  );
  const config = newJobDiscoveryConfiguration();
  config.name = 'Roles';
  config.intent.targetRoles = ['Engineer'];
  const saved = searches.create({ config });
  const web = { search: vi.fn(), readPage: vi.fn() };
  const model = { generate: vi.fn() };
  const runs = new DiscoveryRunsService(
    repo,
    searches,
    undefined,
    web as never,
    undefined,
    model as never,
    identity,
  );
  const run = runs.start({ savedSearchId: saved.id });
  const admit = (key: string) => {
    repo.observe(
      run.id,
      {
        provider: 'linkedin',
        key,
        discoveredUrl: `https://www.linkedin.com/jobs/view/${key}`,
        collectionUrl: null,
        title: `Engineer ${key}`,
        company: 'Acme',
        location: 'London',
        postingAge: null,
      },
      new Date().toISOString(),
    );
    return runs
      .candidates({ id: run.id })
      .find((item) => item.sourceKey === key)!;
  };
  const extract = (sourceId: string, sourceJd: ExtractedJd) => {
    const candidate = runs
      .candidates({ id: run.id })
      .find((item) => item.sourceId === sourceId)!;
    const captureId = repo.capture(candidate, page, new Date().toISOString())!;
    repo.resolutionResult(
      run.id,
      sourceId,
      'verified',
      { captureId },
      url,
      new Date().toISOString(),
    );
    const attempt = repo.claimExtraction(
      run.id,
      sourceId,
      captureId,
      new Date().toISOString(),
    )!;
    repo.finishExtraction(
      run.id,
      sourceId,
      attempt.id,
      {
        jd: sourceJd,
        provenance: {
          providerId: 'ollama',
          modelId: 'local',
          requestId: crypto.randomUUID(),
          thinking: false,
          configurationVersion: 1,
          promptVersion: 'jd-extract-v1',
          timeoutMs: 1000,
        },
        diagnostics: [],
        errorCode: null,
      },
      new Date().toISOString(),
    );
  };
  return { identity, repo, runs, runId: run.id, admit, extract, web, model };
}

it('deduplicates explicit required evidence, aliases and punctuation without speculative matches', () => {
  expect(skillKey('Node.js')).toBe(skillKey('nodejs'));
  expect(skillKey('C++')).not.toBe(skillKey('C#'));
  const result = matchRequiredSkills({
    opportunityId: crypto.randomUUID(),
    extractionId: crypto.randomUUID(),
    jd: {
      ...jd,
      requiredSkills: [
        ...jd.requiredSkills,
        { text: ' python ', evidence: 'Python' },
        { text: 'Scala', evidence: '' },
      ],
    },
    confirmedSkills: [' PYTHON ', 'Git', 'Rust'],
    profileLocation: 'London',
    fingerprint: 'a'.repeat(64),
    computedAt: new Date().toISOString(),
  });
  expect(result).toMatchObject({
    status: 'scored',
    reason: 'COVERAGE',
    requiredCount: 3,
    coverage: 2 / 3,
    matched: ['Python', 'Git'],
    unmatched: ['SQL'],
    alignment: { location: 'match', years: 'unknown', seniority: 'unknown' },
  });
  expect(
    matchRequiredSkills({
      ...resultToInput(),
      jd: { ...jd, requiredSkills: [] },
    }).coverage,
  ).toBeNull();
  expect(
    matchRequiredSkills({ ...resultToInput(), confirmedSkills: [] }).reason,
  ).toBe('NO_CONFIRMED_SKILLS');
  expect(
    matchRequiredSkills({ ...resultToInput(), confirmedSkills: null }).reason,
  ).toBe('PROFILE_UNAVAILABLE');
  expect(
    matchRequiredSkills({ ...resultToInput(), confirmedSkills: null })
      .unmatched,
  ).toEqual([]);
  expect(
    sortMatches([
      result,
      { ...result, opportunityId: crypto.randomUUID(), coverage: null },
    ])[0],
  ).toBe(result);
});

function resultToInput() {
  return {
    opportunityId: crypto.randomUUID(),
    extractionId: crypto.randomUUID(),
    jd,
    confirmedSkills: ['Python'],
    profileLocation: null,
    fingerprint: 'a'.repeat(64),
    computedAt: new Date().toISOString(),
  };
}

it('refreshes persisted scores from user-confirmed Identity skills without Web or model calls', () => {
  const { identity, repo, runs, runId, admit, extract, web, model } = fixture();
  const one = admit('111');
  const two = admit('222');
  repo.finish(runId, 'completed', new Date().toISOString());
  extract(one.sourceId, jd);
  extract(two.sourceId, {
    ...jd,
    requiredSkills: jd.requiredSkills.slice(0, 1),
  });
  identity.replaceConfirmedSkills({ names: ['Python', 'Git'] });
  identity.updateProfile({ location: 'London' });
  const first = runs.refreshMatches({ id: runId });
  expect(first.map((item) => item.coverage)).toEqual([1, 2 / 3]);
  expect(first[1]).toMatchObject({
    matched: ['Python', 'Git'],
    unmatched: ['SQL'],
    alignment: { location: 'match' },
  });
  const fingerprint = first[0].profileSkillFingerprint;
  identity.replaceConfirmedSkills({ names: ['SQL'] });
  expect(runs.matches({ id: runId })[0].profileSkillFingerprint).toBe(
    fingerprint,
  );
  const refreshed = runs.refreshMatches({ id: runId });
  expect(refreshed.map((item) => item.coverage)).toEqual([1 / 3, 0]);
  expect(refreshed[0].profileSkillFingerprint).not.toBe(fingerprint);
  expect(() =>
    storage.db
      .prepare('UPDATE job_opportunities SET match_json=? WHERE id=?')
      .run(
        JSON.stringify({ ...refreshed[0], extractionId: crypto.randomUUID() }),
        refreshed[0].opportunityId,
      ),
  ).toThrow();
  expect(web.search).not.toHaveBeenCalled();
  expect(web.readPage).not.toHaveBeenCalled();
  expect(model.generate).not.toHaveBeenCalled();
  storage.close();
  storage = openStorage(dir);
  expect(new DiscoveryRunsRepository(storage.db).matches(runId)).toHaveLength(
    2,
  );
  expect(storage.db.pragma('foreign_key_check')).toEqual([]);
  expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('reports a missing profile as unscored and cannot read another profile’s run', () => {
  const { repo, runs, runId, admit, extract } = fixture();
  const candidate = admit('444');
  repo.finish(runId, 'completed', new Date().toISOString());
  extract(candidate.sourceId, jd);
  const unavailable = new DiscoveryRunsService(
    repo,
    new SavedSearchesService(new SavedSearchesRepository(storage.db)),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      listConfirmedSkills: () => {
        throw new Error('unexpected');
      },
      getProfile: () => ({ location: null }),
    },
  );
  // Only the owned NOT_FOUND signal is considered an unavailable profile.
  expect(() => unavailable.refreshMatches({ id: runId })).toThrow('unexpected');
  const missing = new DiscoveryRunsService(
    repo,
    new SavedSearchesService(new SavedSearchesRepository(storage.db)),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      listConfirmedSkills: () => {
        throw new AppError('NOT_FOUND', 'Profile unavailable');
      },
      getProfile: () => ({ location: null }),
    },
  );
  expect(missing.refreshMatches({ id: runId })[0]).toMatchObject({
    reason: 'PROFILE_UNAVAILABLE',
    coverage: null,
  });

  const foreign = crypto.randomUUID();
  const search = crypto.randomUUID();
  const run = crypto.randomUUID();
  const at = new Date().toISOString();
  const config = runs.get({ id: runId }).configSnapshot;
  storage.db
    .prepare(
      'INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES (?,?,?,?)',
    )
    .run(foreign, '', at, at);
  storage.db
    .prepare(
      'INSERT INTO job_saved_searches (id,profile_id,config_json,created_at,updated_at) VALUES (?,?,?,?,?)',
    )
    .run(search, foreign, JSON.stringify(config), at, at);
  storage.db
    .prepare(`INSERT INTO job_discovery_runs (id,profile_id,saved_search_id,status,config_snapshot_json,query_plan_json,stats_json,started_at,finished_at)
    VALUES (?,?,?,'completed',?,?,?,?,?)`)
    .run(
      run,
      foreign,
      search,
      JSON.stringify(config),
      JSON.stringify(['Engineer']),
      JSON.stringify(runs.get({ id: runId }).stats),
      at,
      at,
    );
  expect(() => runs.matches({ id: run })).toThrowError(/not found/i);
  expect(() => runs.refreshMatches({ id: run })).toThrowError(/not found/i);
});

it('returns unscored for absent extraction or skills and keeps all IPC requests scoped', async () => {
  const { identity, runs, runId, admit } = fixture();
  admit('333');
  expect(runs.refreshMatches({ id: runId })[0]).toMatchObject({
    reason: 'NO_EXTRACTION',
    coverage: null,
  });
  const dispatcher = createAppDispatcher({
    getAppVersion: () => 'test',
    isStorageReady: () => true,
    storage,
  });
  const send = (module: string, action: string, payload: unknown) =>
    dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module,
      version: 1,
      action,
      payload,
    });
  expect(
    await send('identity', 'skills.replace', { names: ['Python', 'Git'] }),
  ).toMatchObject({ ok: true });
  expect(identity.listConfirmedSkills()).toEqual(['Git', 'Python']);
  expect(
    await send('identity', 'skills.replace', {
      names: ['Python'],
      source: 'cv',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(
    await send('jobDiscovery', 'runs.matches', { id: crypto.randomUUID() }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(
    await send('jobDiscovery', 'runs.refreshMatches', {
      id: runId,
      profileId: 'foreign',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(
    await send('jobDiscovery', 'runs.matches', { id: runId }),
  ).toMatchObject({ ok: true, data: { items: [{ reason: 'NO_EXTRACTION' }] } });
});
