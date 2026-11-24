import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { openConnection } from '../src/main/core/db/connection';
import { runMigrations } from '../src/main/core/db/migrator';
import { MIGRATIONS } from '../src/main/core/db/migrations';
import { seedLocalProfile } from '../src/main/core/db/database';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { verifyJobDescription } from '../src/main/modules/job-discovery/jd-verifier';
import { normalizePage } from '../src/main/modules/web/page-normalizer';
import { createAppDispatcher } from '../src/main/core/registry';
import { WebError } from '../src/main/modules/web/web.error';
import {
  newJobDiscoveryConfiguration,
  type PageReadResult,
} from '../src/shared/contracts';

let dir: string;
let storage: Storage;
let repo: DiscoveryRunsRepository;
let searches: SavedSearchesService;
let now: number;
const source =
  'https://uk.linkedin.com/jobs/view/engineer-12345678?trk=original';
const canonical = 'https://boards.greenhouse.io/acme/jobs/3456789';
const description =
  'Acme is hiring an Engineering Intern in London. Responsibilities include developing software, writing reliable tests and collaborating with the team. Requirements include programming experience and clear communication with colleagues.';
const page = (url = canonical, text = description): PageReadResult => ({
  requestedUrl: url,
  url,
  title: 'Engineering Intern - Acme',
  status: 200,
  html: '<main>Job</main>',
  text,
  providerId: 'playwright',
  browserId: 'chrome',
  truncated: { html: false, text: false },
});
const web = (
  search: (query: string) => string[],
  read: (url: string) => PageReadResult,
) => ({
  search: async (query: string) => ({
    providerId: 'fake',
    results: search(query).map((url, i) => ({
      title: 'Job',
      url,
      rank: i + 1,
    })),
  }),
  readPage: async (url: string) => read(url),
});
function run(
  configure: (
    config: ReturnType<typeof newJobDiscoveryConfiguration>,
  ) => void = () => {},
  observation: {
    title?: string;
    company?: string;
    location?: string | null;
  } = {},
) {
  const config = newJobDiscoveryConfiguration();
  config.name = 'Placements';
  config.intent.targetRoles = ['Engineering Intern'];
  configure(config);
  const saved = searches.create({ config });
  const service = new DiscoveryRunsService(repo, searches, () => new Date(now));
  const started = service.start({ savedSearchId: saved.id });
  repo.observe(
    started.id,
    {
      provider: 'linkedin',
      key: '12345678',
      discoveredUrl: source,
      collectionUrl: 'https://uk.linkedin.com/jobs/search/',
      title: observation.title ?? 'Engineering Intern',
      company: observation.company ?? 'Acme',
      location:
        observation.location === undefined ? 'London' : observation.location,
      postingAge: null,
    },
    new Date(now).toISOString(),
  );
  repo.finish(started.id, 'completed', new Date(now).toISOString());
  return {
    id: started.id,
    candidate: service.candidates({ id: started.id })[0],
  };
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resolution-'));
  storage = openStorage(dir);
  repo = new DiscoveryRunsRepository(storage.db);
  searches = new SavedSearchesService(new SavedSearchesRepository(storage.db));
  now = Date.now();
});
afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('reads search hits in engine order, including ATS hits before an employer posting', async () => {
  const role = '2027 Software Dev Engineer Intern - United Kingdom';
  const employerUrl =
    'https://careers.fable.example/jobs/123456/software-dev-engineer-intern';
  const atsUrls = [
    'https://boards.greenhouse.io/other/jobs/111111',
    'https://jobs.lever.co/other/11111111-1111-4111-8111-111111111111',
    'https://other.myworkdayjobs.com/en-US/jobs/111111',
  ];
  const { id, candidate } = run(
    (config) => {
      config.run.maxTargetedSearchesPerCandidate = 1;
    },
    {
      title: `${role} · Fable UK Services`,
      company: 'Fable UK Services',
      location: 'United Kingdom',
    },
  );
  const searchesMade: string[] = [];
  const readUrls: string[] = [];
  const employerPage: PageReadResult = {
    ...page(
      employerUrl,
      `Fable is hiring a ${role}. Responsibilities include developing and testing software at scale, working across engineering teams, and delivering services to customers in the United Kingdom.`,
    ),
    title: `${role} | Fable`,
  };
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async (query) => {
        searchesMade.push(query);
        return {
          providerId: 'fake',
          results: [
            atsUrls[0],
            atsUrls[0],
            atsUrls[1],
            employerUrl,
            atsUrls[2],
          ].map((url, index) => ({
            url,
            title: role,
            rank: index + 1,
          })),
        };
      },
      readPage: async (url) => {
        readUrls.push(url);
        return url === employerUrl
          ? employerPage
          : page(url, description.replace('Acme', 'Other'));
      },
    },
  );
  expect((await service.resolve({ id }))[0]).toMatchObject({
    canonicalUrl: employerUrl,
    discoveredUrl: source,
    resolutionReason: 'verified',
  });
  expect(readUrls).toEqual([...atsUrls.slice(0, 2), employerUrl, atsUrls[2]]);
  expect(searchesMade).toHaveLength(1);
  expect(searchesMade[0]).toContain(`${role} Fable UK Services`);
  expect(searchesMade[0]).not.toContain('site:');
  expect(service.get({ id }).stats.targetedPagesRead).toBe(4);
  const evidence = storage.db
    .prepare(
      'SELECT resolution_evidence_json FROM job_opportunities WHERE id=?',
    )
    .get(candidate.id) as { resolution_evidence_json: string };
  expect(JSON.parse(evidence.resolution_evidence_json)).toMatchObject({
    companyBasis: 'employer_brand',
    company: true,
    title: true,
  });
  expect(
    verifyJobDescription(
      { ...employerPage, title: 'Accountant | Fable' },
      candidate,
    ).kind,
  ).not.toBe('job_description');
  expect(
    verifyJobDescription(
      {
        ...employerPage,
        text: employerPage.text.replaceAll('Fable', 'Other'),
      },
      candidate,
    ).kind,
  ).not.toBe('job_description');
});

