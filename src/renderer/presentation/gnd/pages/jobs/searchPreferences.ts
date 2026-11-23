// Search preferences (ADR 006): labels, the summary chips, reading several
// values from a saved search, and whether a found role fits them. Pure.
import type {
  ContractType,
  ExperienceLevel,
  JobDiscoveryConfigurationV1,
  SalaryCurrency,
  WorkSetup,
} from '../../../../../shared/contracts';
import { citiesIn, countryOf } from './places';

type Intent = JobDiscoveryConfigurationV1['intent'];

export const SETUP_OPTIONS: { value: WorkSetup; label: string }[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'on_site', label: 'On-site' },
];
export const LEVEL_OPTIONS: {
  value: ExperienceLevel;
  label: string;
  years: string;
}[] = [
  { value: 'entry', label: 'Entry-level / Graduate', years: '0–1 years' },
  { value: 'junior', label: 'Junior', years: '1–3 years' },
  { value: 'mid', label: 'Mid-level', years: '3–5 years' },
  { value: 'senior', label: 'Senior', years: '5–10 years' },
  { value: 'expert', label: 'Expert & leadership', years: '10+ years' },
];
export const CONTRACT_OPTIONS: { value: ContractType; label: string }[] = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contract', label: 'Contract / Freelance' },
  { value: 'temporary', label: 'Temporary' },
  { value: 'internship', label: 'Internship' },
  { value: 'apprenticeship', label: 'Apprenticeship' },
];
export const CURRENCY_SYMBOL: Record<SalaryCurrency, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
};

export type Preferences = {
  locations: string[];
  setups: WorkSetup[];
  levels: ExperienceLevel[];
  contracts: ContractType[];
  salary: NonNullable<Intent['salary']>;
};

/** A saved search's preferences, reading older single-value searches too. */
export function preferencesOf(intent: Intent): Preferences {
  return {
    locations: intent.locations ?? (intent.location ? [intent.location] : []),
    setups:
      intent.workArrangements ??
      (intent.workArrangement && intent.workArrangement !== 'any'
        ? [intent.workArrangement]
        : []),
    levels: intent.experienceLevels ?? [],
    contracts: intent.contractTypes ?? [],
    salary: intent.salary ?? {
      minimum: null,
      currency: 'GBP',
      onlyWithSalary: false,
    },
  };
}

/** The intent with these preferences, keeping the single fields in step. */
export function withPreferences(
  intent: Intent,
  patch: Partial<Preferences>,
): Intent {
  const next = { ...preferencesOf(intent), ...patch };
  return {
    ...intent,
    locations: next.locations,
    location: next.locations[0] ?? null,
    workArrangements: next.setups,
    workArrangement: next.setups.length === 1 ? next.setups[0] : 'any',
    experienceLevels: next.levels,
    contractTypes: next.contracts,
    salary: next.salary,
  };
}

export function formatSalary(amount: number, currency: SalaryCurrency): string {
  const symbol = CURRENCY_SYMBOL[currency];
  return amount >= 1000 && amount % 1000 === 0
    ? `${symbol}${amount / 1000}k`
    : `${symbol}${amount.toLocaleString('en-GB')}`;
}

export type SummaryChip = { key: string; label: string };

/** "Your preferences": one chip per choice, in the order the sections run. */
export function summaryChips(intent: Intent): SummaryChip[] {
  const prefs = preferencesOf(intent);
  const label = <T extends string>(
    options: { value: T; label: string }[],
    value: T,
  ) => options.find((o) => o.value === value)?.label ?? value;
  return [
    ...intent.targetRoles.map((r) => ({ key: `role:${r}`, label: r })),
    ...prefs.locations.map((l) => ({ key: `location:${l}`, label: l })),
    ...prefs.setups.map((s) => ({
      key: `setup:${s}`,
      label: label(SETUP_OPTIONS, s),
    })),
    ...prefs.levels.map((l) => ({
      key: `level:${l}`,
      label: label(LEVEL_OPTIONS, l),
    })),
    ...prefs.contracts.map((c) => ({
      key: `contract:${c}`,
      label: label(CONTRACT_OPTIONS, c),
    })),
    ...(prefs.salary.minimum
      ? [
          {
            key: 'salary',
            label: `${formatSalary(prefs.salary.minimum, prefs.salary.currency)}+ a year`,
          },
        ]
      : []),
    ...(prefs.salary.onlyWithSalary
      ? [{ key: 'with-salary', label: 'Salary shown' }]
      : []),
    ...(intent.field ? [{ key: 'field', label: intent.field }] : []),
    ...intent.companies.map((c) => ({ key: `company:${c}`, label: c })),
    ...intent.keywords.map((k) => ({ key: `keyword:${k}`, label: k })),
  ];
}

