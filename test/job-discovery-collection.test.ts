import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/job-discovery-collection.json';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import { SavedSearchesRepository } from '../src/main/modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../src/main/modules/job-discovery/saved-searches.service';
import { DiscoveryRunsRepository } from '../src/main/modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../src/main/modules/job-discovery/runs.service';
import {
  classifyHit,
  extractCollection,
} from '../src/main/modules/job-discovery/collection';
import { WebError } from '../src/main/modules/web/web.error';
import {
  newJobDiscoveryConfiguration,
  type PageReadResult,
  type WebSearchOutput,
} from '../src/shared/contracts';

const page = (name: 'linkedin' | 'indeed'): PageReadResult => ({
  ...fixture[name],
  requestedUrl: fixture[name].url,
  html: '',
  text: '',
  status: 200,
  providerId: 'playwright',
  browserId: 'chrome',
  truncated: { html: false, text: false },
  structured: fixture[name] as PageReadResult['structured'],
});
const hit = (url: string) => ({ title: 'Engineering jobs', url, rank: 1 });

// Reduced from the rendered Indeed card in tmp.html: text blocks concatenate these fields.
const indeedCards = `<html><body><main><ul>
  <li><div class="cardOutline tapItem result job_1cd623f9081dfc15">
    <div class="job_seen_beacon"><h3 class="jobTitle"><a class="jcs-JobTitle"
      data-jk="1cd623f9081dfc15" href="/rc/clk?jk=1cd623f9081dfc15&amp;bb=tracking">
      <span>Facilities Engineering Placement</span></a></h3>
      <div class="company_location"><span data-testid="company-name">Mercedes AMG High Performance Powertrains</span>
      <div data-testid="text-location">Brixworth</div></div></div>
      <a href="/career/engineer/salaries/Brixworth?fromjk=1cd623f9081dfc15">Salary Search</a>
  </div></li>
  <li><div class="cardOutline tapItem result job_6d21e1edf5bbf2c2">
    <h3 class="jobTitle"><a class="jcs-JobTitle" data-jk="6d21e1edf5bbf2c2"
      href="/rc/clk?jk=6d21e1edf5bbf2c2"><span>Engineering Intern</span></a></h3>
    <span data-testid="company-name">Procter &amp; Gamble</span>
    <div data-testid="text-location">Manchester M17 1NX</div>
  </div></li>
  <li><div class="cardOutline tapItem">
    <a class="jcs-JobTitle" data-jk="1cc39b4b75f37a5e" href="/pagead/clk?jk=1cc39b4b75f37a5e">Sponsored redirect</a>
  </div></li>
  <li><div class="cardOutline tapItem">
    <a class="jcs-JobTitle" data-jk="2c21b7e93565d93e" href="javascript:alert(1)">Unsafe</a>
  </div></li>
  <li><div class="cardOutline tapItem">
    <a class="jcs-JobTitle" data-jk="2c21b7e93565d93e" href="/viewjob?jk=1111111111111111">Mismatched ID</a>
  </div></li>
</ul></main></body></html>`;

const linkedInCards = `<html><body><main><ul class="jobs-search__results-list">
  <li><div class="base-card base-search-card job-search-card">
    <a class="base-card__full-link" href="/jobs/view/software-engineer-at-acme-4484584282?position=1&amp;trackingId=abc"><span class="sr-only">Open job</span></a>
    <h3 class="base-search-card__title">Software Engineer Intern</h3>
    <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme">Acme &amp; Co</a></h4>
    <span class="job-search-card__location">London, England</span>
    <time class="job-search-card__listdate" datetime="2026-11-17">2 days ago</time>
  </div></li>
  <li><div class="base-card base-search-card job-search-card">
    <a class="base-card__full-link" href="https://uk.linkedin.com/jobs/view/data-analyst-at-hiya-4483717324"></a>
    <h3 class="base-search-card__title">Data Analyst Intern</h3>
    <h4 class="base-search-card__subtitle">Hiya Inc.</h4>
  </div></li>
</ul></main></body></html>`;