it('retains exact submitted queries and ordered read/skip decisions without redoing work on inspection', async () => {
  const { id, candidate } = run();
  const mismatch = 'https://boards.greenhouse.io/other/jobs/123';
  const directory = 'https://careers.acme.example/directory';
  const skipped = 'https://careers.acme.example/another';
  const search = vi.fn(async (query: string) => ({
    providerId: 'fake',
    results: (query.endsWith('careers')
      ? [canonical]
      : [mismatch, mismatch, directory, skipped]
    ).map((url, index) => ({ url, title: 'Job', rank: index + 1 })),
  }));
  const readPage = vi.fn(async (url: string) =>
    url === mismatch || url === canonical
      ? page(
          url,
          url === mismatch
            ? description.replaceAll('Acme', 'Other')
            : description,
        )
      : page(
          url,
          'Acme Engineering Intern London. Browse all the Acme Engineering Intern openings.',
        ),
  );
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    { search, readPage },
  );
  await service.resolve({ id });
  const detail = service.resolutionDiagnostics({
    id,
    sourceId: candidate.sourceId,
  });
  expect(detail).toMatchObject({
    source: {
      provider: 'linkedin',
      discoveredUrl: source,
      opportunityId: candidate.id,
    },
    totalAttempts: 1,
    attempts: [
      {
        sequence: 1,
        status: 'completed',
        reason: 'verified',
        searches: [
          {
            ordinal: 1,
            status: 'completed',
            results: [
              {
                url: mismatch,
                disposition: 'rejected',
                reason: 'identity_mismatch',
              },
              { url: mismatch, disposition: 'not_opened', reason: 'duplicate' },
              {
                url: directory,
                disposition: 'rejected',
                reason: 'not_job_description',
              },
              {
                url: skipped,
                disposition: 'rejected',
                reason: 'not_job_description',
              },
            ],
          },
          {
            ordinal: 2,
            status: 'completed',
            results: [
              { url: canonical, disposition: 'accepted', reason: null },
            ],
          },
        ],
      },
    ],
  });
  expect(detail.attempts[0].searches.map((item) => item.query)).toEqual(
    search.mock.calls.map(([query]) => query),
  );
  const capture = service.captures({ id, sourceId: candidate.sourceId });
  expect(detail.attempts[0].searches[1].results[0].captureId).toBe(
    capture.find((item) => item.sourceUrl === canonical)?.id,
  );
  const before = storage.db
    .prepare('SELECT count(*) AS n FROM job_resolution_results')
    .get();
  expect(
    service.resolutionDiagnostics({ id, sourceId: candidate.sourceId }),
  ).toEqual(detail);
  expect(
    storage.db
      .prepare('SELECT count(*) AS n FROM job_resolution_results')
      .get(),
  ).toEqual(before);
  expect(search).toHaveBeenCalledTimes(2);
  expect(readPage).toHaveBeenCalledTimes(4);
  const telemetry = JSON.stringify(
    storage.db.prepare('SELECT * FROM operation_runs').all(),
  );
  expect(telemetry).not.toContain(detail.attempts[0].searches[0].query);
  expect(telemetry).not.toContain(canonical);
});

it('does not mark unread budget/policy/duplicates as rejected and enforces SQL caps', async () => {
  const { id, candidate } = run((config) => {
    config.run.maxTargetedSearchesPerCandidate = 1;
  });
  const urls = Array.from(
    { length: 20 },
    (_, index) => `https://careers.acme.example/job/${index}`,
  );
  const read = vi.fn(async (url: string) =>
    page(url, 'Search careers at Acme.'),
  );
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async () => ({
        providerId: 'fake',
        results: urls.map((url, index) => ({
          url,
          title: 'Job',
          rank: index + 1,
        })),
      }),
      readPage: read,
    },
  );
  await service.resolve({ id });
  const results = service.resolutionDiagnostics({
    id,
    sourceId: candidate.sourceId,
  }).attempts[0].searches[0].results;
  expect(results).toHaveLength(20);
  expect(results.slice(0, 5).map((item) => item.disposition)).toEqual(
    Array(5).fill('rejected'),
  );
  expect(
    results
      .slice(5)
      .every(
        (item) => item.disposition === 'not_opened' && item.reason === 'budget',
      ),
  ).toBe(true);
  expect(read).toHaveBeenCalledTimes(5);
  const searchId = (
    storage.db.prepare('SELECT id FROM job_resolution_searches').get() as {
      id: string;
    }
  ).id;
  expect(() =>
    storage.db
      .prepare(`INSERT INTO job_resolution_results
    (id,search_id,ordinal,url,disposition) VALUES (?,?,?,?, 'seen')`)
      .run(crypto.randomUUID(), searchId, 21, canonical),
  ).toThrow();
  expect(() =>
    storage.db
      .prepare(`INSERT INTO job_resolution_results
    (id,search_id,ordinal,url,disposition) VALUES (?,?,?,?, 'seen')`)
      .run(crypto.randomUUID(), searchId, 1, 'x'.repeat(2049)),
  ).toThrow();
  expect(storage.db.pragma('foreign_key_check')).toEqual([]);
});

it('records failed search codes, empty results and real unavailable page outcomes', async () => {
  const { id, candidate } = run();
  let count = 0;
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async () => {
        count++;
        if (count === 1) throw new WebError('RATE_LIMITED');
        return {
          providerId: 'fake',
          results: [{ url: canonical, title: 'Job', rank: 1 }],
        };
      },
      readPage: async () => {
        throw new WebError('BROWSER_UNAVAILABLE');
      },
    },
  );
  await service.resolve({ id });
  expect(
    service.resolutionDiagnostics({ id, sourceId: candidate.sourceId })
      .attempts[0],
  ).toMatchObject({
    status: 'completed',
    reason: 'page_unavailable',
    searches: [
      { status: 'failed', errorCode: 'RATE_LIMITED', results: [] },
      {
        status: 'completed',
        results: [
          { disposition: 'read_failed', reason: 'BROWSER_UNAVAILABLE' },
        ],
      },
    ],
  });
});

