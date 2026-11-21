import { stemmer } from 'stemmer';
import type { PageReadResult } from '../../../shared/contracts';
import type { DiscoveryCandidate } from '../../../shared/contracts';
import { classifyExternalUrl } from '../web/url-safety';

/** Source preference only: individual job-board listings remain eligible. */
export function isJobBoardHost(host: string): boolean {
  return /(^|\.)(?:linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.com|brightnetwork\.co\.uk|gradcracker\.com)$/i.test(
    host,
  );
}

export type Verification = {
  kind: 'job_description' | 'not_job_description' | 'unknown';
  reason:
    | 'verified'
    | 'identity_mismatch'
    | 'not_job_description'
    | 'page_unavailable';
  evidence: {
    company: boolean;
    companyBasis: 'exact_name' | 'employer_brand' | null;
    title: boolean;
    location: boolean | null;
    requisitionId: boolean | null;
    individualRole: boolean;
    identityConfidence: number;
    scores: {
      title: number;
      company: number;
      location: number;
      requisitionId: number;
      content: number;
    };
    sourceAuthority: 'employer' | 'ats' | 'job_board' | 'aggregator';
    verifierVersion: number;
  };
};

const words = (text: string) =>
  text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const includes = (body: string, term: string) =>
  !!term && ` ${words(body)} `.includes(` ${words(term)} `);

const identityWeights = {
  title: 0.35,
  company: 0.25,
  location: 0.15,
  requisitionId: 0.15,
  content: 0.1,
};

function employerBrand(company: string): string | undefined {
  return words(company)
    .split(' ')
    .find(
      (token) =>
        token.length >= 4 &&
        !['company', 'group', 'limited', 'services'].includes(token),
    );
}

/** Conservative employer-domain hint, never sufficient by itself to verify a job. */
export function matchesEmployerHost(host: string, company: string): boolean {
  const brand = employerBrand(company);
  if (!brand || !/^[a-z0-9]+$/.test(brand)) return false;
  const labels = host.toLowerCase().split('.');
  const suffixLength = labels.at(-1) === 'uk' && labels.at(-2) === 'co' ? 2 : 1;
  return labels.at(-suffixLength - 1) === brand;
}

/** Collection labels may append company and location after the role. */
export function candidateRoleTitle(
  title: string,
  company: string,
  location?: string | null,
): string {
  const parts = title.split(/\s+·\s+/);
  if (parts.length > 1 && location && words(parts.at(-1)!) === words(location))
    parts.pop();
  if (parts.length > 1 && words(parts.at(-1)!) === words(company)) parts.pop();
  return parts.join(' · ').trim();
}

const roleStopWords = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'in',
  'of',
  'on',
  'the',
  'to',
]);

function roleWords(text: string): Map<string, string> {
  return new Map(
    words(text)
      .split(' ')
      .filter((word) => word && !roleStopWords.has(word))
      .map((word) => [word, /^[a-z]+$/.test(word) ? stemmer(word) : word]),
  );
}

function sameWordForm(
  left: string,
  leftStem: string,
  right: string,
  rightStem: string,
): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length < 4 || shorter.length / longer.length < 0.6) return false;
  // Porter can over-stem distinct words; compare their original lengths too.
  // It also leaves -ship derivations distinct, irrespective of occupation.
  return leftStem === rightStem || longer === `${shorter}ship`;
}

function sharedRoleWords(
  expected: Map<string, string>,
  found: Map<string, string>,
): number {
  const unmatched = new Map(found);
  let count = 0;
  for (const word of expected.keys()) if (unmatched.delete(word)) count++;
  for (const [word, wordStem] of expected) {
    if (found.has(word)) continue;
    const match = [...unmatched].find(([other, otherStem]) =>
      sameWordForm(word, wordStem, other, otherStem),
    )?.[0];
    if (!match) continue;
    unmatched.delete(match);
    count++;
  }
  return count;
}

function titleSimilarity(title: string, role: string): number {
  const expected = roleWords(role);
  const found = roleWords(title);
  if (!expected.size || !found.size) return 0;
  const common = sharedRoleWords(expected, found);
  if (expected.size === 1) return common === 1 && found.size <= 3 ? 1 : 0;
  // Compare both sides: a different qualifier cannot be hidden by two shared words.
  return common / (expected.size + found.size - common);
}

