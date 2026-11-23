import { describe, expect, it } from 'vitest';
import {
  newJobDiscoveryConfiguration,
  jobDiscoveryConfigurationV1Schema,
} from '../src/shared/contracts';
import {
  defaultPlaces,
  knownPlace,
  suggestPlaces,
} from '../src/renderer/presentation/gnd/pages/jobs/places';
import {
  fitsPreferences,
  parseSalary,
  preferencesOf,
  summaryChips,
  withoutChip,
  withPreferences,
  type ListingFacts,
  type Preferences,
} from '../src/renderer/presentation/gnd/pages/jobs/searchPreferences';

const intent = () => ({
  ...newJobDiscoveryConfiguration().intent,
  targetRoles: ['Product Designer'],
});
const facts = (over: Partial<ListingFacts> = {}): ListingFacts => ({
  title: 'Product Designer',
  location: '',
  arrangement: '',
  employment: '',
  seniority: '',
  minYears: null,
  salaryText: '',
  ...over,
});
const prefs = (over: Partial<Preferences> = {}): Preferences => ({
  ...preferencesOf(intent()),
  ...over,
});

describe('places', () => {
  it('suggests places as you type, skipping ones already picked', () => {
    expect(suggestPlaces('Lon', [])[0].value).toBe('London');
    expect(suggestPlaces('lon', ['London']).map((p) => p.value)).not.toContain(
      'London',
    );
    expect(suggestPlaces('york', []).map((p) => p.value)).toEqual(
      expect.arrayContaining(['York', 'New York']),
    );
    expect(suggestPlaces('', [])).toEqual([]);
    expect(knownPlace('münchen')).toBeNull();
    expect(knownPlace('malmo')).toBe('Malmö');
  });
  it('starts with London plus the city they are in, never twice', () => {
    expect(defaultPlaces('Leeds, UK', 'Europe/London')).toEqual([
      'London',
      'Leeds',
    ]);
    expect(defaultPlaces(null, 'Europe/London')).toEqual(['London']);
    expect(defaultPlaces('', 'Europe/Berlin')).toEqual(['London', 'Berlin']);
    expect(defaultPlaces('Nowhere', 'Etc/UTC')).toEqual(['London']);
  });
});

describe('search preferences', () => {
  it('reads older single-value searches and writes valid configurations', () => {
    const old = {
      ...intent(),
      location: 'Leeds',
      workArrangement: 'hybrid' as const,
    };
    expect(preferencesOf(old)).toMatchObject({
      locations: ['Leeds'],
      setups: ['hybrid'],
    });
    const next = withPreferences(old, {
      locations: ['London', 'Leeds'],
      setups: ['remote', 'hybrid'],
      levels: ['senior'],
      salary: { minimum: 70000, currency: 'GBP', onlyWithSalary: true },
    });
    expect(next.location).toBe('London');
    expect(next.workArrangement).toBe('any');
    const config = {
      ...newJobDiscoveryConfiguration(),
      name: 'x',
      intent: next,
    };
    expect(jobDiscoveryConfigurationV1Schema.safeParse(config).success).toBe(
      true,
    );
    const chips = summaryChips(next).map((c) => c.label);
    expect(chips).toEqual([
      'Product Designer',
      'London',
      'Leeds',
      'Remote',
      'Hybrid',
      'Senior',
      '£70k+ a year',
      'Salary shown',
    ]);
    const fewer = withoutChip(next, 'location:London');
    expect(fewer.locations).toEqual(['Leeds']);
    expect(fewer.location).toBe('Leeds');
  });

  it('reads yearly salary ranges from listing text', () => {
    expect(parseSalary('£45,000 - £55,000 per annum')).toEqual({
      currency: 'GBP',
      low: 45000,
      high: 55000,
    });
    expect(parseSalary('£45-55k')).toMatchObject({ low: 45000, high: 55000 });
    expect(parseSalary('$120k + equity')).toMatchObject({
      currency: 'USD',
      high: 120000,
    });
    expect(parseSalary('£450 per day')?.high).toBe(103500);
    expect(parseSalary('Competitive')).toBeNull();
    expect(parseSalary('5 days a week')).toBeNull();
  });

  it('hides roles that clearly don’t fit, and keeps ones that don’t say', () => {
    expect(fitsPreferences(facts(), prefs({ setups: ['remote'] })).fits).toBe(
      true,
    );
    expect(
      fitsPreferences(
        facts({ arrangement: 'On-site' }),
        prefs({ setups: ['remote'] }),
      ).fits,
    ).toBe(false);
    expect(
      fitsPreferences(
        facts({ location: 'Manchester, England' }),
        prefs({ locations: ['London'] }),
      ),
    ).toEqual({ fits: false, reason: 'location' });
    expect(
      fitsPreferences(
        facts({ location: 'Manchester', arrangement: 'Remote' }),
        prefs({ locations: ['London'] }),
      ).fits,
    ).toBe(true);
    expect(
      fitsPreferences(
        facts({ location: 'Leeds, England' }),
        prefs({ locations: ['United Kingdom'] }),
      ).fits,
    ).toBe(true);
    expect(
      fitsPreferences(
        facts({ employment: 'Contract, 6 months' }),
        prefs({ contracts: ['full_time'] }),
      ).fits,
    ).toBe(false);
    expect(
      fitsPreferences(facts({ minYears: 7 }), prefs({ levels: ['junior'] }))
        .fits,
    ).toBe(false);
    expect(
      fitsPreferences(
        facts({ title: 'Senior Product Designer' }),
        prefs({ levels: ['senior', 'expert'] }),
      ).fits,
    ).toBe(true);
    const salary = {
      minimum: 60000,
      currency: 'GBP' as const,
      onlyWithSalary: false,
    };
    expect(
      fitsPreferences(
        facts({ salaryText: '£40,000 - £50,000' }),
        prefs({ salary }),
      ).fits,
    ).toBe(false);
    expect(fitsPreferences(facts(), prefs({ salary })).fits).toBe(true);
    expect(
      fitsPreferences(
        facts(),
        prefs({ salary: { ...salary, onlyWithSalary: true } }),
      ).fits,
    ).toBe(false);
  });
});