it('distinguishes a zero-search budget from a searched candidate with no results', async () => {
  const { id, candidate } = run((config) => {
    config.run.maxTargetedSearchesPerCandidate = 0;
  });
  const search = vi.fn(async () => ({ providerId: 'fake', results: [] }));
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search,
      readPage: async () => {
        throw new Error('unexpected read');
      },
    },
  );
  await service.resolve({ id });
  expect(search).not.toHaveBeenCalled();
  expect(
    service.resolutionDiagnostics({ id, sourceId: candidate.sourceId })
      .attempts,
  ).toMatchObject([{ reason: 'search_budget_zero', searches: [] }]);
  expect(service.candidates({ id })[0].resolutionReason).toBe('no_match');
});

it('keeps successful empty searches as completed no-match evidence', async () => {
  const { id, candidate } = run();
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async () => ({ providerId: 'fake', results: [] }),
      readPage: async () => {
        throw new Error('unexpected read');
      },
    },
  );
  await service.resolve({ id });
  expect(
    service.resolutionDiagnostics({ id, sourceId: candidate.sourceId })
      .attempts,
  ).toMatchObject([
    {
      status: 'completed',
      reason: 'no_match',
      searches: [
        { status: 'completed', errorCode: null, results: [] },
        { status: 'completed', errorCode: null, results: [] },
      ],
    },
  ]);
});

it('does not promote a fourth-ranked employer result past the three-read budget', async () => {
  const { id } = run((config) => {
    config.run.maxTargetedSearchesPerCandidate = 1;
    config.run.maxPagesPerTargetedSearch = 3;
  });
  const official = 'https://careers.acme.example/jobs/3456789';
  const others = [
    'https://boards.greenhouse.io/other/jobs/111111',
    'https://jobs.lever.co/other/11111111-1111-4111-8111-111111111111',
    'https://other.myworkdayjobs.com/en-US/jobs/111111',
  ];
  const readUrls: string[] = [];
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async () => ({
        providerId: 'fake',
        results: [...others, official].map((url, index) => ({
          url,
          title: 'Engineering Intern',
          rank: index + 1,
        })),
      }),
      readPage: async (url) => {
        readUrls.push(url);
        return page(url, description.replaceAll('Acme', 'Other'));
      },
    },
  );
  expect((await service.resolve({ id }))[0].canonicalUrl).toBeNull();
  expect(readUrls).toEqual(others);
  expect(service.get({ id }).stats.targetedPagesRead).toBe(3);
});

it('reaches a fifth-ranked official posting within the new default budget', async () => {
  const { id, candidate } = run((config) => {
    config.run.maxTargetedSearchesPerCandidate = 1;
  });
  const others = Array.from(
    { length: 4 },
    (_, index) => `https://careers.acme.example/jobs/unrelated-${index}`,
  );
  const official = 'https://careers.acme.example/jobs/engineering-intern';
  const readUrls: string[] = [];
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    web(
      () => [...others, official],
      (url) => {
        readUrls.push(url);
        return page(
          url,
          url === official ? description : 'Search careers at Acme.',
        );
      },
    ),
  );
  expect((await service.resolve({ id }))[0].canonicalUrl).toBe(official);
  expect(readUrls).toEqual([...others, official]);
  expect(service.get({ id }).stats.targetedPagesRead).toBe(5);
  expect(
    service.resolutionDiagnostics({ id, sourceId: candidate.sourceId })
      .attempts[0].searches[0].results[4].disposition,
  ).toBe('accepted');
});

it('verifies and preserves complete raw JD evidence when structured references are capped', async () => {
  const { id, candidate } = run((config) => {
    config.run.maxTargetedSearchesPerCandidate = 1;
  });
  const stylesheets = Array.from(
    { length: 41 },
    (_, index) => `<link rel="stylesheet" href="/style-${index}.css">`,
  ).join('');
  const html = `<html><head>${stylesheets}</head><body><main><h1>Engineering Intern</h1><p>${description}</p></main></body></html>`;
  const complete = {
    ...page(),
    html,
    structured: normalizePage({ url: canonical, title: page().title, html }),
  };
  expect(complete.structured.truncated).toBe(true);
  expect(complete.structured.stylesheets).toHaveLength(40);
  expect(complete.truncated).toEqual({ html: false, text: false });
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    web(
      () => [canonical],
      () => complete,
    ),
  );
  expect((await service.resolve({ id }))[0]).toMatchObject({
    canonicalUrl: canonical,
    resolutionReason: 'verified',
  });
  expect(service.get({ id }).stats.targetedPagesRead).toBe(1);
  expect(
    service.resolutionDiagnostics({ id, sourceId: candidate.sourceId })
      .attempts[0].searches[0].results[0].disposition,
  ).toBe('accepted');
  expect(
    service.captures({ id, sourceId: candidate.sourceId })[0].rawReadPage,
  ).toEqual(complete);
  for (const truncated of [
    { html: true, text: false },
    { html: false, text: true },
  ]) {
    expect(
      verifyJobDescription({ ...complete, truncated }, candidate),
    ).toMatchObject({
      kind: 'unknown',
      reason: 'page_unavailable',
    });
  }
});