describe('recorded collection evidence', () => {
  it('pairs LinkedIn jobs with employer links; Indeed jk with relative URLs, never salary/profile navigation', () => {
    const linked = extractCollection(page('linkedin'), ['linkedin']);
    expect(
      linked.map((item) => [item.key, item.company, item.postingAge]),
    ).toEqual([
      ['4484584282', 'AECOM', '4 days ago'],
      ['4483717324', 'Hiya Inc.', '1 week ago'],
    ]);
    expect(linked[0].location).toContain('London');
    const indeed = extractCollection(page('indeed'), ['indeed']);
    expect(indeed.map((item) => [item.key, item.company])).toEqual([
      ['84ead4a76a3bfd70', 'AECOM'],
      ['2e7d21c004076123', 'AECOM'],
    ]);
    expect(indeed[0].discoveredUrl).toMatch(
      /^https:\/\/uk\.indeed\.com\/rc\/clk\?jk=/,
    );
    expect(extractCollection(page('linkedin'), ['indeed'])).toEqual([]);
    expect(
      extractCollection({ ...page('indeed'), status: 429 }, ['indeed']),
    ).toEqual([]);
    expect(classifyHit(hit('https://www.linkedin.com/company/aecom'))).toBe(
      'not_job',
    );
    expect(classifyHit(hit('https://uk.indeed.com/career/salaries'))).toBe(
      'not_job',
    );
    expect(classifyHit(hit('file:///etc/passwd'))).toBe('not_job');
    expect(
      classifyHit(hit('https://uk.indeed.com/q-engineering-jobs.html')),
    ).toBe('job_collection');
  });
  it('refuses cross-origin and dangerous schemes in structured links', () => {
    const bad = page('indeed');
    bad.structured!.content.blocks[0] = {
      type: 'list',
      ordered: false,
      items: [
        {
          text: 'Fake job',
          links: [{ text: 'Fake job', href: 'javascript:alert(1)' }],
        },
        {
          text: 'Fake job',
          links: [
            {
              text: 'Fake job',
              href: 'https://evil.example/rc/clk?jk=84ead4a76a3bfd70',
            },
          ],
        },
        {
          text: 'Fake job',
          links: [
            {
              text: 'Fake job',
              href: 'http://127.0.0.1/rc/clk?jk=84ead4a76a3bfd70',
            },
          ],
        },
      ],
    };
    expect(extractCollection(bad, ['indeed'])).toEqual([]);
  });
  it('reads separate title, multiword company and location from Indeed HTML cards', () => {
    const rendered = { ...page('indeed'), html: indeedCards };
    const observations = extractCollection(rendered, ['indeed']);
    expect(observations).toEqual([
      {
        provider: 'indeed',
        key: '1cd623f9081dfc15',
        discoveredUrl:
          'https://uk.indeed.com/rc/clk?jk=1cd623f9081dfc15&bb=tracking',
        collectionUrl: fixture.indeed.url,
        title: 'Facilities Engineering Placement',
        company: 'Mercedes AMG High Performance Powertrains',
        location: 'Brixworth',
        postingAge: null,
      },
      {
        provider: 'indeed',
        key: '6d21e1edf5bbf2c2',
        discoveredUrl: 'https://uk.indeed.com/rc/clk?jk=6d21e1edf5bbf2c2',
        collectionUrl: fixture.indeed.url,
        title: 'Engineering Intern',
        company: 'Procter & Gamble',
        location: 'Manchester M17 1NX',
        postingAge: null,
      },
    ]);
    expect(extractCollection(rendered, ['linkedin'])).toEqual([]);
    expect(
      extractCollection(
        {
          ...rendered,
          structured: { ...rendered.structured!, truncated: true },
        },
        ['indeed'],
      ),
    ).toEqual(observations);
    expect(extractCollection({ ...rendered, status: 403 }, ['indeed'])).toEqual(
      [],
    );
    expect(
      extractCollection(
        { ...rendered, truncated: { html: true, text: false } },
        ['indeed'],
      ),
    ).toEqual([]);
  });
  it('reads LinkedIn card fields together and prefers cards over structured lists', () => {
    const rendered = { ...page('linkedin'), html: linkedInCards };
    expect(extractCollection(rendered, ['linkedin'])).toEqual([
      {
        provider: 'linkedin',
        key: '4484584282',
        discoveredUrl:
          'https://uk.linkedin.com/jobs/view/software-engineer-at-acme-4484584282?position=1&trackingId=abc',
        collectionUrl: fixture.linkedin.url,
        title: 'Software Engineer Intern',
        company: 'Acme & Co',
        location: 'London, England',
        postingAge: '2 days ago',
      },
      {
        provider: 'linkedin',
        key: '4483717324',
        discoveredUrl:
          'https://uk.linkedin.com/jobs/view/data-analyst-at-hiya-4483717324',
        collectionUrl: fixture.linkedin.url,
        title: 'Data Analyst Intern',
        company: 'Hiya Inc.',
        location: null,
        postingAge: null,
      },
    ]);
    expect(
      extractCollection(
        {
          ...rendered,
          structured: { ...rendered.structured!, truncated: true },
        },
        ['linkedin'],
      ),
    ).toHaveLength(2);
    expect(extractCollection(rendered, ['indeed'])).toEqual([]);
  });
  describe.each(['linkedin', 'indeed'] as const)(
    '%s DOM visibility',
    (provider) => {
      it.each([
        'aria-hidden="true"',
        'hidden',
        'style="display: none"',
        'style="visibility: hidden"',
      ])('extracts cards and text regardless of %s', (attribute) => {
        const html = provider === 'linkedin' ? linkedInCards : indeedCards;
        const rendered = { ...page(provider), html, structured: undefined };
        const expected = extractCollection(rendered, [provider]);
        expect(expected).toHaveLength(2);

        const hiddenAncestor = html.replace('<main>', `<main ${attribute}>`);
        const hiddenElements = html.replace(
          /<([a-z][a-z0-9]*)\b/g,
          `<$1 ${attribute}`,
        );
        for (const hiddenHtml of [hiddenAncestor, hiddenElements]) {
          expect(
            extractCollection({ ...rendered, html: hiddenHtml }, [provider]),
          ).toEqual(expected);
        }
      });
    },
  );
  it('extracts all 60 LinkedIn cards beneath an aria-hidden cookie-overlay background', () => {
    const cards = Array.from(
      { length: 60 },
      (_, n) => `<li><div class="base-search-card">
        <a class="base-card__full-link" href="/jobs/view/engineer-${1000000 + n}"></a>
        <h3 class="base-search-card__title">Engineer ${n}</h3>
        <h4 class="base-search-card__subtitle">Acme</h4>
      </div></li>`,
    ).join('');
    const observations = extractCollection(
      {
        ...page('linkedin'),
        html: `<main aria-hidden="true"><ul class="jobs-search__results-list">${cards}</ul></main>`,
        structured: undefined,
      },
      ['linkedin'],
    );
    expect(
      observations.map(({ key, title, company }) => ({ key, title, company })),
    ).toEqual(
      Array.from({ length: 60 }, (_, n) => ({
        key: String(1000000 + n),
        title: `Engineer ${n}`,
        company: 'Acme',
      })),
    );
  });
  it('does not extract LinkedIn cards from script, style or template content', () => {
    const card = `<div class="base-search-card">
      <a class="base-card__full-link" href="/jobs/view/inert-1234567"></a>
      <h3 class="base-search-card__title">Inert</h3>
      <h4 class="base-search-card__subtitle">Acme</h4>
    </div>`;
    expect(
      extractCollection(
        {
          ...page('linkedin'),
          html: `<main><script>${card}</script><style>${card}</style><template>${card}</template></main>`,
          structured: undefined,
        },
        ['linkedin'],
      ),
    ).toEqual([]);
  });
  it('does not fall back to structured results when LinkedIn cards are present but invalid', () => {
    const invalid = `<main>
      <div class="base-search-card"><a class="base-card__full-link" href="javascript:alert(1)"></a><h3 class="base-search-card__title">Unsafe</h3><h4 class="base-search-card__subtitle">Acme</h4></div>
      <div class="base-search-card"><a class="base-card__full-link" href="http://127.0.0.1/jobs/view/private-1234567"></a><h3 class="base-search-card__title">Private</h3><h4 class="base-search-card__subtitle">Acme</h4></div>
      <div class="base-search-card"><a class="base-card__full-link" href="https://evil.example/jobs/view/fake-1234567"></a><h3 class="base-search-card__title">Other site</h3><h4 class="base-search-card__subtitle">Acme</h4></div>
      <div class="base-search-card"><a class="base-card__full-link" href="/jobs/view/no-company-1234567"></a><h3 class="base-search-card__title">Missing employer</h3></div>
    </main>`;
    expect(
      extractCollection({ ...page('linkedin'), html: invalid }, ['linkedin']),
    ).toEqual([]);
    expect(
      extractCollection(
        {
          ...page('linkedin'),
          html: linkedInCards,
          truncated: { html: true, text: false },
        },
        ['linkedin'],
      ),
    ).toEqual([]);
  });
  it('falls back to LinkedIn structured lists without cards and bounds inspected DOM cards', () => {
    expect(
      extractCollection(
        { ...page('linkedin'), html: '<main><p>No cards here</p></main>' },
        ['linkedin'],
      ).map((item) => item.key),
    ).toEqual(['4484584282', '4483717324']);
    const cards = `<main>${Array.from(
      { length: 101 },
      (_, n) => `<div class="base-search-card">
        <a class="base-card__full-link" href="/jobs/view/engineer-${1000000 + n}"></a>
        <h3 class="base-search-card__title">Engineer ${n}</h3>
        <h4 class="base-search-card__subtitle">Acme</h4>
      </div>`,
    ).join('')}</main>`;
    expect(
      extractCollection({ ...page('linkedin'), html: cards }, ['linkedin']),
    ).toHaveLength(100);
  });
  it('uses complete Indeed HTML when structured extraction is unavailable', async () => {
    const rendered = {
      ...page('indeed'),
      html: indeedCards,
      structured: undefined,
    };
    const web = fakeWeb(
      async () => result(fixture.indeed.url),
      async () => rendered,
    );
    const runs = new DiscoveryRunsService(repo, searches, undefined, web);
    const run = runs.start({ savedSearchId: saved().id });
    const finished = await runs.execute({ id: run.id });
    expect(finished.stats).toMatchObject({
      newCandidates: 2,
      inspectedCandidates: 4,
    });
    expect(runs.candidates({ id: run.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Facilities Engineering Placement',
          company: 'Mercedes AMG High Performance Powertrains',
          location: 'Brixworth',
        }),
      ]),
    );
  });
  it.each(['unavailable', 'truncated'] as const)(
    'admits LinkedIn cards when the structured result is %s',
    async (structuredState) => {
      const rendered = {
        ...page('linkedin'),
        html: linkedInCards,
        structured:
          structuredState === 'truncated'
            ? { ...page('linkedin').structured!, truncated: true }
            : undefined,
      };
      const web = fakeWeb(
        async () => result(fixture.linkedin.url),
        async () => rendered,
      );
      const search = saved();
      search.config.query.maxQueries = 1;
      search.config.run.maxCollectionPages = 1;
      searches.update({ id: search.id, config: search.config });
      const runs = new DiscoveryRunsService(repo, searches, undefined, web);
      const run = runs.start({ savedSearchId: search.id });
      const finished = await runs.execute({ id: run.id });
      expect(finished).toMatchObject({
        status: 'completed',
        stats: {
          collectionPagesRead: 1,
          inspectedCandidates: 2,
          newCandidates: 2,
        },
      });
      expect(runs.candidates({ id: run.id })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: 'linkedin',
            sourceKey: '4484584282',
            title: 'Software Engineer Intern',
            company: 'Acme & Co',
            location: 'London, England',
          }),
          expect.objectContaining({
            provider: 'linkedin',
            sourceKey: '4483717324',
            company: 'Hiya Inc.',
          }),
        ]),
      );
    },
  );
});