/** Remove one summary chip's choice from the intent. */
export function withoutChip(intent: Intent, key: string): Intent {
  const [kind, ...rest] = key.split(':');
  const value = rest.join(':');
  const prefs = preferencesOf(intent);
  switch (kind) {
    case 'role':
      return {
        ...intent,
        targetRoles: intent.targetRoles.filter((r) => r !== value),
      };
    case 'location':
      return withPreferences(intent, {
        locations: prefs.locations.filter((l) => l !== value),
      });
    case 'setup':
      return withPreferences(intent, {
        setups: prefs.setups.filter((s) => s !== value),
      });
    case 'level':
      return withPreferences(intent, {
        levels: prefs.levels.filter((l) => l !== value),
      });
    case 'contract':
      return withPreferences(intent, {
        contracts: prefs.contracts.filter((c) => c !== value),
      });
    case 'salary':
      return withPreferences(intent, {
        salary: { ...prefs.salary, minimum: null },
      });
    case 'with-salary':
      return withPreferences(intent, {
        salary: { ...prefs.salary, onlyWithSalary: false },
      });
    case 'field':
      return { ...intent, field: null };
    case 'company':
      return {
        ...intent,
        companies: intent.companies.filter((c) => c !== value),
      };
    case 'keyword':
      return {
        ...intent,
        keywords: intent.keywords.filter((k) => k !== value),
      };
    default:
      return intent;
  }
}

/* ---------- Does a found role fit? ---------- */

/** What a listing says, as read from it (any may be missing). */
export type ListingFacts = {
  title: string;
  location: string;
  arrangement: string;
  employment: string;
  seniority: string;
  minYears: number | null;
  salaryText: string;
};

export type Salary = {
  currency: SalaryCurrency | null;
  low: number;
  high: number;
};

/**
 * A yearly salary range from listing text: "£45,000 - £55,000", "£45-55k",
 * "$120k", "£450 per day", "£25/hour". Null when there's no figure.
 */
export function parseSalary(text: string): Salary | null {
  if (!text) return null;
  const currency: SalaryCurrency | null = /£|gbp/iu.test(text)
    ? 'GBP'
    : /€|eur/iu.test(text)
      ? 'EUR'
      : /\$|usd/iu.test(text)
        ? 'USD'
        : null;
  const matches = [
    ...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?/giu),
  ];
  if (!matches.length) return null;
  const anyK = matches.some((m) => m[2]);
  let values = matches
    .map((m) => {
      const n = Number(m[1].replace(/,/gu, ''));
      return m[2] || (anyK && n < 1000) ? n * 1000 : n;
    })
    .filter((n) => n > 0);
  if (!values.length) return null;
  const per = /hour|\bhr\b|p\/?h\b/iu.test(text)
    ? 1950
    : /\bday\b|daily|p\/?d\b/iu.test(text)
      ? 230
      : /month|pcm|\bp\/?m\b/iu.test(text)
        ? 12
        : 1;
  values = values.map((n) => Math.round(n * per));
  // A bare "5" in "5 days a week" is not pay; keep plausible yearly figures.
  const yearly = values.filter((n) => n >= 5000);
  if (!yearly.length) return null;
  return {
    currency,
    low: Math.min(...yearly),
    high: Math.max(...yearly),
  };
}