it('matches a compound candidate label and a variant role heading without exact title text', async () => {
  const official =
    'https://stripe.com/careers/listing/software-engineer-intern/8031833';
  const { id, candidate } = run(() => {}, {
    title: 'Software Engineer, Intern · Stripe · London',
    company: 'Stripe',
  });
  const queries: string[] = [];
  const variant: PageReadResult = {
    ...page(
      official,
      'Stripe is hiring a Software Engineering Internship in London. Responsibilities include writing software and collaborating with engineers. Requirements include programming experience and clear communication with colleagues.',
    ),
    title: 'Stripe Careers | Software Engineering Internship',
  };
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async (query) => {
        queries.push(query);
        return {
          providerId: 'fake',
          results: [{ title: variant.title, url: official, rank: 1 }],
        };
      },
      readPage: async () => variant,
    },
  );
  expect((await service.resolve({ id }))[0]).toMatchObject({
    canonicalUrl: official,
    resolutionReason: 'verified',
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toBe('Software Engineer, Intern Stripe London');
  expect(verifyJobDescription(variant, candidate).evidence).toMatchObject({
    title: true,
    company: true,
    location: true,
  });
  expect(
    verifyJobDescription(
      {
        ...variant,
        title: 'Stripe Careers',
        structured: {
          schemaVersion: 1,
          url: official,
          title: 'Stripe Careers',
          scripts: [],
          stylesheets: [],
          content: {
            blocks: [
              {
                type: 'heading',
                level: 1,
                text: 'Software Engineering Internship',
              },
            ],
          },
          truncated: false,
        },
      },
      candidate,
    ).kind,
  ).toBe('job_description');
  expect(
    verifyJobDescription(
      { ...variant, text: variant.text.replace('London', 'Bengaluru') },
      candidate,
    ),
  ).toMatchObject({
    reason: 'verified',
    evidence: { location: false },
  });
  expect(
    verifyJobDescription(
      {
        ...variant,
        title: 'Stripe Careers | Senior Software Engineer',
        text: variant.text.replace('Internship', 'Senior role'),
      },
      candidate,
    ),
  ).toMatchObject({ reason: 'identity_mismatch', evidence: { title: false } });
});

it.each([
  ['Data Analyst', 'Data Analysts'],
  ['Merchandiser', 'Merchandising'],
  ['Product Manager', 'Product Management'],
  ['AI Analyst', 'AI Analysts'],
  ['Analyst', 'Senior Analyst'],
])('accepts general word forms: %s / %s', (candidateRole, pageRole) => {
  const { candidate } = run(() => {}, { title: candidateRole });
  const posting = {
    ...page(
      canonical,
      `Acme is hiring a ${pageRole} in London. Responsibilities include planning work, collaborating with colleagues and reporting progress. Requirements include relevant experience and clear communication with the team.`,
    ),
    title: `${pageRole} - Acme`,
  };
  expect(verifyJobDescription(posting, candidate)).toMatchObject({
    kind: 'job_description',
    evidence: { title: true, individualRole: true },
  });
});

it.each([
  ['Data Analyst', 'Data Scientist'],
  ['Product Manager', 'Product Analyst'],
  ['Merchandiser', 'Store Manager'],
  ['Software Engineer Intern', 'Senior Software Engineer'],
  ['Software Engineer Intern', 'Software Engineer International'],
])('rejects a different role: %s / %s', (candidateRole, pageRole) => {
  const { candidate } = run(() => {}, { title: candidateRole });
  const posting = {
    ...page(
      canonical,
      `Acme is hiring a ${pageRole} in London. Responsibilities include planning work, collaborating with colleagues and reporting progress. Requirements include relevant experience and clear communication with the team.`,
    ),
    title: `${pageRole} - Acme`,
  };
  expect(verifyJobDescription(posting, candidate)).toMatchObject({
    kind: 'not_job_description',
    reason: 'identity_mismatch',
    evidence: { title: false },
  });
});

it.each([
  ['unknown ATS', 'https://tenant.hiring-cloud.example/vacancy/42'],
  ['aggregator', 'https://vacancy-reposts.example/listing/42'],
  ['job board', 'https://www.indeed.com/viewjob?jk=42'],
])(
  'selects a valid %s JD without location or requisition evidence',
  async (_, url) => {
    const { id, candidate } = run();
    const search = vi.fn(async () => ({
      providerId: 'fake',
      results: [{ url, title: 'Engineering Intern', rank: 1 }],
    }));
    const readPage = vi.fn(async () =>
      page(url, description.replace(' in London', '')),
    );
    const service = new DiscoveryRunsService(
      repo,
      searches,
      () => new Date(now),
      { search, readPage },
    );
    expect((await service.resolve({ id }))[0].canonicalUrl).toBe(url);
    expect(search).toHaveBeenCalledTimes(2);
    expect(readPage).toHaveBeenCalledTimes(1);
    const evidence = storage.db
      .prepare(
        'SELECT resolution_evidence_json FROM job_opportunities WHERE id=?',
      )
      .get(candidate.id) as { resolution_evidence_json: string };
    expect(JSON.parse(evidence.resolution_evidence_json)).toMatchObject({
      identityConfidence: 0.7,
      location: false,
      verifierVersion: 4,
    });
  },
);

it.each([
  ['Careers - Acme', description, 200],
  ['Acme Careers', description, 200],
  ['Search results', description, 200],
  ['Engineering Intern', `This listing is closed. ${description}`, 200],
  ['Engineering Intern', 'Responsibilities: search our vacancies.', 200],
  ['Engineering Intern', description, 404],
])('never scores an invalid JD: %s / %s / %s', (title, text, status) => {
  const { candidate } = run();
  const verdict = verifyJobDescription(
    { ...page(), title, text, status },
    candidate,
  );
  expect(verdict.kind).not.toBe('job_description');
  expect(verdict.evidence.identityConfidence).toBe(0);
});

