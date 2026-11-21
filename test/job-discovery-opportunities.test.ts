import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { OpportunitiesRepository } from '../src/main/modules/job-discovery/opportunities.repository';
import { OpportunitiesService } from '../src/main/modules/job-discovery/opportunities.service';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { newJobDiscoveryConfiguration } from '../src/shared/contracts';

let storage: Storage;
let directory: string;
afterEach(() => {
  storage?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

it('pages opportunity identities across runs and sources, preserving decisions and evidence boundaries', () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-review-'));
  storage = openStorage(directory);
  const repo = new DiscoveryRunsRepository(storage.db);
  const opportunities = new OpportunitiesService(
    new OpportunitiesRepository(storage.db),
  );
  const searches = new SavedSearchesService(
    new SavedSearchesRepository(storage.db),
  );
  const config = newJobDiscoveryConfiguration();
  config.name = 'Review fixture';
  config.intent.targetRoles = ['Engineer'];
  const saved = searches.create({ config });
  const runs = new DiscoveryRunsService(repo, searches);
  const first = runs.start({ savedSearchId: saved.id });
  const observe = (runId: string, key: string, at: string) =>
    repo.observe(
      runId,
      {
        provider: 'linkedin',
        key,
        discoveredUrl: `https://www.linkedin.com/jobs/view/${key}`,
        collectionUrl: null,
        title: `Role ${key}`,
        company: null,
        location: null,
        postingAge: null,
      },
      at,
    );
  const at = '2026-01-01T00:00:00.000Z';
  const a = observe(first.id, '100', at)!;
  const b = observe(first.id, '200', at)!;
  repo.finish(first.id, 'completed', at);
  opportunities.decide({ opportunityId: a.id, decision: 'saved' });
  const second = runs.start({ savedSearchId: saved.id });
  expect(observe(second.id, '100', '2026-01-02T00:00:00.000Z')).toBeNull();
  expect(opportunities.list({ decision: 'all' }).items).toHaveLength(2);
  const page = opportunities.list({ decision: 'all', limit: 1 });
  expect(page.nextCursor).toBeTruthy();
  expect(
    opportunities.list({ decision: 'all', limit: 1, cursor: page.nextCursor! })
      .items[0].opportunityId,
  ).not.toBe(page.items[0].opportunityId);
  expect(() =>
    opportunities.list({ decision: 'saved', cursor: page.nextCursor! }),
  ).toThrow();

  expect(opportunities.get({ opportunityId: a.id })).toMatchObject({
    verifiedCaptureId: null,
    extraction: null,
    match: null,
    postingText: null,
  });
  const capture = repo.capture(
    b,
    {
      requestedUrl: 'https://acme.example/role',
      url: 'https://acme.example/role',
      title: 'Role 200',
      status: 200,
      html: '<main>Evidence</main>',
      text: 'Verified role text',
      providerId: 'fixture',
      browserId: 'fixture',
      truncated: { html: false, text: false },
    },
    at,
  )!;
  // A saved capture alone is not a verified posting.
  expect(
    opportunities.get({ opportunityId: b.id }).verifiedCaptureId,
  ).toBeNull();
  repo.resolutionResult(
    first.id,
    b.sourceId,
    'verified',
    { captureId: capture },
    'https://acme.example/role',
    at,
  );
  expect(opportunities.get({ opportunityId: b.id })).toMatchObject({
    verifiedCaptureId: capture,
    postingText: 'Verified role text',
    extractionStatus: 'missing',
  });
  opportunities.decide({ opportunityId: a.id, decision: 'dismissed' });
  expect(
    opportunities.list({}).items.map((item) => item.opportunityId),
  ).toEqual([b.id]);
  expect(
    opportunities.list({ decision: 'dismissed' }).items[0].opportunityId,
  ).toBe(a.id);
  opportunities.decide({ opportunityId: a.id, decision: 'new' });
  expect(opportunities.list({}).items).toHaveLength(2);
  expect(
    opportunities.decide({ opportunityId: a.id, decision: 'new' }).decision,
  ).toBe('new');
  expect(() =>
    opportunities.get({ opportunityId: crypto.randomUUID() }),
  ).toThrow();

  storage.close();
  storage = openStorage(directory);
  expect(
    new OpportunitiesService(new OpportunitiesRepository(storage.db)).list({})
      .items,
  ).toHaveLength(2);
});
