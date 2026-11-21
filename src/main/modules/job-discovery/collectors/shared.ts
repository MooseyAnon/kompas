import type { PageReadResult } from '../../../../shared/contracts';
import { classifyExternalUrl } from '../../web/url-safety';

const MAX_URL_CHARS = 2048;
const MAX_TITLE_CHARS = 400;
const MAX_FIELD_CHARS = 200;
const POSTING_AGE_PATTERN =
  /\b(?:\d+\s+(?:hours?|days?|weeks?|months?)|just now) ago\b/i;

export type CollectionProvider = 'linkedin' | 'indeed';

export interface CandidateObservation {
  provider: string;
  key: string;
  discoveredUrl: string;
  collectionUrl: string | null;
  title: string;
  company: string | null;
  location: string | null;
  postingAge: string | null;
}

export function providerOf(url: URL): CollectionProvider | null {
  if (/(^|\.)linkedin\.com$/i.test(url.hostname)) return 'linkedin';
  if (/(^|\.)indeed\.com$/i.test(url.hostname)) return 'indeed';
  return null;
}

export function safeUrl(href: string, base?: string): URL | null {
  try {
    const resolved = new URL(href, base);
    const isAllowed =
      resolved.toString().length <= MAX_URL_CHARS &&
      classifyExternalUrl(resolved.toString()).ok;

    return isAllowed ? resolved : null;
  } catch {
    return null;
  }
}

export function listingIdentity(
  url: URL,
): { provider: string; key: string } | null {
  const provider = providerOf(url);

  if (provider === 'linkedin') {
    const id = /^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/i.exec(
      url.pathname,
    )?.[1];
    return id ? { provider, key: id } : null;
  }

  if (provider === 'indeed') {
    const id = url.searchParams.get('jk');
    const isIndeedListing =
      /^\/(?:rc\/clk|viewjob)\/?$/i.test(url.pathname) &&
      id &&
      /^[a-f0-9]{16}$/i.test(id);

    return isIndeedListing ? { provider, key: id.toLowerCase() } : null;
  }

  // Known public ATS job-detail patterns only; never treat an arbitrary link
  // as a job.
  if (
    /^boards\.greenhouse\.io$/i.test(url.hostname) &&
    /^\/[^/]+\/jobs\/\d+\/?$/.test(url.pathname)
  ) {
    return { provider: 'greenhouse', key: `${url.hostname}${url.pathname}` };
  }

  if (
    /^jobs\.lever\.co$/i.test(url.hostname) &&
    /^\/[^/]+\/[0-9a-f-]{36}\/?$/.test(url.pathname)
  ) {
    return { provider: 'lever', key: `${url.hostname}${url.pathname}` };
  }

  return null;
}

/** Structured lists are the shared fallback for provider-specific collection cards. */
export function extractStructuredCollection(
  page: PageReadResult,
  origin: URL,
  provider: CollectionProvider,
): CandidateObservation[] {
  if (!page.structured || page.structured.truncated) return [];

  const observations: CandidateObservation[] = [];
  for (const block of page.structured.content.blocks) {
    if (block.type !== 'list') continue;

    for (const item of block.items) {
      if (/^salary search:/i.test(item.text.trim())) continue;

      for (const link of item.links ?? []) {
        const observation = observeLink(item, link, origin, provider);
        if (!observation) continue;

        observations.push(observation);
        break;
      }
    }
  }

  return observations;
}

type StructuredListItem = Extract<
  NonNullable<PageReadResult['structured']>['content']['blocks'][number],
  { type: 'list' }
>['items'][number];
type StructuredLink = NonNullable<StructuredListItem['links']>[number];

function observeLink(
  item: StructuredListItem,
  link: StructuredLink,
  origin: URL,
  provider: CollectionProvider,
): CandidateObservation | null {
  const url = safeUrl(link.href, origin.toString());
  if (!url || providerOf(url) !== provider) return null;

  const identity = listingIdentity(url);
  if (!identity) return null;

  const title = link.text.trim();
  if (!title || title.length > MAX_TITLE_CHARS) return null;

  const company =
    provider === 'linkedin'
      ? linkedInCompany(item, origin)
      : indeedCompany(item.text, title);
  const age = item.text.match(POSTING_AGE_PATTERN)?.[0] ?? null;
  const location =
    provider === 'linkedin' && company
      ? linkedInLocation(item.text, company)
      : workplaceLocation(item.text);

  return {
    ...identity,
    discoveredUrl: url.toString(),
    collectionUrl: origin.toString(),
    title,
    company,
    location,
    postingAge: age,
  };
}

function linkedInCompany(item: StructuredListItem, origin: URL): string | null {
  const companyLink = item.links?.find((other) => {
    const target = safeUrl(other.href, origin.toString());
    return (
      target &&
      providerOf(target) === 'linkedin' &&
      /^\/company\/[^/]+/.test(target.pathname)
    );
  });

  return companyLink?.text.trim().slice(0, MAX_FIELD_CHARS) || null;
}

function indeedCompany(text: string, title: string): string | null {
  return (
    text
      .slice(text.indexOf(title) + title.length)
      .match(/^\s*([^\n]+?)(?:Hybrid work in |Remote in |On-site in )/i)?.[1]
      ?.trim()
      .slice(0, MAX_FIELD_CHARS) || null
  );
}

function linkedInLocation(text: string, company: string): string | null {
  return (
    text
      .slice(text.lastIndexOf(company) + company.length)
      .replace(/\b(?:Be an early applicant|Actively Hiring)\b/gi, '')
      .split(POSTING_AGE_PATTERN)[0]
      .trim()
      .slice(0, MAX_FIELD_CHARS) || null
  );
}

function workplaceLocation(text: string): string | null {
  return (
    text
      .match(/(?:Hybrid work in |Remote in |On-site in )([^\n]+)$/i)?.[0]
      ?.trim()
      .slice(0, MAX_FIELD_CHARS) ?? null
  );
}