it('scores employer and title evidence independently, including absent evidence', () => {
  const { candidate } = run();
  const full = verifyJobDescription(page(), candidate);
  const noEmployer = verifyJobDescription(
    {
      ...page(
        'https://unknown.example/job',
        description.replace('Acme is hiring an ', 'An '),
      ),
      title: 'Engineering Intern',
    },
    candidate,
  );
  const partialTitle = verifyJobDescription(
    { ...page(), title: 'Engineering Placement Intern' },
    candidate,
  );
  const noTitle = verifyJobDescription(
    { ...page(), title: 'Job details' },
    candidate,
  );
  expect(noEmployer.kind).toBe('job_description');
  expect(noTitle.kind).toBe('job_description');
  expect(
    full.evidence.identityConfidence - noEmployer.evidence.identityConfidence,
  ).toBeCloseTo(0.25);
  expect(partialTitle.evidence.scores.company).toBe(
    full.evidence.scores.company,
  );
  expect(partialTitle.evidence.scores.title).toBeGreaterThan(0);
  expect(partialTitle.evidence.identityConfidence).toBeLessThan(
    full.evidence.identityConfidence,
  );
  const boilerplate = verifyJobDescription(
    {
      ...page(
        canonical,
        `${description} Acme offers Engineering Intern programmes.`,
      ),
      title: 'Senior Accountant - Acme',
    },
    candidate,
  );
  expect(boilerplate.reason).toBe('identity_mismatch');
  expect(boilerplate.evidence.individualRole).toBe(true);
  const otherEmployer = verifyJobDescription(
    page(
      canonical,
      description.replace('Acme is hiring', 'Different Employer seeks'),
    ),
    candidate,
  );
  expect(otherEmployer.reason).toBe('identity_mismatch');
  expect(otherEmployer.evidence.identityConfidence).toBeLessThan(0.3);
});

it('does not mistake role subheadings on a careers directory for an individual JD', () => {
  const { candidate } = run();
  const url = 'https://careers.acme.example/';
  const directory = {
    ...page(url),
    title: 'Careers | Acme',
    structured: normalizePage({
      url,
      title: 'Careers | Acme',
      html: `<main><h1>Careers</h1><h2>Engineering Intern</h2><p>${description}</p><h2>Sales Associate</h2></main>`,
    }),
  };
  expect(verifyJobDescription(directory, candidate)).toMatchObject({
    kind: 'not_job_description',
    reason: 'not_job_description',
  });
});

it('ranks plausible pages across searches and lets identity outweigh source authority', async () => {
  const { id, candidate } = run();
  const official = 'https://careers.acme.example/jobs/placement';
  const middle = 'https://some-board.example/jobs/intern';
  const strongest = 'https://reposts.example/jobs/intern';
  let calls = 0;
  const readPage = vi.fn(async (url: string) => ({
    ...page(url, description.replace(' in London', '')),
    title:
      url === official
        ? 'Engineering Placement Intern - Acme'
        : url === middle
          ? 'Engineering Summer Intern - Acme'
          : 'Engineering Intern - Acme',
  }));
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async () => ({
        providerId: 'fake',
        results: (++calls === 1 ? [official, middle] : [strongest]).map(
          (url, i) => ({ url, rank: i + 1, title: 'Job' }),
        ),
      }),
      readPage,
    },
  );
  await service.resolve({ id });
  expect(service.candidates({ id })[0].canonicalUrl).toBe(strongest);
  expect(readPage.mock.calls.map(([url]) => url)).toEqual([
    official,
    middle,
    strongest,
  ]);
  const diagnostics = service.resolutionDiagnostics({
    id,
    sourceId: candidate.sourceId,
  });
  expect(diagnostics.attempts[0].searches[0].results).toMatchObject([
    { disposition: 'rejected', reason: null },
    { disposition: 'rejected', reason: null },
  ]);
  const accepted = diagnostics.attempts[0].searches[1].results[0];
  expect(accepted.disposition).toBe('accepted');
  expect(accepted.captureId).toBe(
    service
      .captures({ id, sourceId: candidate.sourceId })
      .find((capture) => capture.sourceUrl === strongest)?.id,
  );
});

it('stops early on exceptional identity evidence even on an unknown domain', async () => {
  const { id } = run();
  const url = 'https://hiring-cloud.example/jobs/42';
  const readPage = vi.fn(async (link: string) => page(link));
  const search = vi.fn(async () => ({
    providerId: 'fake',
    results: [url, canonical].map((link, i) => ({
      url: link,
      title: 'Job',
      rank: i + 1,
    })),
  }));
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    { search, readPage },
  );
  expect((await service.resolve({ id }))[0].canonicalUrl).toBe(url);
  expect(search).toHaveBeenCalledTimes(1);
  expect(readPage).toHaveBeenCalledTimes(1);
});

it.each(['cancelled', 'deadline_reached'])(
  'does not select a retained plausible page after %s',
  async (interruption) => {
    const { id, candidate } = run();
    const service = new DiscoveryRunsService(
      repo,
      searches,
      () => new Date(now),
      web(
        () => [
          'https://reposts.example/first',
          'https://reposts.example/second',
        ],
        (url) => {
          if (url.endsWith('second')) {
            if (interruption === 'cancelled') service.cancel({ id });
            else now += 5_400_001;
          }
          return page(url, description.replace(' in London', ''));
        },
      ),
    );
    expect((await service.resolve({ id }))[0]).toMatchObject({
      canonicalUrl: null,
      resolutionReason: interruption,
    });
    expect(
      service
        .resolutionDiagnostics({ id, sourceId: candidate.sourceId })
        .attempts[0].searches[0].results.map((result) => result.disposition),
    ).toEqual(['interrupted', 'interrupted']);
  },
);

