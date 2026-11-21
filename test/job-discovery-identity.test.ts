import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { openConnection } from '../src/main/core/db/connection';
import { runMigrations } from '../src/main/core/db/migrator';
import { MIGRATIONS } from '../src/main/core/db/migrations';
import { seedLocalProfile } from '../src/main/core/db/database';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { DiscoveryIdentityService } from '../src/main/modules/job-discovery/identity.service';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { ApplicationsRepository } from '../src/main/modules/applications/applications.repository';
import { ApplicationsService } from '../src/main/modules/applications/applications.service';
import { newJobDiscoveryConfiguration } from '../src/shared/contracts';
import type { CandidateObservation } from '../src/main/modules/job-discovery/collection';
import { jobReference } from '../src/main/modules/web/job-reference';

let dir: string;
let storage: Storage;
let repo: DiscoveryRunsRepository;
let searches: SavedSearchesService;
let applications: ApplicationsService;

function saved(maxNewCandidates = 10) {
  const config = newJobDiscoveryConfiguration();
  config.name = 'Placement';
  config.intent.targetRoles = ['Engineer'];
  config.query.maxQueries = 1;
  config.run.maxNewCandidates = maxNewCandidates;
  return searches.create({ config });
}

function candidate(n: number, suffix = ''): CandidateObservation {
  return {
    provider: 'linkedin',
    key: String(1000000 + n),
    discoveredUrl: `https://uk.linkedin.com/jobs/view/engineer-${1000000 + n}?trk=${suffix}`,
    collectionUrl: 'https://uk.linkedin.com/jobs/search/',
    title: 'Engineer',
    company: 'AECOM',
    location: 'London',
    postingAge: null,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-job-identity-'));
  storage = openStorage(dir);
  repo = new DiscoveryRunsRepository(storage.db);
  searches = new SavedSearchesService(new SavedSearchesRepository(storage.db));
  applications = new ApplicationsService(
    new ApplicationsRepository(storage.db),
    { getMetadata: () => null },
  );
});
afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('re-admits unfinished tracker identities across runs without creating new opportunities', async () => {
  const search = saved();
  const web = {
    search: async () => ({
      providerId: 'test',
      results: Array.from({ length: 20 }, (_, i) => ({
        title: 'Engineer',
        url: candidate(i, 'new-tracker').discoveredUrl,
        rank: i + 1,
      })),
    }),
    readPage: async () => {
      throw new Error('unexpected collection read');
    },
  };
  const run = async () => {
    const service = new DiscoveryRunsService(repo, searches, undefined, web);
    const started = service.start({ savedSearchId: search.id });
    const done = await service.execute({ id: started.id });
    return { done, items: service.candidates({ id: started.id }) };
  };
  const first = await run();
  expect(first.done.stats).toMatchObject({
    inspectedCandidates: 10,
    newCandidates: 10,
  });
  storage.close();
  storage = openStorage(dir);
  repo = new DiscoveryRunsRepository(storage.db);
  searches = new SavedSearchesService(new SavedSearchesRepository(storage.db));
  const second = await run();
  expect(second.done.stats).toMatchObject({
    inspectedCandidates: 10,
    newCandidates: 10,
  });
  expect(second.items.map((item) => item.sourceKey).sort()).toEqual(
    Array.from({ length: 10 }, (_, i) => String(1000000 + i)),
  );
  expect(second.items.map((item) => item.id).sort()).toEqual(
    first.items.map((item) => item.id).sort(),
  );
  const third = await run();
  expect(third.done.stats).toMatchObject({
    inspectedCandidates: 10,
    newCandidates: 10,
  });
  expect(third.items.map((item) => item.id).sort()).toEqual(
    first.items.map((item) => item.id).sort(),
  );
  const aliasId = crypto.randomUUID();
  storage.db
    .prepare(`INSERT INTO job_opportunity_sources
    (id,profile_id,opportunity_id,provider,source_key,discovered_url,first_seen_at,last_seen_at)
    VALUES (?,'local',?,'indeed','123456789abcdef0',?,?,?)`)
    .run(
      aliasId,
      third.items[0].id,
      'https://uk.indeed.com/viewjob?jk=123456789abcdef0',
      new Date().toISOString(),
      new Date().toISOString(),
    );
  expect(() =>
    storage.db
      .prepare(`INSERT INTO job_discovery_run_items
    (id,run_id,source_id,admitted,outcome,observed_at,updated_at)
    VALUES (?,?,?,1,'admitted',?,?)`)
      .run(
        crypto.randomUUID(),
        third.done.id,
        aliasId,
        new Date().toISOString(),
        new Date().toISOString(),
      ),
  ).toThrow(/admission/);
  expect(storage.db.pragma('foreign_key_check')).toEqual([]);
  expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('skips exhausted resolution and explicit review exclusions on a fresh run', () => {
  const service = new DiscoveryRunsService(repo, searches);
  const search = saved();
  const first = service.start({ savedSearchId: search.id });
  for (let n = 0; n < 4; n++)
    repo.observe(first.id, candidate(n), new Date().toISOString());
  const original = service.candidates({ id: first.id });
  storage.db
    .prepare(`UPDATE job_opportunities SET resolution_attempts=2 WHERE id=?`)
    .run(original[0].id);
  storage.db
    .prepare(
      `UPDATE job_opportunities SET review_decision='dismissed' WHERE id=?`,
    )
    .run(original[1].id);
  storage.db
    .prepare(`UPDATE job_opportunities SET review_decision='saved' WHERE id=?`)
    .run(original[2].id);
  repo.finish(first.id, 'partial', new Date().toISOString());
  const next = service.start({ savedSearchId: search.id });
  for (let n = 0; n < 4; n++)
    repo.observe(next.id, candidate(n, 'new'), new Date().toISOString());
  expect(service.get({ id: next.id }).stats).toMatchObject({
    inspectedCandidates: 4,
    newCandidates: 1,
  });
  expect(service.candidates({ id: next.id })[0].id).toBe(original[3].id);
});

it('upgrades a populated v19 source and preserves its identity, decision and attempt count', () => {
  const file = path.join(dir, 'prior.sqlite');
  const prior = openConnection(file);
  runMigrations(prior, MIGRATIONS.slice(0, 19));
  seedLocalProfile(prior);
  const oldRepo = new DiscoveryRunsRepository(prior);
  const oldSearches = new SavedSearchesService(
    new SavedSearchesRepository(prior),
  );
  const config = newJobDiscoveryConfiguration();
  config.name = 'Existing';
  config.intent.targetRoles = ['Engineer'];
  config.run.maxPagesPerTargetedSearch = 3; // Historical v19 SQL ceiling.
  const saved = oldSearches.create({ config });
  const oldService = new DiscoveryRunsService(oldRepo, oldSearches);
  const old = oldService.start({ savedSearchId: saved.id });
  const original = oldRepo.observe(
    old.id,
    candidate(0),
    new Date().toISOString(),
  )!;
  prior
    .prepare(`UPDATE job_opportunities SET resolution_attempts=1 WHERE id=?`)
    .run(original.id);
  oldRepo.finish(old.id, 'partial', new Date().toISOString());
  prior.close();

  const upgraded = openConnection(file);
  try {
    expect(runMigrations(upgraded).appliedVersions).toEqual([
      20, 21, 22, 23, 24,
    ]);
    const nextRepo = new DiscoveryRunsRepository(upgraded);
    const nextService = new DiscoveryRunsService(
      nextRepo,
      new SavedSearchesService(new SavedSearchesRepository(upgraded)),
    );
    const next = nextService.start({ savedSearchId: saved.id });
    const recovered = nextRepo.observe(
      next.id,
      candidate(0, 'later'),
      new Date().toISOString(),
    );
    expect(recovered).toMatchObject({
      id: original.id,
      sourceId: original.sourceId,
      resolutionAttempts: 1,
    });
    expect(nextService.get({ id: next.id }).stats.newCandidates).toBe(1);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    upgraded.close();
  }
});

it('preserves a decided source and treats cross-site similarity as possible, never merged', () => {
  const identity = new DiscoveryIdentityService(repo, applications);
  const service = new DiscoveryRunsService(repo, searches);
  const search = saved();
  const first = service.start({ savedSearchId: search.id });
  const original = candidate(0, 'first');
  identity.observe(first.id, original, new Date().toISOString());
  const source = service.candidates({ id: first.id })[0];
  storage.db
    .prepare(
      `UPDATE job_opportunities SET review_decision='dismissed', resolution_status='unresolved' WHERE id=?`,
    )
    .run(source.id);
  service.cancel({ id: first.id });
  const next = service.start({ savedSearchId: search.id });
  identity.observe(next.id, candidate(0, 'second'), new Date().toISOString());
  identity.observe(
    next.id,
    {
      ...original,
      provider: 'indeed',
      key: '84ead4a76a3bfd70',
      discoveredUrl:
        'https://uk.indeed.com/rc/clk?jk=84ead4a76a3bfd70&bb=tracker',
      location: 'London',
    },
    new Date().toISOString(),
  );
  identity.observe(
    next.id,
    {
      ...original,
      provider: 'indeed',
      key: '2e7d21c004076123',
      discoveredUrl: 'https://uk.indeed.com/rc/clk?jk=2e7d21c004076123',
      location: 'Cambridge',
    },
    new Date().toISOString(),
  );
  expect(service.get({ id: next.id }).stats).toMatchObject({
    inspectedCandidates: 3,
    newCandidates: 2,
  });
  expect(service.get({ id: next.id }).diagnostics.map((d) => d.code)).toContain(
    'POSSIBLE_DUPLICATE',
  );
  const decided = storage.db
    .prepare(`SELECT o.review_decision, o.resolution_status, s.discovered_url, s.first_seen_at, s.last_seen_at
    FROM job_opportunity_sources s JOIN job_opportunities o ON o.id=s.opportunity_id WHERE s.id=?`)
    .get(source.sourceId) as Record<string, string>;
  expect(decided.review_decision).toBe('dismissed');
  expect(decided.resolution_status).toBe('unresolved');
  expect(decided.discovered_url).toBe(original.discoveredUrl);
  expect(decided.last_seen_at >= decided.first_seen_at).toBe(true);
  expect(
    new Set(service.candidates({ id: next.id }).map((item) => item.id)).size,
  ).toBe(2);
  const flags = storage.db
    .prepare(`SELECT source_key, listing_meta_json FROM job_opportunity_sources
    WHERE provider='indeed' ORDER BY source_key`)
    .all() as Array<{ source_key: string; listing_meta_json: string }>;
  expect(
    flags.map((item) => [
      item.source_key,
      JSON.parse(item.listing_meta_json).possibleDuplicate,
    ]),
  ).toEqual([
    ['2e7d21c004076123', false],
    ['84ead4a76a3bfd70', true],
  ]);
});

it('consults Applications for archived and applied exact references; enforces snapshot cap in SQL', () => {
  const app = applications.create({
    companyName: 'AECOM',
    roleTitle: 'Engineer',
    jobUrl: candidate(0, 'original').discoveredUrl,
    initialStage: { stageLabel: 'Applied', stageKind: 'applied' },
  });
  applications.archive(app.application.id, true);
  const service = new DiscoveryRunsService(repo, searches);
  const search = saved(1);
  const run = service.start({ savedSearchId: search.id });
  const identity = new DiscoveryIdentityService(repo, applications);
  identity.observe(run.id, candidate(0, 'changed'), new Date().toISOString());
  expect(service.get({ id: run.id }).stats).toMatchObject({
    inspectedCandidates: 1,
    newCandidates: 0,
  });
  const linked = storage.db
    .prepare(
      `SELECT application_id, review_decision FROM job_opportunities WHERE profile_id='local'`,
    )
    .get() as Record<string, string>;
  expect(linked).toMatchObject({
    application_id: app.application.id,
    review_decision: 'applied',
  });
  identity.observe(run.id, candidate(1), new Date().toISOString());
  expect(service.get({ id: run.id }).stats.newCandidates).toBe(1);
  expect(() =>
    storage.db
      .prepare(
        `UPDATE job_discovery_run_items SET admitted=1 WHERE run_id=? AND admitted=0`,
      )
      .run(run.id),
  ).toThrow(/admission/);
});

it('keeps URL aliases and verified canonical links separate from new admissions and foreign profiles', () => {
  const service = new DiscoveryRunsService(repo, searches);
  const search = saved();
  const first = service.start({ savedSearchId: search.id });
  const identity = new DiscoveryIdentityService(repo);
  const origin = candidate(0);
  identity.observe(first.id, origin, new Date().toISOString());
  const opportunityId = service.candidates({ id: first.id })[0].id;
  const canonical = 'https://boards.greenhouse.io/aecom/jobs/1234567';
  storage.db
    .prepare(
      `UPDATE job_opportunities SET canonical_url=?, canonical_verified_at=? WHERE id=?`,
    )
    .run(canonical, new Date().toISOString(), opportunityId);
  service.cancel({ id: first.id });

  const now = new Date().toISOString();
  storage.db
    .prepare(
      `INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES ('foreign','',?,?)`,
    )
    .run(now, now);
  const foreignOpportunity = crypto.randomUUID();
  storage.db
    .prepare(`INSERT INTO job_opportunities (id,profile_id,title,created_at,updated_at)
    VALUES (?,'foreign','Engineer',?,?)`)
    .run(foreignOpportunity, now, now);
  storage.db
    .prepare(`INSERT INTO job_opportunity_sources
    (id,profile_id,opportunity_id,provider,source_key,discovered_url,first_seen_at,last_seen_at)
    VALUES (?,'foreign',?,'indeed','abcdabcdabcdabcd','https://uk.indeed.com/viewjob?jk=abcdabcdabcdabcd',?,?)`)
    .run(crypto.randomUUID(), foreignOpportunity, now, now);

  const second = service.start({ savedSearchId: search.id });
  const ats = {
    ...origin,
    provider: 'greenhouse',
    key: 'boards.greenhouse.io/aecom/jobs/1234567',
    discoveredUrl: `${canonical}?utm_source=search`,
  };
  expect(jobReference(ats.discoveredUrl)).toBe(jobReference(canonical));
  identity.observe(second.id, ats, now);
  identity.observe(
    second.id,
    {
      ...ats,
      key: 'legacy-url-alias',
      discoveredUrl: `${canonical}?utm_campaign=other`,
    },
    now,
  );
  identity.observe(
    second.id,
    {
      ...origin,
      provider: 'indeed',
      key: 'abcdabcdabcdabcd',
      discoveredUrl: 'https://uk.indeed.com/viewjob?jk=abcdabcdabcdabcd',
    },
    now,
  );
  expect(service.get({ id: second.id }).stats).toMatchObject({
    inspectedCandidates: 3,
    newCandidates: 1,
  });
  const attached = storage.db
    .prepare(`SELECT opportunity_id FROM job_opportunity_sources
    WHERE profile_id='local' AND provider='greenhouse'`)
    .all() as Array<{ opportunity_id: string }>;
  expect(attached).toHaveLength(2);
  expect(attached.every((item) => item.opportunity_id === opportunityId)).toBe(
    true,
  );
  expect(storage.db.pragma('foreign_key_check')).toEqual([]);
});