function bodySupportsRole(text: string, role: string): boolean {
  const expected = roleWords(role);
  return (
    expected.size > 0 &&
    sharedRoleWords(expected, roleWords(text)) >= Math.min(2, expected.size)
  );
}

function titleScore(
  page: PageReadResult,
  role: string,
  company: string,
  host: string,
): number {
  const brand = employerBrand(company);
  const headings =
    page.structured?.content.blocks
      .filter((block) => block.type === 'heading')
      .map((block) => block.text) ?? [];
  return Math.max(
    0,
    ...[...page.title.split(/\s+[|·–—]\s+/), ...headings].map((part) => {
      const suffix = /^(.*?)\s+-\s+(.+)$/.exec(part);
      if (suffix) {
        const publisher = words(suffix[2]);
        if (
          publisher === words(company) ||
          publisher === brand ||
          publisher === words(host.replace(/^www\./, ''))
        )
          part = suffix[1];
      }
      return titleSimilarity(part, role);
    }),
  );
}
const ATS_TENANT_PATH_HOST =
  /^(?:boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co)$/;

const tenant = (url: URL) => {
  if (ATS_TENANT_PATH_HOST.test(url.hostname))
    return url.pathname.split('/')[1] ?? '';
  if (/(^|\.)myworkdayjobs\.com$/.test(url.hostname))
    return url.hostname.split('.')[0];
  return null;
};

const VERIFIER_VERSION = 4;
const PAGE_PREFIX_LENGTH = 1200;
const MIN_INDIVIDUAL_ROLE_TEXT_LENGTH = 120;
const TITLE_MATCH_THRESHOLD = 0.6;
const TITLE_MISMATCH_THRESHOLD = 0.35;
const MIN_IDENTITY_CONFIDENCE = 0.3;
const MISMATCH_CONFIDENCE_PENALTY = 0.2;
const BRAND_COMPANY_SCORE = 0.75;
const COMPANY_COVERAGE_WEIGHT = 0.8;
const EMPLOYER_HOST_COMPANY_SCORE = 0.6;
const ATS_TENANT_COMPANY_SCORE = 0.5;

const BLOCKED_OR_CLOSED_PAGE =
  /captcha|verify you are human|unusual traffic|sign in to (?:view|continue)|log in to (?:view|continue)|enable cookies|access denied|(?:posting|listing|job) (?:has |is )?(?:expired|closed)|(?:job|position) is no longer available|no longer accepting applications/i;
const GENERIC_HEADING =
  /^(?:(?:all|search|open|browse|our)\s+)*(?:jobs|careers|job search|search results|opportunities)(?:\s+(?:at|with)\s+.+)?$/i;
