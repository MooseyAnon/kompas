import type { DiscoveryMatch, ExtractedJd } from '../../../shared/contracts';

/** Only ordinary punctuation/case/spacing and these literal spelling variants.
 * No synonyms, inferred technologies, substring matches or skill hierarchy. */
const MATCH_SCHEMA_VERSION = 1;
const SCORER_VERSION = 'required-skills-v1';

const ALIASES: Record<string, string> = {
  nodejs: 'nodejs',
  'node js': 'nodejs',
  javascript: 'javascript',
  'java script': 'javascript',
  typescript: 'typescript',
  'type script': 'typescript',
};

export function skillKey(name: string): string {
  const cleaned = name
    .toLocaleLowerCase()
    .normalize('NFKC')
    // Keep + and # significant: C++, C# and C are distinct skills.
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  return ALIASES[cleaned] ?? cleaned;
}

export function matchRequiredSkills(input: {
  opportunityId: string;
  extractionId: string | null;
  jd: ExtractedJd | null;
  confirmedSkills: string[] | null;
  profileLocation: string | null;
  fingerprint: string | null;
  computedAt: string;
}): DiscoveryMatch {
  const required = new Map<string, string>();
  for (const skill of input.jd?.requiredSkills ?? []) {
    // Interpretations from 013.6 must carry a real evidence quote. Never count
    // inferred, preferred, or unsupported skills in the positive denominator.
    const key = skillKey(skill.text);
    if (key && skill.evidence.trim() && !required.has(key))
      required.set(key, skill.text);
  }

  const known = new Set(
    (input.confirmedSkills ?? []).map(skillKey).filter(Boolean),
  );

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const [key, label] of required) {
    if (input.confirmedSkills === null) continue;
    (known.has(key) ? matched : unmatched).push(label);
  }

  const reason = matchReason(input, required.size, known.size);
  const scored = reason === 'COVERAGE';
  const location = locationAlignment(
    input.jd?.location?.text,
    input.profileLocation,
  );

  return {
    schemaVersion: MATCH_SCHEMA_VERSION,
    opportunityId: input.opportunityId,
    extractionId: input.extractionId,
    status: scored ? 'scored' : 'unscored',
    reason,
    coverage: scored ? matched.length / required.size : null,
    matched,
    unmatched,
    requiredCount: required.size,
    scorerVersion: SCORER_VERSION,
    profileSkillFingerprint: input.fingerprint,
    explicitMinimumYears: input.jd?.minimumYearsExperience?.value ?? null,
    // Identity has no approved numeric years or seniority fact. An inferred JD
    // seniority/experience band is never presented as explicit alignment.
    alignment: { location, years: 'unknown', seniority: 'unknown' },
    computedAt: input.computedAt,
  };
}

function matchReason(
  input: { jd: ExtractedJd | null; confirmedSkills: string[] | null },
  requiredCount: number,
  knownCount: number,
): DiscoveryMatch['reason'] {
  if (!input.jd) return 'NO_EXTRACTION';
  if (!requiredCount) return 'NO_REQUIRED_SKILLS';
  if (input.confirmedSkills === null) return 'PROFILE_UNAVAILABLE';
  if (!knownCount) return 'NO_CONFIRMED_SKILLS';

  return 'COVERAGE';
}

function locationAlignment(
  sourceLocation: string | undefined,
  profileLocation: string | null,
): DiscoveryMatch['alignment']['location'] {
  if (!sourceLocation || !profileLocation) return 'unknown';

  return skillKey(sourceLocation) === skillKey(profileLocation)
    ? 'match'
    : 'different';
}

/** Scored first, descending; deterministic tie and unscored order. */
export function sortMatches(items: DiscoveryMatch[]): DiscoveryMatch[] {
  return [...items].sort(
    (a, b) =>
      (b.coverage ?? -1) - (a.coverage ?? -1) ||
      a.opportunityId.localeCompare(b.opportunityId),
  );
}
