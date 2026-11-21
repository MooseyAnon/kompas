import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { OpportunitiesService } from '../src/main/modules/job-discovery/opportunities.service';
import { OpportunitiesRepository } from '../src/main/modules/job-discovery/opportunities.repository';
import { assessSnapshot } from '../src/main/modules/job-discovery/handoff-snapshot';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { ApplicationsRepository } from '../src/main/modules/applications/applications.repository';
import { ApplicationsService } from '../src/main/modules/applications/applications.service';
import { IdentityRepository } from '../src/main/modules/identity/identity.repository';
import { IdentityService } from '../src/main/modules/identity/identity.service';
import {
  newJobDiscoveryConfiguration,
  type PageReadResult,
  type ExtractedJd,
} from '../src/shared/contracts';

let dir: string;
let storage: Storage;
afterEach(() => {
  storage?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-handoff-'));
  storage = openStorage(dir);
  const repo = new DiscoveryRunsRepository(storage.db);
  const searches = new SavedSearchesService(
    new SavedSearchesRepository(storage.db),
  );
  const apps = new ApplicationsService(new ApplicationsRepository(storage.db), {
    getMetadata: () => null,
  });
  const identity = new IdentityService(new IdentityRepository(storage.db));
  const config = newJobDiscoveryConfiguration();
  config.name = 'Engineering roles';
  config.intent.targetRoles = ['Engineer'];
  const saved = searches.create({ config });
  const runs = new DiscoveryRunsService(
    repo,
    searches,
    undefined,
    undefined,
    undefined,
    undefined,
    identity,
    apps,
  );
  const run = runs.start({ savedSearchId: saved.id });
  const admit = (n: number) => {
    repo.observe(
      run.id,
      {
        provider: 'linkedin',
        key: String(n),
        discoveredUrl: `https://www.linkedin.com/jobs/view/${n}`,
        collectionUrl: null,
        title: `Engineer ${n}`,
        company: 'Acme',
        location: 'London',
        postingAge: null,
      },
      new Date().toISOString(),
    );
    return runs
      .candidates({ id: run.id })
      .find((candidate) => candidate.sourceKey === String(n))!;
  };
  const verify = (sourceId: string, text: string, blocks = true) => {
    const candidate = runs
      .candidates({ id: run.id })
      .find((c) => c.sourceId === sourceId)!;
    const url = `https://acme.example/jobs/${candidate.sourceKey}`;
    const page: PageReadResult = {
      requestedUrl: url,
      url,
      title: candidate.title,
      status: 200,
      html: '<main>Fixture</main>',
      text,
      providerId: 'fake',
      browserId: 'fake',
      truncated: { html: false, text: false },
      ...(blocks
        ? {
            structured: {
              schemaVersion: 1,
              url,
              title: candidate.title,
              scripts: [],
              stylesheets: [],
              content: {
                blocks: [
                  { type: 'heading', level: 1, text: candidate.title },
                  { type: 'paragraph', text: 'Requires Python and SQL' },
                ],
              },
              truncated: false,
            },
          }
        : {}),
    };
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
    const jd: ExtractedJd = {
      schemaVersion: 1,
      classification: 'job_description',
      title: null,
      company: null,
      location: null,
      responsibilities: [],
      requiredSkills: ['Python', 'SQL', 'Git'].map((skill) => ({
        text: skill,
        evidence: skill,
      })),
      preferredSkills: [],
      educationRequirements: [],
      minimumYearsExperience: null,
      seniority: null,
      estimatedExperienceBand: null,
      employmentType: null,
      workArrangement: null,
      salaryText: null,
      inferences: [],
    };
    repo.finishExtraction(
      run.id,
      sourceId,
      attempt.id,
      {
        jd,
        provenance: {
          providerId: 'mock',
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
    return page;
  };
  return { repo, runs, apps, identity, runId: run.id, admit, verify };
}

it('keeps ten admissions, review decisions, matching and trusted handoff durable through restart', async () => {
  const { repo, runs, apps, identity, runId, admit, verify } = setup();
  const candidates = Array.from({ length: 10 }, (_, i) => admit(i + 1));
  repo.observe(
    runId,
    {
      provider: 'linkedin',
      key: '11',
      discoveredUrl: 'https://www.linkedin.com/jobs/view/11',
      collectionUrl: null,
      title: 'Engineer 11',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date().toISOString(),
  );
  expect(runs.get({ id: runId }).stats).toMatchObject({
    newCandidates: 10,
    inspectedCandidates: 10,
  });
  repo.finish(runId, 'completed', new Date().toISOString());
  const original = verify(
    candidates[0].sourceId,
    'Engineer at Acme. Requires Python and SQL. <script>inert</script>',
  );
  identity.replaceConfirmedSkills({ names: ['Python', 'Git'] });
  expect(
    runs
      .refreshMatches({ id: runId })
      .find((m) => m.opportunityId === candidates[0].id)?.coverage,
  ).toBe(2 / 3);
  runs.decide({
    id: runId,
    sourceId: candidates[1].sourceId,
    decision: 'dismissed',
  });
  expect(() =>
    runs.track({
      id: runId,
      sourceId: candidates[1].sourceId,
      confirmUnverified: true,
      withoutSnapshot: true,
    }),
  ).toThrow();
  runs.decide({ id: runId, sourceId: candidates[1].sourceId, decision: 'new' });
  expect(() =>
    runs.track({
      id: runId,
      sourceId: candidates[1].sourceId,
      confirmUnverified: false,
      withoutSnapshot: true,
    }),
  ).toThrow();
  const unverified = runs.track({
    id: runId,
    sourceId: candidates[1].sourceId,
    confirmUnverified: true,
    withoutSnapshot: true,
  });
  expect(apps.get(unverified.applicationId!).snapshot).toBeNull();
  expect(
    apps.get(unverified.applicationId!).application.currentStage.stageKind,
  ).toBe('saved');
  expect(
    runs
      .reviews({ id: runId })
      .find((item) => item.sourceId === candidates[0].sourceId)?.snapshot,
  ).toBe('available');
  const tracked = runs.track({
    id: runId,
    sourceId: candidates[0].sourceId,
    confirmUnverified: false,
    withoutSnapshot: false,
  });
  expect(apps.get(tracked.applicationId!).snapshot).toMatchObject({
    source: 'web',
    sourceUrl: original.url,
    descriptionText: original.text,
    contentBlocks: [
      { type: 'heading', text: candidates[0].title },
      { type: 'paragraph', text: 'Requires Python and SQL' },
    ],
  });
  expect(
    runs.track({
      id: runId,
      sourceId: candidates[0].sourceId,
      confirmUnverified: false,
      withoutSnapshot: false,
    }).applicationId,
  ).toBe(tracked.applicationId);
  storage.close();
  storage = openStorage(dir);
  const reopened = new DiscoveryRunsRepository(storage.db);
  expect(reopened.review(runId, candidates[0].sourceId)?.applicationId).toBe(
    tracked.applicationId,
  );
  expect(reopened.review(runId, candidates[1].sourceId)?.decision).toBe(
    'saved',
  );
  expect(
    reopened.matches(runId).find((m) => m.opportunityId === candidates[0].id)
      ?.coverage,
  ).toBe(2 / 3);
  expect(storage.db.pragma('foreign_key_check')).toEqual([]);
  expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('applies by immutable opportunity ID as Pending, preserves the snapshot, and reopens later stages', () => {
  const { repo, runs, apps, runId, admit, verify } = setup();
  const candidate = admit(1);
  repo.finish(runId, 'completed', new Date().toISOString());
  const original = verify(
    candidate.sourceId,
    'Original complete JD for Engineer at Acme.',
  );
  const opportunity = new OpportunitiesService(
    new OpportunitiesRepository(storage.db),
  );
  const preview = runs.applyPreview(candidate.id);
  expect(preview).toMatchObject({
    snapshot: 'available',
    unverified: false,
    manualMatchId: null,
  });
  expect(
    opportunity.get({ opportunityId: candidate.id }).applicationId,
  ).toBeNull();
  const input = {
    opportunityId: candidate.id,
    confirmUnverified: false,
    withoutSnapshot: false,
    allowDuplicate: false,
  };
  const id = runs.apply(input);
  expect(apps.get(id).application.currentStage).toMatchObject({
    stageLabel: 'Pending',
    stageKind: 'saved',
  });
  expect(apps.get(id).snapshot).toMatchObject({
    descriptionText: original.text,
    source: 'web',
    sourceUrl: original.url,
  });
  expect(opportunity.get({ opportunityId: candidate.id }).applicationId).toBe(
    id,
  );
  apps.record({
    applicationId: id,
    stageKind: 'interview',
    stageLabel: 'Interviewing',
  });
  expect(runs.apply(input)).toBe(id);
  expect(apps.get(id).application.currentStage.stageLabel).toBe('Interviewing');
  expect(
    storage.db
      .prepare(
        'SELECT count(*) AS n FROM job_applications WHERE discovery_opportunity_id=?',
      )
      .get(candidate.id),
  ).toEqual({ n: 1 });
});

it('requires explicit choices for missing evidence and exact manual duplicates', () => {
  const { repo, runs, apps, runId, admit, verify } = setup();
  const unverified = admit(1);
  const oversized = admit(2);
  const duplicate = admit(3);
  repo.finish(runId, 'completed', new Date().toISOString());
  verify(oversized.sourceId, 'Large JD '.repeat(7000));
  verify(duplicate.sourceId, 'Engineer at Acme. Complete JD.');
  const noSnapshot = {
    opportunityId: unverified.id,
    confirmUnverified: true,
    withoutSnapshot: true,
    allowDuplicate: false,
  };
  expect(() =>
    runs.apply({ ...noSnapshot, confirmUnverified: false }),
  ).toThrow();
  expect(() => runs.apply({ ...noSnapshot, withoutSnapshot: false })).toThrow();
  expect(runs.applyPreview(unverified.id)).toMatchObject({
    unverified: true,
    snapshot: 'no_verified_jd',
  });
  expect(apps.findByDiscoveryOpportunity(unverified.id)).toBeNull();
  const unverifiedId = runs.apply(noSnapshot);
  expect(apps.get(unverifiedId).snapshot).toBeNull();
  expect(apps.get(unverifiedId).application.currentStage.stageLabel).toBe(
    'Pending',
  );
  expect(runs.applyPreview(oversized.id).snapshot).toBe('too_large');
  expect(() =>
    runs.apply({
      opportunityId: oversized.id,
      confirmUnverified: false,
      withoutSnapshot: false,
      allowDuplicate: false,
    }),
  ).toThrow();
  const manual = apps.create({
    companyName: 'Acme',
    roleTitle: 'Engineer',
    jobUrl: `https://acme.example/jobs/${duplicate.sourceKey}`,
    initialStage: { stageKind: 'applied', stageLabel: 'Applied' },
  });
  expect(runs.applyPreview(duplicate.id).manualMatchId).toBe(
    manual.application.id,
  );
  const input = {
    opportunityId: duplicate.id,
    confirmUnverified: false,
    withoutSnapshot: false,
    allowDuplicate: false,
  };
  expect(() => runs.apply(input)).toThrow(/exact job reference/);
  const separate = runs.apply({ ...input, allowDuplicate: true });
  expect(separate).not.toBe(manual.application.id);
  expect(
    apps.get(manual.application.id).application.currentStage.stageLabel,
  ).toBe('Applied');
  expect(runs.apply(input)).toBe(separate);
});

it('recovers an app created before Discovery link; concurrent calls never duplicate', async () => {
  const { repo, runs, apps, runId, admit, verify } = setup();
  const candidate = admit(1);
  repo.finish(runId, 'completed', new Date().toISOString());
  verify(candidate.sourceId, 'Acme Engineer. Requires Python and SQL.');
  const link = repo.linkApplication.bind(repo);
  vi.spyOn(repo, 'linkApplication').mockImplementationOnce(() => {
    throw new Error('injected link failure');
  });
  expect(() =>
    runs.track({
      id: runId,
      sourceId: candidate.sourceId,
      confirmUnverified: false,
      withoutSnapshot: false,
    }),
  ).toThrow('injected link failure');
  const created = apps.findByDiscoveryOpportunity(candidate.id)!;
  expect(created.snapshot?.source).toBe('web');
  expect(repo.review(runId, candidate.sourceId)?.applicationId).toBeNull();
  vi.mocked(repo.linkApplication).mockImplementation(link);
  storage.close();
  storage = openStorage(dir);
  const reopenedRepo = new DiscoveryRunsRepository(storage.db);
  const reopenedApps = new ApplicationsService(
    new ApplicationsRepository(storage.db),
    { getMetadata: () => null },
  );
  const reopenedRuns = new DiscoveryRunsService(
    reopenedRepo,
    new SavedSearchesService(new SavedSearchesRepository(storage.db)),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reopenedApps,
  );
  const input = {
    id: runId,
    sourceId: candidate.sourceId,
    confirmUnverified: false,
    withoutSnapshot: false,
  };
  expect(reopenedRuns.track(input).applicationId).toBe(created.application.id);
  expect(
    (
      await Promise.all([
        Promise.resolve().then(() => reopenedRuns.track(input)),
        Promise.resolve().then(() => reopenedRuns.track(input)),
      ])
    ).map((r) => r.applicationId),
  ).toEqual([created.application.id, created.application.id]);
  expect(
    storage.db
      .prepare(
        'SELECT count(*) AS n FROM job_applications WHERE discovery_opportunity_id=?',
      )
      .get(candidate.id),
  ).toEqual({ n: 1 });
  expect(() =>
    storage.db
      .prepare(`INSERT INTO job_applications
    (id,profile_id,company_name,role_title,created_at,updated_at,discovery_opportunity_id)
    VALUES (?,'local','Duplicate','Role',?,?,?)`)
      .run(
        crypto.randomUUID(),
        new Date().toISOString(),
        new Date().toISOString(),
        candidate.id,
      ),
  ).toThrow();
  expect(() =>
    reopenedApps.capture(created.application.id, {
      ...created.snapshot!,
      descriptionText: 'overwrite',
    }),
  ).toThrow();
});

it('refuses oversized/incomplete snapshots without losing raw evidence; validates IPC authority', async () => {
  const { repo, runs, apps, runId, admit, verify } = setup();
  const large = admit(1);
  const missing = admit(2);
  repo.finish(runId, 'completed', new Date().toISOString());
  verify(large.sourceId, 'Large JD '.repeat(7000));
  expect(
    runs.reviews({ id: runId }).find((item) => item.sourceId === large.sourceId)
      ?.snapshot,
  ).toBe('too_large');
  expect(
    repo.verifiedCapture(runId, large.sourceId)?.rawReadPage.text.length,
  ).toBeGreaterThan(48000);
  expect(() =>
    runs.track({
      id: runId,
      sourceId: large.sourceId,
      confirmUnverified: false,
      withoutSnapshot: false,
    }),
  ).toThrow();
  const tracked = runs.track({
    id: runId,
    sourceId: large.sourceId,
    confirmUnverified: false,
    withoutSnapshot: true,
  });
  expect(apps.get(tracked.applicationId!).snapshot).toBeNull();
  expect(
    runs
      .reviews({ id: runId })
      .find((item) => item.sourceId === missing.sourceId)?.snapshot,
  ).toBe('no_verified_jd');
  const dispatcher = createAppDispatcher({
    getAppVersion: () => 'test',
    isStorageReady: () => true,
    storage,
    documentsPlatform: { pickFile: async () => null, openPath: async () => '' },
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
    await send('jobDiscovery', 'runs.track', {
      id: runId,
      sourceId: missing.sourceId,
      confirmUnverified: true,
      withoutSnapshot: true,
      snapshot: { source: 'web' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(
    await send('applications', 'create', {
      companyName: 'Fake',
      roleTitle: 'Engineer',
      snapshot: {
        schemaVersion: 1,
        source: 'web',
        sourceUrl: null,
        capturedAt: new Date().toISOString(),
        descriptionText: 'spoof',
      },
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  const reviews = await send('jobDiscovery', 'runs.reviews', { id: runId });
  expect(
    await send('jobDiscovery', 'opportunities.apply', {
      opportunityId: missing.id,
      confirmUnverified: true,
      withoutSnapshot: true,
      allowDuplicate: false,
      jobUrl: 'https://forged.example/job',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(
    await send('jobDiscovery', 'opportunities.apply.preview', {
      opportunityId: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(reviews).toMatchObject({ ok: true });
  if (reviews.ok) {
    const items = reviews.data as { items: Array<{ snapshot: string }> };
    expect(items.items.map((item) => item.snapshot).sort()).toEqual([
      'no_verified_jd',
      'too_large',
    ]);
  }
  expect(
    await send('jobDiscovery', 'runs.decide', {
      id: runId,
      sourceId: missing.sourceId,
      decision: 'applied',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(
    await send('jobDiscovery', 'runs.track', {
      id: crypto.randomUUID(),
      sourceId: missing.sourceId,
      confirmUnverified: true,
      withoutSnapshot: true,
    }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  const foreign = crypto.randomUUID();
  const at = new Date().toISOString();
  storage.db
    .prepare(
      'INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES (?,?,?,?)',
    )
    .run(foreign, '', at, at);
  expect(() =>
    storage.db
      .prepare(`INSERT INTO job_applications
    (id,profile_id,company_name,role_title,created_at,updated_at,discovery_opportunity_id)
    VALUES (?,?,'Foreign','Role',?,?,?)`)
      .run(crypto.randomUUID(), foreign, at, at, large.id),
  ).toThrow(/owner mismatch/);
});

it('uses UTF-8 bytes at the Pack 012 boundary and refuses loss of ordered blocks', () => {
  const { repo, runs, runId, admit, verify } = setup();
  const candidate = admit(1);
  repo.finish(runId, 'completed', new Date().toISOString());
  verify(candidate.sourceId, 'Original engineer JD');
  const capture = repo.verifiedCapture(runId, candidate.sourceId)!;
  const extracted = runs.candidates({ id: runId })[0];
  const base = assessSnapshot(extracted, capture, true);
  expect(base.status).toBe('available');
  if (base.status !== 'available') return;
  const room =
    48 * 1024 - new TextEncoder().encode(JSON.stringify(base.snapshot)).length;
  const atLimit = {
    ...capture,
    rawReadPage: {
      ...capture.rawReadPage,
      text: `${capture.rawReadPage.text}${'é'.repeat(Math.floor(room / 2))}${room % 2 ? 'x' : ''}`,
    },
  };
  expect(assessSnapshot(extracted, atLimit, true).status).toBe('available');
  expect(
    assessSnapshot(
      extracted,
      {
        ...atLimit,
        rawReadPage: {
          ...atLimit.rawReadPage,
          text: `${atLimit.rawReadPage.text}é`,
        },
      },
      true,
    ).status,
  ).toBe('too_large');
  const structured = capture.rawReadPage.structured!;
  expect(
    assessSnapshot(
      extracted,
      {
        ...capture,
        rawReadPage: {
          ...capture.rawReadPage,
          structured: { ...structured, truncated: true },
        },
      },
      true,
    ).status,
  ).toBe('incomplete');
  expect(
    assessSnapshot(
      extracted,
      {
        ...capture,
        rawReadPage: {
          ...capture.rawReadPage,
          structured: {
            ...structured,
            content: {
              blocks: [
                ...structured.content.blocks,
                { type: 'table', rows: [['A', 'B']] },
              ],
            },
          },
        },
      },
      true,
    ).status,
  ).toBe('incomplete');
});

it('executes a bounded fake Web discovery end-to-end before review and restart', async () => {
  const { repo, runId, identity, apps, verify } = setup();
  const searches = new SavedSearchesService(
    new SavedSearchesRepository(storage.db),
  );
  const web = {
    search: vi.fn(async () => ({
      providerId: 'fixture',
      results: Array.from({ length: 12 }, (_, i) => ({
        title: `Engineer ${i}`,
        url: `https://www.linkedin.com/jobs/view/engineer-${10000000 + i}`,
        rank: i + 1,
      })),
    })),
    readPage: vi.fn(),
  };
  const runs = new DiscoveryRunsService(
    repo,
    searches,
    undefined,
    web as never,
    undefined,
    undefined,
    identity,
    apps,
  );
  const finished = await runs.execute({ id: runId });
  expect(finished.stats).toMatchObject({
    inspectedCandidates: 10,
    newCandidates: 10,
  });
  expect(web.search).toHaveBeenCalledTimes(1);
  expect(web.readPage).not.toHaveBeenCalled();
  const candidates = runs.candidates({ id: runId });
  expect(candidates).toHaveLength(10);
  verify(candidates[0].sourceId, 'Original engineer JD');
  runs.decide({
    id: runId,
    sourceId: candidates[1].sourceId,
    decision: 'dismissed',
  });
  const tracked = runs.track({
    id: runId,
    sourceId: candidates[0].sourceId,
    confirmUnverified: false,
    withoutSnapshot: false,
  });
  storage.close();
  storage = openStorage(dir);
  expect(
    new DiscoveryRunsRepository(storage.db).review(
      runId,
      candidates[1].sourceId,
    )?.decision,
  ).toBe('dismissed');
  expect(
    new ApplicationsService(new ApplicationsRepository(storage.db), {
      getMetadata: () => null,
    }).findByDiscoveryOpportunity(candidates[0].id)?.application.id,
  ).toBe(tracked.applicationId);
});
