import {
  WEB_LIMITS,
  type PageReadResult,
  type SearchResult,
} from '../../../shared/contracts';
import { extractIndeedCollection } from './collectors/indeed';
import { extractLinkedInCollection } from './collectors/linkedin';
import {
  listingIdentity,
  providerOf,
  safeUrl,
  type CandidateObservation,
  type CollectionProvider,
} from './collectors/shared';

const MAX_TITLE_CHARS = 400;
const HTML_SLACK_BYTES = 1024;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR = 400;

export type {
  CandidateObservation,
  CollectionProvider,
} from './collectors/shared';

export function classifyHit(
  result: SearchResult,
): 'job_collection' | 'individual_listing' | 'not_job' | 'unknown' {
  const url = safeUrl(result.url);
  if (!url) return 'not_job';
  if (listingIdentity(url)) return 'individual_listing';
  const provider = providerOf(url);
  if (
    provider === 'linkedin' &&
    /^\/jobs\/(?:search|[^/]*-jobs(?:-[^/]*)?)\/?$/i.test(url.pathname)
  )
    return 'job_collection';
  if (
    provider === 'indeed' &&
    (/^\/jobs\/?$/i.test(url.pathname) ||
      /^\/q-[^/]+-jobs\.html$/i.test(url.pathname))
  )
    return 'job_collection';
  if (provider && /salary|company|career|profile/i.test(url.pathname))
    return 'not_job';
  return 'unknown';
}

export function collectionProvider(url: string): CollectionProvider | null {
  const parsed = safeUrl(url);
  return parsed ? providerOf(parsed) : null;
}

export function directCandidate(
  result: SearchResult,
): CandidateObservation | null {
  if (classifyHit(result) !== 'individual_listing') return null;
  const url = safeUrl(result.url)!;
  const identity = listingIdentity(url)!;

  return {
    ...identity,
    discoveredUrl: url.toString(),
    collectionUrl: null,
    title: result.title.trim().slice(0, MAX_TITLE_CHARS),
    company: null,
    location: null,
    postingAge: null,
  };
}

/** Apply shared page policy before dispatching to the provider's collector. */
export function extractCollection(
  page: PageReadResult,
  allowed: readonly CollectionProvider[],
): CandidateObservation[] {
  const origin = safeUrl(page.url);
  const isUnusablePage =
    page.truncated.html ||
    page.html.length > WEB_LIMITS.maxHtmlBytes + HTML_SLACK_BYTES ||
    page.status === HTTP_FORBIDDEN ||
    page.status === HTTP_TOO_MANY_REQUESTS ||
    (page.status !== null && page.status >= HTTP_CLIENT_ERROR);
  if (!origin || isUnusablePage) return [];

  const provider = providerOf(origin);
  if (!provider || !allowed.includes(provider)) return [];

  return provider === 'indeed'
    ? extractIndeedCollection(page, origin)
    : extractLinkedInCollection(page, origin);
}