const SETUP_TEST: Record<WorkSetup, RegExp> = {
  remote: /remote|work from home|wfh/iu,
  hybrid: /hybrid/iu,
  on_site: /on[- ]?site|in[- ]office|office[- ]based|in[- ]person/iu,
};
const CONTRACT_TEST: Record<ContractType, RegExp> = {
  full_time: /full[- ]?time|permanent/iu,
  part_time: /part[- ]?time/iu,
  contract: /contract|freelance|fixed[- ]term|\bftc\b/iu,
  temporary: /temporary|\btemp\b|seasonal/iu,
  internship: /intern|placement/iu,
  apprenticeship: /apprentice/iu,
};
const LEVEL_TEST: Record<ExperienceLevel, RegExp> = {
  entry: /graduate|entry|intern|placement|trainee/iu,
  junior: /junior|associate/iu,
  mid: /mid[- ]?(level|weight|senior)?\b|intermediate/iu,
  senior: /senior|\bsr\b/iu,
  expert: /lead|principal|staff|head of|director|vp\b|chief/iu,
};

function levelOfYears(years: number): ExperienceLevel {
  if (years < 1) return 'entry';
  if (years < 3) return 'junior';
  if (years < 5) return 'mid';
  if (years < 10) return 'senior';
  return 'expert';
}

export type FitResult = { fits: boolean; reason?: string };

/**
 * Whether a role fits the preferences. A listing that doesn't say passes, so
 * unknown details never hide a role, except "Only show jobs with salary".
 */
export function fitsPreferences(
  facts: ListingFacts,
  prefs: Preferences,
): FitResult {
  const mentioned = (re: RegExp, ...texts: string[]) =>
    texts.some((t) => re.test(t));

  const where = `${facts.location} ${facts.arrangement}`;
  const saysSetup = (Object.keys(SETUP_TEST) as WorkSetup[]).filter((s) =>
    mentioned(SETUP_TEST[s], where),
  );
  if (
    prefs.setups.length &&
    saysSetup.length &&
    !saysSetup.some((s) => prefs.setups.includes(s))
  )
    return { fits: false, reason: 'work setup' };

  const isRemote = saysSetup.includes('remote');
  if (prefs.locations.length && facts.location && !isRemote) {
    const here = facts.location.toLowerCase();
    const near = prefs.locations.some((place) => {
      const city = place.split(',')[0].trim().toLowerCase();
      if (here.includes(city)) return true;
      return citiesIn(place).some((c) => here.includes(c.toLowerCase()));
    });
    // A listing naming only its country passes for any city in that country.
    const sameCountry = prefs.locations.some((place) => {
      const country = countryOf(place);
      return !!country && here === country.toLowerCase();
    });
    if (!near && !sameCountry) return { fits: false, reason: 'location' };
  }

  if (prefs.contracts.length && facts.employment) {
    const says = (Object.keys(CONTRACT_TEST) as ContractType[]).filter((c) =>
      CONTRACT_TEST[c].test(facts.employment),
    );
    if (says.length && !says.some((c) => prefs.contracts.includes(c)))
      return { fits: false, reason: 'contract type' };
  }

  if (prefs.levels.length) {
    const says = new Set<ExperienceLevel>();
    if (facts.minYears !== null) says.add(levelOfYears(facts.minYears));
    const text = facts.seniority || facts.title;
    for (const level of Object.keys(LEVEL_TEST) as ExperienceLevel[])
      if (LEVEL_TEST[level].test(text)) says.add(level);
    if (says.size && ![...says].some((l) => prefs.levels.includes(l)))
      return { fits: false, reason: 'experience level' };
  }

  const salary = parseSalary(facts.salaryText);
  if (prefs.salary.onlyWithSalary && !salary)
    return { fits: false, reason: 'salary' };
  if (
    prefs.salary.minimum &&
    salary &&
    (salary.currency === null || salary.currency === prefs.salary.currency) &&
    salary.high < prefs.salary.minimum
  )
    return { fits: false, reason: 'salary' };

  return { fits: true };
}