it('keeps the second targeted search open to employer sites', async () => {
  const { id } = run();
  const official = 'https://careers.acme.example/jobs/3456789';
  const queries: string[] = [];
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async (query) => {
        queries.push(query);
        return {
          providerId: 'fake',
          results:
            queries.length === 1
              ? []
              : [{ title: 'Engineering Intern', url: official, rank: 1 }],
        };
      },
      readPage: async (url) => page(url),
    },
  );
  expect((await service.resolve({ id }))[0].canonicalUrl).toBe(official);
  expect(queries).toHaveLength(2);
  expect(queries[1]).toContain('careers');
  expect(queries[1]).not.toContain('site:');
});
it('resolves exact employer/ATS content and preserves immutable raw evidence and source across restart', async () => {
  const { id, candidate } = run();
  const original = page();
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    web(
      () => [canonical],
      () => original,
    ),
  );
  const [resolved] = await service.resolve({ id });
  expect(resolved).toMatchObject({
    canonicalUrl: canonical,
    discoveredUrl: source,
    resolutionStatus: 'resolved',
    resolutionReason: 'verified',
    resolutionAttempts: 1,
  });
  const capture = service.captures({ id, sourceId: candidate.sourceId })[0];
  expect(capture.rawReadPage).toEqual(original);
  const recorded = storage.db
    .prepare(
      `SELECT resolution_evidence_json FROM job_opportunities WHERE id=?`,
    )
    .get(candidate.id) as { resolution_evidence_json: string };
  expect(JSON.parse(recorded.resolution_evidence_json)).toMatchObject({
    captureId: capture.id,
    verifierVersion: 4,
    company: true,
    title: true,
  });
  expect(() =>
    storage.db
      .prepare(
        'UPDATE job_opportunity_captures SET raw_readpage_json=? WHERE id=?',
      )
      .run('{}', capture.id),
  ).toThrow(/evidence/);
  storage.close();
  storage = openStorage(dir);
  repo = new DiscoveryRunsRepository(storage.db);
  expect(repo.candidates(id)[0].canonicalUrl).toBe(canonical);
  expect(repo.captures(id, candidate.sourceId)?.[0].rawReadPage).toEqual(
    original,
  );
  expect(storage.db.pragma('foreign_key_check')).toEqual([]);
  expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('rejects directories, login walls, expired listings and contradictory roles', () => {
  const { candidate } = run();
  const cases: Array<[PageReadResult, string]> = [
    [
      page(
        'https://acme.example/careers',
        'Acme Engineering Intern London. Explore careers and search all open jobs at Acme. No individual vacancy is described on this page.',
      ),
      'not_job_description',
    ],
    [
      page(canonical, 'Sign in to continue. Enable cookies to view this page.'),
      'page_unavailable',
    ],
    [
      page(canonical, `This posting has expired. ${description}`),
      'page_unavailable',
    ],
    [
      {
        ...page(
          canonical,
          description.replace('Engineering Intern', 'Senior Accountant'),
        ),
        title: 'Senior Accountant - Acme',
      },
      'identity_mismatch',
    ],
  ];
  for (const [document, reason] of cases)
    expect(verifyJobDescription(document, candidate)).toMatchObject({
      kind: reason === 'page_unavailable' ? 'unknown' : 'not_job_description',
      reason,
    });
  expect(verifyJobDescription(page(), candidate)).toMatchObject({
    kind: 'job_description',
    evidence: {
      company: true,
      title: true,
      location: true,
      individualRole: true,
    },
  });
  expect(
    verifyJobDescription(
      page('https://unrelated.example/jobs/3456789'),
      candidate,
    ),
  ).toMatchObject({ kind: 'job_description', reason: 'verified' });
  expect(
    verifyJobDescription(
      page('https://www.glassdoor.com/Job/acme-3456789'),
      candidate,
    ),
  ).toMatchObject({ kind: 'job_description', reason: 'verified' });
  expect(
    verifyJobDescription(
      page('https://careers.acme.example/jobs/3456789'),
      candidate,
    ).kind,
  ).toBe('job_description');
  expect(verifyJobDescription(page(), candidate, '9999999')).toMatchObject({
    kind: 'job_description',
    reason: 'verified',
    evidence: { requisitionId: false },
  });
});

it('enforces 2 searches × 5 reads, preserves unresolved and allows one explicit retry only', async () => {
  const { id, candidate } = run();
  let searchesCalled = 0;
  let reads = 0;
  const links = Array.from(
    { length: 12 },
    (_, i) => `https://careers.example/jobs/${i}`,
  );
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    web(
      () => {
        searchesCalled++;
        return links;
      },
      (url) => {
        reads++;
        return page(url, 'Search careers at Acme.');
      },
    ),
  );
  await service.resolve({ id });
  expect([searchesCalled, reads]).toEqual([2, 10]);
  expect(service.get({ id }).stats).toMatchObject({
    targetedSearches: 2,
    targetedPagesRead: 10,
    newCandidates: 1,
  });
  expect(service.candidates({ id })[0]).toMatchObject({
    canonicalUrl: null,
    resolutionStatus: 'unresolved',
    resolutionAttempts: 1,
    retryAvailable: true,
  });
  await service.retryResolution({ id, sourceId: candidate.sourceId });
  expect([searchesCalled, reads]).toEqual([4, 20]);
  await expect(
    service.retryResolution({ id, sourceId: candidate.sourceId }),
  ).rejects.toThrow(/limit/);
  expect(service.candidates({ id })[0].retryAvailable).toBe(false);
  expect(service.captures({ id, sourceId: candidate.sourceId })).toHaveLength(
    12,
  );
  expect(
    storage.db
      .prepare(
        'SELECT count(*) AS count FROM job_opportunity_captures WHERE opportunity_id=?',
      )
      .get(candidate.id),
  ).toEqual({ count: 20 });
  expect(
    storage.db
      .prepare(
        'SELECT count(*) AS n FROM job_discovery_run_items WHERE admitted=1 AND run_id=?',
      )
      .get(id),
  ).toEqual({ n: 1 });
});

it('keeps truncated and oversized reads unverified without truncated evidence; clock blocks late results', async () => {
  const { id, candidate } = run((config) => {
    config.run.maxTargetedSearchesPerCandidate = 1;
    config.run.maxPagesPerTargetedSearch = 3;
  });
  let count = 0;
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    web(
      () => [
        'https://acme.example/truncated',
        'https://acme.example/large',
        canonical,
      ],
      (url) => {
        count++;
        if (count === 1)
          return { ...page(url), truncated: { html: false, text: true } };
        if (count === 2) return { ...page(url), html: 'a'.repeat(2_097_153) };
        now += 5_400_001;
        return page(url);
      },
    ),
  );
  await service.resolve({ id });
  expect(service.candidates({ id })[0]).toMatchObject({
    canonicalUrl: null,
    resolutionReason: 'deadline_reached',
  });
  expect(service.captures({ id, sourceId: candidate.sourceId })).toEqual([]);
  expect(service.get({ id }).stats.targetedPagesRead).toBe(3);
});

