import {
  JOB_DISCOVERY_LIMITS,
  WEB_LIMITS,
  jobDiscoveryConfigurationV1Schema,
  type ContractType,
  type ExperienceLevel,
  type JobDiscoveryConfigurationV1,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';

const MAX_QUERY_WORDS = 24;
const INTERNSHIP_TERM = /\b(intern(?:ship)?|placement)\b/iu;

/** Words boards understand for each level; mid-level postings rarely say so. */
const LEVEL_TERM: Record<ExperienceLevel, string | null> = {
  entry: 'graduate',
  junior: 'junior',
  mid: null,
  senior: 'senior',
  expert: 'lead',
};
const CONTRACT_TERM: Record<ContractType, string> = {
  full_time: '',
  part_time: 'part time',
  contract: 'contract',
  temporary: 'temporary',
  internship: 'internship',
  apprenticeship: 'apprenticeship',
};

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
 * ADR 006: the search words for a saved search's preferences. Lists replace
 * their single-value fields when present.
 */
function preferenceTerms(intent: JobDiscoveryConfigurationV1['intent']) {
  const locations = intent.locations?.length
    ? intent.locations
    : [intent.location ?? ''];
  const levels: (string | null)[] = intent.experienceLevels?.length
    ? [...new Set(intent.experienceLevels.map((level) => LEVEL_TERM[level]))]
    : [intent.seniority];
  // Remote and hybrid are search terms boards understand; on-site and 'any'
  // add nothing, since most listings are on-site by default. With several
  // setups picked, no term is added so none is excluded.
  const setups = intent.workArrangements
    ? intent.workArrangements
    : intent.workArrangement && intent.workArrangement !== 'any'
      ? [intent.workArrangement]
      : [];
  const arrangement =
    setups.length === 1 && setups[0] !== 'on_site' ? setups[0] : '';
  const contracts = intent.contractTypes ?? [];
  const contract = contracts.length === 1 ? CONTRACT_TERM[contracts[0]] : '';

  return { locations, levels, arrangement, contract };
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
  const add = (role: string, location: string, extras: string[]) => {
    const result = query(
      [role, location, intent.targetYear?.toString() ?? ''],
      extras,
    );
    const key = result.toLowerCase();
    if (!seen.has(key) && plans.length < cap) {
      seen.add(key);
      plans.push(result);
    }
  };

  const { locations, levels, arrangement, contract } = preferenceTerms(intent);

  const roleExtras = (role: string, seniority: string | null) => {
    const seniorityRepeatsRole =
      !!seniority &&
      INTERNSHIP_TERM.test(role) &&
      INTERNSHIP_TERM.test(seniority);
    const senioritySuffix = seniority && !seniorityRepeatsRole ? seniority : '';
    const contractRepeatsRole =
      INTERNSHIP_TERM.test(role) && INTERNSHIP_TERM.test(contract);

    return [
      senioritySuffix,
      intent.field ?? '',
      arrangement,
      contractRepeatsRole ? '' : contract,
    ];
  };

  // Cover every role and every location early: each round pairs role r with
  // location (r + round), so two roles in two places take four queries, not
  // two queries in the first place only. Levels rotate across those queries.
  const roles = intent.targetRoles;
  const pairs: [string, string][] = [];
  for (let round = 0; round < locations.length; round++)
    for (let r = 0; r < roles.length; r++)
      pairs.push([roles[r], locations[(r + round) % locations.length]]);
  pairs.forEach(([role, location], index) =>
    add(role, location, roleExtras(role, levels[index % levels.length])),
  );
  for (const level of levels)
    for (const [role, location] of pairs)
      add(role, location, roleExtras(role, level));

  // Placement is a different, relevant term only for explicitly
  // internship/placement intent.
  const [firstLocation] = locations;
  const [firstLevel] = levels;
  for (const role of roles) {
    const combined = `${role} ${firstLevel ?? ''} ${contract}`;
    if (!INTERNSHIP_TERM.test(combined)) continue;

    const variantRole = INTERNSHIP_TERM.test(role)
      ? role.replace(INTERNSHIP_TERM, swapInternshipTerm)
      : role;
    const variantSeniority =
      firstLevel?.replace(INTERNSHIP_TERM, swapInternshipTerm) ?? null;
    add(variantRole, firstLocation, roleExtras(variantRole, variantSeniority));
  }

  // Company and keyword phrases are optional variants, never filters on every
  // query.
  for (const role of roles) {
    for (const company of intent.companies)
      add(role, firstLocation, [...roleExtras(role, firstLevel), company]);
    for (const keyword of intent.keywords)
      add(role, firstLocation, [...roleExtras(role, firstLevel), keyword]);
  }

  return plans;
}