let dir: string;
let storage: Storage;
let searches: SavedSearchesService;
let repo: DiscoveryRunsRepository;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-discovery-collection-'));
  storage = openStorage(dir);
  searches = new SavedSearchesService(new SavedSearchesRepository(storage.db));
  repo = new DiscoveryRunsRepository(storage.db);
});
afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
function saved(maxNewCandidates = 10) {
  const config = newJobDiscoveryConfiguration();
  config.name = 'Internships';
  config.intent.targetRoles = ['Engineering Intern'];
  config.run.maxNewCandidates = maxNewCandidates;
  return searches.create({ config });
}
function result(url: string): WebSearchOutput {
  return { providerId: 'test', results: [hit(url)] };
}
function fakeWeb(
  search: (query: string, signal?: AbortSignal) => Promise<WebSearchOutput>,
  read: (url: string, signal?: AbortSignal) => Promise<PageReadResult>,
) {
  return {
    search: (q: string, options?: { signal?: AbortSignal }) =>
      search(q, options?.signal),
    readPage: (url: string, options?: { signal?: AbortSignal }) =>
      read(url, options?.signal),
  };
}

describe('one bounded discovery execution', () => {
  it('admits exactly 10 of 60 entries, persists evidence before completion and survives restart', async () => {
    const many = page('linkedin');
    many.structured!.content.blocks = [
      {
        type: 'list',
        ordered: false,
        items: Array.from({ length: 60 }, (_, n) => ({
          text: `Engineer ${n} Acme London ${n} days ago`,
          links: [
            {
              text: `Engineer ${n}`,
              href: `https://uk.linkedin.com/jobs/view/engineer-${1000000 + n}`,
            },
            { text: 'Acme', href: 'https://www.linkedin.com/company/acme' },
          ],
        })),
      },
    ];
    const web = fakeWeb(
      async () => result(fixture.linkedin.url),
      async () => many,
    );
    const runs = new DiscoveryRunsService(repo, searches, undefined, web);
    const run = runs.start({ savedSearchId: saved().id });
    const done = await runs.execute({ id: run.id });
    expect(done).toMatchObject({
      status: 'completed',
      stats: {
        newCandidates: 10,
        inspectedCandidates: 10,
        collectionPagesRead: 1,
      },
    });
    expect(runs.candidates({ id: run.id })).toHaveLength(10);
    expect(runs.candidates({ id: run.id })[0]).toMatchObject({
      provider: 'linkedin',
      collectionUrl: fixture.linkedin.url,
    });
    storage.close();
    storage = openStorage(dir);
    expect(
      new DiscoveryRunsRepository(storage.db).candidates(run.id),
    ).toHaveLength(10);
    expect(storage.db.pragma('foreign_key_check')).toEqual([]);
    expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
  it('counts 100 already-known observations including repeated keys and stops at the inspection cap', async () => {
    const old = new DiscoveryRunsService(repo, searches);
    const search = saved();
    const previous = old.start({ savedSearchId: search.id });
    repo.observe(
      previous.id,
      {
        provider: 'linkedin',
        key: '1234567',
        title: 'Engineer',
        discoveredUrl: 'https://uk.linkedin.com/jobs/view/engineer-1234567',
        collectionUrl: null,
        company: null,
        location: null,
        postingAge: null,
      },
      new Date().toISOString(),
    );
    old.cancel({ id: previous.id });
    const config = search.config;
    config.intent.targetRoles = [
      'Engineer',
      'Designer',
      'Architect',
      'Analyst',
    ];
    searches.update({ id: search.id, config });
    let calls = 0;
    const repeated = page('linkedin');
    repeated.structured!.content.blocks = [
      {
        type: 'list',
        ordered: false,
        items: Array.from({ length: 60 }, () => ({
          text: 'Engineer Acme',
          links: [
            {
              text: 'Engineer',
              href: 'https://uk.linkedin.com/jobs/view/engineer-1234567',
            },
          ],
        })),
      },
    ];
    const web = fakeWeb(
      async () => {
        calls++;
        return result(fixture.linkedin.url);
      },
      async () => repeated,
    );
    const runs = new DiscoveryRunsService(repo, searches, undefined, web);
    const run = runs.start({ savedSearchId: search.id });
    const done = await runs.execute({ id: run.id });
    expect(calls).toBeLessThanOrEqual(4);
    expect(done.stats).toMatchObject({
      inspectedCandidates: 100,
      newCandidates: 1,
      collectionPagesRead: 2,
    });
    expect(runs.candidates({ id: run.id })).toHaveLength(1);
  });
  it('records challenge diagnostics without evasion; cancellation retains committed observations', async () => {
    const web = fakeWeb(
      async () => result(fixture.indeed.url),
      async () => {
        throw new WebError('RATE_LIMITED');
      },
    );
    const runs = new DiscoveryRunsService(repo, searches, undefined, web);
    const run = runs.start({ savedSearchId: saved().id });
    const blocked = await runs.execute({ id: run.id });
    expect(blocked.status).toBe('partial');
    expect(blocked.diagnostics.map((d) => d.code)).toEqual([
      'WEB_RATE_LIMITED',
      'WEB_RATE_LIMITED',
    ]);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = fakeWeb(
      async () => {
        await hold;
        return result(fixture.indeed.url);
      },
      async () => page('indeed'),
    );
    const next = new DiscoveryRunsService(repo, searches, undefined, slow);
    const pending = next.start({ savedSearchId: saved().id });
    const work = next.execute({ id: pending.id });
    expect(next.cancel({ id: pending.id }).status).toBe('cancelled');
    release();
    expect((await work).status).toBe('cancelled');
    expect(next.candidates({ id: pending.id })).toEqual([]);
  });
  it('preserves the first candidate on cancellation and never starts another web operation', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const web = fakeWeb(
      async () => {
        calls++;
        if (calls === 2) await hold;
        return result('https://uk.linkedin.com/jobs/view/engineer-12345678');
      },
      async () => {
        throw new Error('unexpected read');
      },
    );
    const search = saved();
    const config = search.config;
    config.intent.targetRoles = ['Engineer', 'Designer', 'Analyst'];
    searches.update({ id: search.id, config });
    const runs = new DiscoveryRunsService(repo, searches, undefined, web);
    const run = runs.start({ savedSearchId: search.id });
    const work = runs.execute({ id: run.id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    runs.cancel({ id: run.id });
    release();
    expect((await work).stats).toMatchObject({
      newCandidates: 1,
      inspectedCandidates: 1,
    });
    expect(runs.candidates({ id: run.id })).toHaveLength(1);
    expect(calls).toBe(2);
  });
  it('honours a stricter frozen deadline even when a web fake resolves after it', async () => {
    let time = Date.parse('2026-11-05T00:00:00.000Z');
    const search = saved();
    const config = search.config;
    config.run.deadlineMs = 100;
    searches.update({ id: search.id, config });
    const web = fakeWeb(
      async () => {
        time += 101;
        return result('https://uk.linkedin.com/jobs/view/engineer-12345678');
      },
      async () => {
        throw new Error('unexpected read');
      },
    );
    const runs = new DiscoveryRunsService(
      repo,
      searches,
      () => new Date(time),
      web,
    );
    const run = runs.start({ savedSearchId: search.id });
    const resultRun = await runs.execute({ id: run.id });
    expect(resultRun).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'DEADLINE_REACHED' }],
      stats: { newCandidates: 0 },
    });
  });
  it('counts a transient retry against both the four search calls and five collection reads', async () => {
    const search = saved();
    const config = search.config;
    config.intent.targetRoles = [
      'Engineer',
      'Designer',
      'Analyst',
      'Architect',
    ];
    searches.update({ id: search.id, config });
    let searchesCalled = 0;
    let readsCalled = 0;
    let simultaneous = 0;
    let peak = 0;
    const web = fakeWeb(
      async () => {
        searchesCalled++;
        simultaneous++;
        peak = Math.max(peak, simultaneous);
        simultaneous--;
        if (searchesCalled === 1) throw new WebError('PROVIDER_FAILURE');
        return {
          providerId: 'test',
          results: Array.from({ length: 5 }, (_, i) =>
            hit(`${fixture.indeed.url}&page=${i}`),
          ),
        };
      },
      async () => {
        readsCalled++;
        simultaneous++;
        peak = Math.max(peak, simultaneous);
        simultaneous--;
        return page('indeed');
      },
    );
    const runs = new DiscoveryRunsService(repo, searches, undefined, web);
    const run = runs.start({ savedSearchId: search.id });
    const done = await runs.execute({ id: run.id });
    expect(searchesCalled).toBe(4);
    expect(readsCalled).toBe(5);
    expect(peak).toBeLessThanOrEqual(2);
    expect(done.stats).toMatchObject({
      collectionPagesRead: 5,
      transientRetries: 1,
    });
  });
  it('validates new IPC actions and owner-scoped listing', async () => {
    const runs = new DiscoveryRunsService(repo, searches);
    const run = runs.start({ savedSearchId: saved().id });
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
    expect(await send('runs.candidates', { id: run.id })).toMatchObject({
      ok: true,
      data: { items: [] },
    });
    expect(
      await send('runs.candidates', { id: crypto.randomUUID() }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(
      await send('runs.execute', { id: run.id, url: 'file:///etc/passwd' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