it('surfaces oversized evidence and never installs a canonical link for it', async () => {
  const { id, candidate } = run((config) => {
    config.run.maxTargetedSearchesPerCandidate = 1;
    config.run.maxPagesPerTargetedSearch = 1;
  });
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    web(
      () => [canonical],
      () => ({ ...page(), html: 'x'.repeat(2_097_153) }),
    ),
  );
  expect((await service.resolve({ id }))[0]).toMatchObject({
    canonicalUrl: null,
    resolutionReason: 'capture_too_large',
  });
  expect(service.captures({ id, sourceId: candidate.sourceId })).toEqual([]);
});

it('does not burn an attempt after the run deadline; an explicit candidate attempt gets a fresh bounded window', async () => {
  const { id, candidate } = run((config) => {
    config.run.deadlineMs = 100;
    config.run.maxTransientRetries = 0;
  });
  now += 101;
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    web(
      () => [canonical],
      () => page(),
    ),
  );
  await expect(service.resolve({ id })).rejects.toThrow(/deadline/);
  expect(service.candidates({ id })[0]).toMatchObject({
    resolutionAttempts: 0,
    retryAvailable: true,
  });
  expect(
    await service.retryResolution({ id, sourceId: candidate.sourceId }),
  ).toMatchObject({
    canonicalUrl: canonical,
    resolutionAttempts: 1,
    retryAvailable: false,
  });
});

it('cancels pending resolution without persisting late page results', async () => {
  const { id, candidate } = run();
  let release!: (value: PageReadResult) => void;
  const pending = new Promise<PageReadResult>((resolve) => {
    release = resolve;
  });
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async () => ({
        providerId: 'fake',
        results: [{ title: 'Job', url: canonical, rank: 1 }],
      }),
      readPage: async () => pending,
    },
  );
  const resolving = service.resolve({ id });
  await new Promise((resolve) => setTimeout(resolve, 0));
  service.cancel({ id });
  release(page());
  expect((await resolving)[0]).toMatchObject({
    canonicalUrl: null,
    resolutionReason: 'cancelled',
  });
  expect(service.captures({ id, sourceId: candidate.sourceId })).toEqual([]);
});

