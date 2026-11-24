/**
 * Find a role on the company's own applicant-tracking board. Greenhouse,
 * Lever, Ashby and Workable publish every company's open jobs as public JSON
 * meant to be read by other sites, so a listing first seen on an aggregator
 * (Indeed, LinkedIn…) can be traced to the employer's original posting
 * without any bot check. Pure helpers; the resolver does the reading.
 */

export type AtsProvider = 'greenhouse' | 'lever' | 'ashby' | 'workable';

export interface AtsJob {
  title: string;
  url: string;
  location: string | null;
}

const MAX_SLUGS = 2;
const MAX_MATCHES = 2;
/** Share of the role's words a board title must contain to count. */
const MIN_TITLE_OVERLAP = 0.6;

const COMPANY_SUFFIX =
  /\b(?:inc|ltd|llc|limited|plc|gmbh|corp|corporation|co|company|group|technologies|technology|labs|hq)\.?$/i;

/** Likely board names for a company: "Chromeis Ltd" → chromeis, chromeis-ltd. */
export function slugsFor(company: string): string[] {
  const base = company
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .trim();
  const trimmed = base.replace(COMPANY_SUFFIX, '').trim();
  const words = (value: string) => value.split(/[^a-z0-9]+/).filter(Boolean);
  const candidates = [
    words(trimmed).join(''),
    words(trimmed).join('-'),
    words(base).join(''),
  ].filter((slug) => slug.length >= 2 && slug.length <= 60);
  return [...new Set(candidates)].slice(0, MAX_SLUGS);
}

/** The public jobs feed for one board. */
export function feedUrl(provider: AtsProvider, slug: string): string {
  const name = encodeURIComponent(slug);
  switch (provider) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${name}/jobs`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${name}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${name}`;
    case 'workable':
      return `https://apply.workable.com/api/v1/widget/accounts/${name}`;
  }
}

export const ATS_PROVIDERS: readonly AtsProvider[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
];

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Jobs from a feed's JSON; anything unexpected gives an empty list. */
export function parseFeed(provider: AtsProvider, body: string): AtsJob[] {
  let data: unknown;
  try {
    // A browser may wrap raw JSON in a <pre>; take the outermost value.
    const start = body.search(/[[{]/);
    data = JSON.parse(start > 0 ? body.slice(start) : body);
  } catch {
    return [];
  }
  const record = (value: unknown) =>
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const jobs: AtsJob[] = [];
  const push = (title: unknown, url: unknown, location: unknown) => {
    const t = text(title);
    const u = text(url);
    if (t && u && /^https:\/\//.test(u))
      jobs.push({ title: t, url: u, location: text(location) });
  };
  switch (provider) {
    case 'greenhouse':
      for (const job of list(record(data).jobs))
        push(
          record(job).title,
          record(job).absolute_url,
          record(record(job).location).name,
        );
      break;
    case 'lever':
      for (const job of list(data))
        push(
          record(job).text,
          record(job).hostedUrl,
          record(record(job).categories).location,
        );
      break;
    case 'ashby':
      for (const job of list(record(data).jobs))
        push(record(job).title, record(job).jobUrl, record(job).location);
      break;
    case 'workable':
      for (const job of list(record(data).jobs))
        push(
          record(job).title,
          record(job).url ?? record(job).shortlink,
          record(job).city ?? record(job).country,
        );
      break;
  }
  return jobs;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', '-']);
const tokens = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((word) => word && !STOP.has(word));

/** How much of the role title a board title covers, 0–1. */
export function titleOverlap(role: string, title: string): number {
  const wanted = tokens(role);
  if (!wanted.length) return 0;
  const have = new Set(tokens(title));
  return wanted.filter((word) => have.has(word)).length / wanted.length;
}

/** Board postings that are this role, best first (location breaks ties). */
export function matchingJobs(
  role: string,
  location: string | null,
  jobs: readonly AtsJob[],
): AtsJob[] {
  const place = location?.toLowerCase().split(/[,(]/)[0]?.trim() ?? '';
  return jobs
    .map((job) => ({
      job,
      score:
        titleOverlap(role, job.title) +
        (place && job.location?.toLowerCase().includes(place) ? 0.1 : 0),
    }))
    .filter(({ job }) => titleOverlap(role, job.title) >= MIN_TITLE_OVERLAP)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
    .map(({ job }) => job);
}
