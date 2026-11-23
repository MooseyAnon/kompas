// What a GND job card and job page show, derived from a discovered job and
// (once its listing has been read) its details and skills match. Pure: no I/O.
import type {
  OpportunityDetail,
  OpportunitySummary,
} from '../../../../../shared/contracts';
import type { ListingFacts } from './searchPreferences';

export interface JobView {
  id: string;
  title: string;
  company: string;
  /** "London · Hybrid" style: where, then how, when known. */
  place: string;
  salary: string | null;
  /** 0–100, only when the job could be scored against confirmed skills. */
  matchPercent: number | null;
  matched: string[];
  missing: string[];
  requiredCount: number;
  decision: OpportunitySummary['decision'];
  applicationId: string | null;
  listingUrl: string | null;
  /** What the listing says, for checking it against search preferences. */
  facts: ListingFacts;
}

const clean = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/gu, ' ').trim();

export function jobView(
  summary: OpportunitySummary,
  detail?: OpportunityDetail | null,
): JobView {
  const jd = detail?.extraction?.jd ?? null;
  const match = detail?.match ?? null;
  const location = clean(jd?.location?.text) || clean(summary.location);
  const arrangement = clean(jd?.workArrangement?.text);
  const title = clean(jd?.title?.text) || summary.title;
  const coverage =
    match?.status === 'scored' ? match.coverage : summary.coverage;

  return {
    id: summary.opportunityId,
    title,
    company:
      clean(jd?.company?.text) ||
      clean(summary.company) ||
      'Company not listed',
    place: [location, arrangement].filter(Boolean).join(' · '),
    salary: clean(jd?.salaryText?.text) || null,
    matchPercent:
      coverage === null || coverage === undefined
        ? null
        : Math.round(coverage * 100),
    matched: match?.matched ?? [],
    missing: match?.unmatched ?? [],
    requiredCount: match?.requiredCount ?? 0,
    decision: summary.decision,
    applicationId: summary.applicationId,
    listingUrl:
      detail?.canonicalUrl ?? summary.latestSource?.discoveredUrl ?? null,
    facts: {
      title,
      location,
      arrangement,
      employment: clean(jd?.employmentType?.text),
      seniority: clean(jd?.seniority?.value),
      minYears: jd?.minimumYearsExperience?.value ?? null,
      salaryText: clean(jd?.salaryText?.text),
    },
  };
}

/** Best matches first; unscored jobs keep their newest-first order after. */
export function byMatch(a: JobView, b: JobView): number {
  return (b.matchPercent ?? -1) - (a.matchPercent ?? -1);
}

export function missingNote(job: JobView): string | null {
  const count = job.missing.length;
  if (!count) return null;
  return `${count} key requirement${count === 1 ? '' : 's'} not yet shown in your profile`;
}