const JD_SECTION_CUE =
  /\b(?:responsibilities|what you(?:'|’)ll do|your role|requirements|qualifications|about the role)\b/i;
const COLLECTION_PAGE_TITLE =
  /\b(?:search results|browse all (?:jobs|openings)|view all (?:jobs|openings))\b/i;
const NON_ROLE_HEADING =
  /^(?:job details|job description|vacancy(?:\s+\w+)?|apply now)$/i;
const HIRING_EMPLOYER =
  /^\s*(.{2,100}?)\s+(?:is hiring|seeks|is looking for)\b/i;
const GENERIC_EMPLOYER = /^(?:our client|the (?:company|employer|team)|we)$/i;
const INTERN_ROLE = /\b(?:intern|internship)\b/i;
const SENIOR_TITLE = /\b(?:senior|lead|principal|international)\b/i;

type Evidence = Verification['evidence'];
type Candidate = Pick<DiscoveryCandidate, 'title' | 'company' | 'location'>;

function initialEvidence(): Evidence {
  return {
    company: false,
    companyBasis: null,
    title: false,
    location: null,
    requisitionId: null,
    individualRole: false,
    identityConfidence: 0,
    scores: { title: 0, company: 0, location: 0, requisitionId: 0, content: 0 },
    sourceAuthority: 'aggregator',
    verifierVersion: VERIFIER_VERSION,
  };
}

function isPageUnavailable(page: PageReadResult): boolean {
  const hasSuccessStatus =
    page.status !== null && page.status >= 200 && page.status < 300;
  return (
    !classifyExternalUrl(page.url).ok ||
    !hasSuccessStatus ||
    page.truncated.html ||
    page.truncated.text
  );
}

function isBlockedOrClosed(page: PageReadResult, text: string): boolean {
  return BLOCKED_OR_CLOSED_PAGE.test(
    `${page.title} ${text.slice(0, PAGE_PREFIX_LENGTH)}`,
  );
}

/** Title parts and primary headings that are not just the employer's name. */
function candidateRoleHeadings(
  page: PageReadResult,
  company: string,
  brand: string | undefined,
): string[] {
  // Collection subheadings may name several roles; only a primary heading
  // can establish an individual JD when the document title is generic.
  const headings =
    page.structured?.content.blocks
      .filter((block) => block.type === 'heading')
      .filter((block) => block.level === 1)
      .map((block) => block.text) ?? [];

  return [...page.title.split(/\s+[|·–—]\s+/), ...headings]
    .map((heading) => heading.replace(/\s+-\s+.*$/, '').trim())
    .filter(
      (heading) =>
        words(heading) !== words(company) && words(heading) !== brand,
    );
}

function isIndividualRole(
  page: PageReadResult,
  text: string,
  roleHeadings: string[],
): boolean {
  const hasRoleHeading = roleHeadings.some(
    (heading) =>
      heading && !GENERIC_HEADING.test(heading) && !/\bcareers$/i.test(heading),
  );
  return (
    text.length >= MIN_INDIVIDUAL_ROLE_TEXT_LENGTH &&
    JD_SECTION_CUE.test(text) &&
    hasRoleHeading &&
    !COLLECTION_PAGE_TITLE.test(page.title)
  );
}

function sourceAuthority(
  host: string,
  employerHost: boolean,
  siteTenant: string | null,
): Evidence['sourceAuthority'] {
  if (employerHost) return 'employer';
  if (siteTenant) return 'ats';
  if (isJobBoardHost(host)) return 'job_board';
  return 'aggregator';
}

function companyBasis(
  text: string,
  company: string,
  brand: string | undefined,
): Evidence['companyBasis'] {
  if (includes(text, company)) return 'exact_name';
  if (brand && includes(text.slice(0, PAGE_PREFIX_LENGTH), brand))
    return 'employer_brand';
  return null;
}

function companyScore(
  page: PageReadResult,
  text: string,
  company: string,
  evidence: Evidence,
): number {
  if (evidence.companyBasis === 'exact_name') return 1;

  const companyWords = roleWords(company);
  const companyCoverage = companyWords.size
    ? sharedRoleWords(
        companyWords,
        roleWords(`${page.title} ${text.slice(0, PAGE_PREFIX_LENGTH)}`),
      ) / companyWords.size
    : 0;
  return Math.max(
    evidence.company ? BRAND_COMPANY_SCORE : 0,
    companyCoverage * COMPANY_COVERAGE_WEIGHT,
  );
}

function scoreLocation(
  evidence: Evidence,
  text: string,
  candidateLocation: string,
): void {
  const location = candidateLocation
    .replace(/^(?:hybrid work|remote|on-site) in /i, '')
    .split(/[,()]/)[0]
    .trim();
  evidence.location = includes(text, location);

  const expectedLocation = roleWords(location);
  evidence.scores.location = expectedLocation.size
    ? sharedRoleWords(expectedLocation, roleWords(text)) / expectedLocation.size
    : 0;
}

function weightedIdentityConfidence(scores: Evidence['scores']): number {
  return (
    identityWeights.title * scores.title +
    identityWeights.company * scores.company +
    identityWeights.location * scores.location +
    identityWeights.requisitionId * scores.requisitionId +
    identityWeights.content * scores.content
  );
}

/** Score title, company, location, requisition and content evidence in place. */
function scoreIdentity(
  evidence: Evidence,
  page: PageReadResult,
  candidate: Candidate,
  requisitionId: string | undefined,
  role: string,
): void {
  const url = new URL(page.url);
  const text = page.text.trim();
  const company = candidate.company ?? '';
  const brand = employerBrand(company);
  const siteTenant = tenant(url);
  const employerHost = matchesEmployerHost(url.hostname, company);

  evidence.sourceAuthority = sourceAuthority(
    url.hostname,
    employerHost,
    siteTenant,
  );

  evidence.companyBasis = companyBasis(text, company, brand);
  evidence.company = evidence.companyBasis !== null;

  evidence.scores.title = titleScore(page, role, company, url.hostname);
  evidence.title = evidence.scores.title >= TITLE_MATCH_THRESHOLD;

  evidence.scores.company = companyScore(page, text, company, evidence);
  if (employerHost)
    evidence.scores.company = Math.max(
      evidence.scores.company,
      EMPLOYER_HOST_COMPANY_SCORE,
    );
  if (siteTenant && brand && includes(siteTenant, brand))
    evidence.scores.company = Math.max(
      evidence.scores.company,
      ATS_TENANT_COMPANY_SCORE,
    );

  if (candidate.location) scoreLocation(evidence, text, candidate.location);

  if (requisitionId)
    evidence.requisitionId =
      includes(text, requisitionId) ||
      url.pathname.split('/').some((segment) => segment === requisitionId);
  evidence.scores.requisitionId = evidence.requisitionId ? 1 : 0;

  const expectedRole = roleWords(role);
  evidence.scores.content = expectedRole.size
    ? sharedRoleWords(expectedRole, roleWords(text)) / expectedRole.size
    : 0;

  evidence.identityConfidence = weightedIdentityConfidence(evidence.scores);
}

/** Explicit attribution is stronger than a company mention in a footer. */
function hasContradictoryEmployer(text: string, company: string): boolean {
  const hiringEmployer = HIRING_EMPLOYER.exec(text)?.[1];
  const brand = employerBrand(company);
  return (
    !!hiringEmployer &&
    !GENERIC_EMPLOYER.test(hiringEmployer) &&
    !!company &&
    !includes(hiringEmployer, company) &&
    !(brand && includes(hiringEmployer, brand))
  );
}

function hasSeniorityConflict(role: string, pageTitle: string): boolean {
  return (
    INTERN_ROLE.test(role) &&
    SENIOR_TITLE.test(pageTitle) &&
    !INTERN_ROLE.test(pageTitle)
  );
}

function hasIdentityConflict(
  page: PageReadResult,
  text: string,
  company: string,
  role: string,
  roleHeadings: string[],
  titleScoreValue: number,
): boolean {
  const hasRoleTitle = roleHeadings.some(
    (heading) =>
      heading &&
      !GENERIC_HEADING.test(heading) &&
      !NON_ROLE_HEADING.test(heading),
  );
  return (
    hasContradictoryEmployer(text, company) ||
    hasSeniorityConflict(role, page.title) ||
    (hasRoleTitle && titleScoreValue < TITLE_MISMATCH_THRESHOLD)
  );
}

/** Validate the document first, then score independent identity evidence. */
export function verifyJobDescription(
  page: PageReadResult,
  candidate: Pick<DiscoveryCandidate, 'title' | 'company' | 'location'>,
  requisitionId?: string,
): Verification {
  const evidence = initialEvidence();
  const outcome = (
    kind: Verification['kind'],
    reason: Verification['reason'],
  ): Verification => ({ kind, reason, evidence });

  if (isPageUnavailable(page)) return outcome('unknown', 'page_unavailable');

  const text = page.text.trim();
  if (isBlockedOrClosed(page, text))
    return outcome('unknown', 'page_unavailable');

  const company = candidate.company ?? '';
  const roleHeadings = candidateRoleHeadings(
    page,
    company,
    employerBrand(company),
  );
  evidence.individualRole = isIndividualRole(page, text, roleHeadings);
  if (!evidence.individualRole)
    return outcome('not_job_description', 'not_job_description');

  const role = candidateRoleTitle(candidate.title, company, candidate.location);
  scoreIdentity(evidence, page, candidate, requisitionId, role);

  const titleScoreValue = evidence.scores.title;
  if (
    hasIdentityConflict(
      page,
      text,
      company,
      role,
      roleHeadings,
      titleScoreValue,
    )
  ) {
    evidence.identityConfidence *= MISMATCH_CONFIDENCE_PENALTY;
    return outcome('not_job_description', 'identity_mismatch');
  }

  const isWeakIdentity =
    evidence.identityConfidence < MIN_IDENTITY_CONFIDENCE ||
    (!bodySupportsRole(text, role) && titleScoreValue < TITLE_MATCH_THRESHOLD);
  if (isWeakIdentity)
    return outcome('not_job_description', 'identity_mismatch');

  return outcome('job_description', 'verified');
}