it('validates source ownership at IPC and disallows arbitrary resolution URLs', async () => {
  const { id, candidate } = run();
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
  expect(
    await send('runs.captures', { id, sourceId: candidate.sourceId }),
  ).toMatchObject({ ok: true, data: { items: [] } });
  expect(
    await send('runs.resolutionDiagnostics', {
      id,
      sourceId: candidate.sourceId,
    }),
  ).toMatchObject({
    ok: true,
    data: { totalAttempts: 0, attempts: [], source: { discoveredUrl: source } },
  });
  expect(
    await send('runs.resolutionDiagnostics', {
      id,
      sourceId: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(
    await send('runs.resolutionDiagnostics', {
      id: crypto.randomUUID(),
      sourceId: candidate.sourceId,
    }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(
    await send('runs.resolutionDiagnostics', {
      id,
      sourceId: candidate.sourceId,
      url: canonical,
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(
    await send('runs.captures', { id, sourceId: crypto.randomUUID() }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(
    await send('runs.retryResolution', {
      id,
      sourceId: candidate.sourceId,
      url: canonical,
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await send('runs.resolve', { id: crypto.randomUUID() })).toMatchObject(
    { ok: false, error: { code: 'NOT_FOUND' } },
  );
});

it('preserves a populated v20 claimed attempt without inventing query or URL history', () => {
  storage.close();
  const file = path.join(dir, 'previous.sqlite');
  const db = openConnection(file);
  runMigrations(db, MIGRATIONS.slice(0, 20));
  seedLocalProfile(db);
  const oldSearches = new SavedSearchesService(new SavedSearchesRepository(db));
  const config = newJobDiscoveryConfiguration();
  config.name = 'Earlier';
  config.intent.targetRoles = ['Engineering Intern'];
  config.run.maxPagesPerTargetedSearch = 3; // Historical v20 SQL ceiling.
  const saved = oldSearches.create({ config });
  const oldRepo = new DiscoveryRunsRepository(db);
  const oldRun = new DiscoveryRunsService(oldRepo, oldSearches).start({
    savedSearchId: saved.id,
  });
  const item = oldRepo.observe(
    oldRun.id,
    {
      provider: 'linkedin',
      key: '12345678',
      discoveredUrl: source,
      collectionUrl: null,
      title: 'Engineering Intern',
      company: 'Acme',
      location: 'London',
      postingAge: null,
    },
    new Date(now).toISOString(),
  )!;
  db.prepare(
    "UPDATE job_opportunities SET resolution_attempts=1,resolution_status='unresolved',resolution_reason='no_match' WHERE id=?",
  ).run(item.id);
  oldRepo.finish(oldRun.id, 'completed', new Date(now).toISOString());
  db.close();
  const upgraded = openConnection(file);
  expect(runMigrations(upgraded).appliedVersions).toEqual([
    21, 22, 23, 24, 25, 26,
  ]);
  const restored = new DiscoveryRunsRepository(upgraded);
  expect(
    restored.resolutionDiagnostics(
      restored.admitted(oldRun.id, item.sourceId)!,
    ),
  ).toMatchObject({ totalAttempts: 1, attempts: [] });
  expect(upgraded.pragma('foreign_key_check')).toEqual([]);
  expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
  upgraded.close();
  storage = openStorage(dir);
});

it('upgrades a populated v11 candidate without resetting its source or decision', () => {
  storage.close();
  const db = openConnection(path.join(dir, 'legacy.sqlite'));
  runMigrations(db, MIGRATIONS.slice(0, 11));
  seedLocalProfile(db);
  const oldSearches = new SavedSearchesService(new SavedSearchesRepository(db));
  const config = newJobDiscoveryConfiguration();
  config.name = 'Previous';
  config.intent.targetRoles = ['Engineer'];
  config.run.maxPagesPerTargetedSearch = 3; // Historical v11 SQL ceiling.
  config.run.deadlineMs = 900_000; // v11 SQL still has the historical ceiling.
  const search = oldSearches.create({ config });
  const old = new DiscoveryRunsService(
    new DiscoveryRunsRepository(db),
    oldSearches,
  );
  const started = old.start({ savedSearchId: search.id });
  const opportunityId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const at = new Date(now).toISOString();
  db.prepare(`INSERT INTO job_opportunities
    (id,profile_id,title,company,location,created_at,updated_at)
    VALUES (?,'local','Engineer','Acme','London',?,?)`).run(
    opportunityId,
    at,
    at,
  );
  db.prepare(`INSERT INTO job_opportunity_sources
    (id,profile_id,opportunity_id,provider,source_key,discovered_url,first_seen_at,last_seen_at)
    VALUES (?,'local',?,'linkedin','12345678',?,?,?)`).run(
    sourceId,
    opportunityId,
    source,
    at,
    at,
  );
  db.prepare(`INSERT INTO job_discovery_run_items
    (id,run_id,source_id,admitted,outcome,observed_at,updated_at)
    VALUES (?,?,?,1,'admitted',?,?)`).run(
    crypto.randomUUID(),
    started.id,
    sourceId,
    at,
    at,
  );
  const original = db
    .prepare(`SELECT id FROM job_opportunities WHERE profile_id='local'`)
    .get() as { id: string };
  db.prepare(
    `UPDATE job_opportunities SET review_decision='dismissed' WHERE id=?`,
  ).run(original.id);
  db.close();
  const upgraded = openConnection(path.join(dir, 'legacy.sqlite'));
  expect(runMigrations(upgraded).appliedVersions).toEqual([
    12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
  ]);
  const row = upgraded
    .prepare(
      `SELECT o.review_decision, o.resolution_attempts, s.discovered_url FROM job_opportunities o JOIN job_opportunity_sources s ON s.opportunity_id=o.id WHERE o.id=?`,
    )
    .get(original.id);
  expect(row).toEqual({
    review_decision: 'dismissed',
    resolution_attempts: 0,
    discovered_url: source,
  });
  upgraded
    .prepare(
      `UPDATE job_opportunity_sources SET listing_meta_json='{}' WHERE opportunity_id=?`,
    )
    .run(original.id);
  expect(
    new DiscoveryRunsRepository(upgraded).candidates(started.id)[0].postingAge,
  ).toBeNull();
  expect(upgraded.pragma('foreign_key_check')).toEqual([]);
  upgraded.close();
});

it('traces a LinkedIn listing to the company’s Greenhouse posting before any web search', async () => {
  const { id } = run();
  const searchesMade: string[] = [];
  const feedsRead: string[] = [];
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async (query: string) => {
        searchesMade.push(query);
        return { providerId: 'fake', results: [] };
      },
      readPage: async (url: string) => page(url),
      readFeed: async (url: string) => {
        feedsRead.push(url);
        return url.startsWith(
          'https://boards-api.greenhouse.io/v1/boards/acme/',
        )
          ? JSON.stringify({
              jobs: [
                {
                  title: 'Engineering Intern',
                  absolute_url: canonical,
                  location: { name: 'London' },
                },
                {
                  title: 'Sales Lead',
                  absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
                  location: { name: 'London' },
                },
              ],
            })
          : null;
      },
    },
  );
  expect((await service.resolve({ id }))[0]).toMatchObject({
    canonicalUrl: canonical,
    discoveredUrl: source,
    resolutionReason: 'verified',
  });
  expect(feedsRead).toContain(
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
  );
  expect(searchesMade).toHaveLength(0);
});

it('falls back to web search when the company has no public job board', async () => {
  const { id } = run();
  const searchesMade: string[] = [];
  const service = new DiscoveryRunsService(
    repo,
    searches,
    () => new Date(now),
    {
      search: async (query: string) => {
        searchesMade.push(query);
        return {
          providerId: 'fake',
          results: [{ url: canonical, title: 'Job', rank: 1 }],
        };
      },
      readPage: async (url: string) => page(url),
      readFeed: async () => null,
    },
  );
  expect((await service.resolve({ id }))[0].canonicalUrl).toBe(canonical);
  expect(searchesMade.length).toBeGreaterThan(0);
});

it('reads roles on screen first, then the rest in the order found', () => {
  const config = newJobDiscoveryConfiguration();
  config.name = 'Focus';
  config.intent.targetRoles = ['Designer'];
  const saved = searches.create({ config });
  const service = new DiscoveryRunsService(repo, searches, () => new Date(now));
  const started = service.start({ savedSearchId: saved.id });
  for (const key of ['1', '2', '3'])
    repo.observe(
      started.id,
      {
        provider: 'linkedin',
        key,
        discoveredUrl: `https://uk.linkedin.com/jobs/view/${key}`,
        collectionUrl: null,
        title: `Designer ${key}`,
        company: `Co ${key}`,
        location: 'London',
        postingAge: null,
      },
      new Date(now).toISOString(),
    );
  const ids = service.candidates({ id: started.id }).map((c) => c.sourceId);
  const take = (queue: string[]) =>
    (service as unknown as { takeNext: (q: string[]) => string }).takeNext(
      queue,
    );
  const queue = [...ids];
  service.focus([repo.opportunityOfSource(ids[2])!]);
  expect(take(queue)).toBe(ids[2]);
  expect(take(queue)).toBe(ids[0]);
  // A focus older than five minutes no longer reorders.
  service.focus([repo.opportunityOfSource(ids[1])!]);
  now += 6 * 60_000;
  const rest = [ids[0], ids[1]];
  expect(take(rest)).toBe(ids[0]);
});
