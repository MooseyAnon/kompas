import {
  JOB_DISCOVERY_LIMITS,
  WEB_LIMITS,
  jobDiscoveryConfigurationV1Schema,
  type JobDiscoveryConfigurationV1,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';

const MAX_QUERY_WORDS = 24;
const INTERNSHIP_TERM = /\b(intern(?:ship)?|placement)\b/iu;

const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ');

/** Swap internship <-> placement so each is tried as a distinct query term. */
const swapInternshipTerm = (word: string) =>
  /placement/iu.test(word) ? 'internship' : 'placement';

/** Do not cut a phrase mid-word or silently drop an explicit place/year. */
function query(parts: string[], extras: string[]): string {
  const words = (value: string) => value.split(' ').length;
  const fits = (value: string) =>
    value.length <= WEB_LIMITS.maxQueryChars && words(value) <= MAX_QUERY_WORDS;

  let result = parts.map(normalize).filter(Boolean).join(' ');
  if (!fits(result)) {
    throw new AppError(
      'INVALID_INPUT',
      'Role, location and year exceed the search query limit.',
    );
  }

  for (const extra of extras) {
    const phrase = normalize(extra);
    if (!phrase || result.toLowerCase().includes(phrase.toLowerCase()))
      continue;
    if (fits(`${result} ${phrase}`)) result += ` ${phrase}`;
  }

  return result;
}

/**
 * Stable round-robin: first cover distinct roles, then add justified variants.
 */
export function planQueries(config: JobDiscoveryConfigurationV1): string[] {
  const parsed = jobDiscoveryConfigurationV1Schema.safeParse(config);
  if (!parsed.success)
    throw new AppError('INVALID_INPUT', 'Invalid discovery configuration.');

  const { intent } = parsed.data;
  const cap = Math.min(
    parsed.data.query.maxQueries,
    JOB_DISCOVERY_LIMITS.maxQueries,
  );

  const plans: string[] = [];
  const seen = new Set<string>();
  const add = (role: string, extras: string[]) => {
    const result = query(
      [role, intent.location ?? '', intent.targetYear?.toString() ?? ''],
      extras,
    );
    const key = result.toLowerCase();
    if (!seen.has(key) && plans.length < cap) {
      seen.add(key);
      plans.push(result);
    }
  };

  const roleExtras = (role: string, seniority = intent.seniority) => {
    const seniorityRepeatsRole =
      !!seniority &&
      INTERNSHIP_TERM.test(role) &&
      INTERNSHIP_TERM.test(seniority);
    const senioritySuffix = seniority && !seniorityRepeatsRole ? seniority : '';

    return [senioritySuffix, intent.field ?? ''];
  };

  for (const role of intent.targetRoles) add(role, roleExtras(role));

  // Placement is a different, relevant term only for explicitly
  // internship/placement intent.
  for (const role of intent.targetRoles) {
    const combined = `${role} ${intent.seniority ?? ''}`;
    if (!INTERNSHIP_TERM.test(combined)) continue;

    const variantRole = INTERNSHIP_TERM.test(role)
      ? role.replace(INTERNSHIP_TERM, swapInternshipTerm)
      : role;
    const variantSeniority = intent.seniority?.replace(
      INTERNSHIP_TERM,
      swapInternshipTerm,
    );
    add(variantRole, roleExtras(variantRole, variantSeniority));
  }

  // Company and keyword phrases are optional variants, never filters on every
  // query.
  for (const role of intent.targetRoles) {
    for (const company of intent.companies)
      add(role, [...roleExtras(role), company]);
    for (const keyword of intent.keywords)
      add(role, [...roleExtras(role), keyword]);
  }

  return plans;
}
