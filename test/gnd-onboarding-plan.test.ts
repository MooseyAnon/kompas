import { describe, expect, it } from 'vitest';
import {
  applyImportInputSchema,
  jobDiscoveryConfigurationV1Schema,
  type CvCandidate,
  type CvDraft,
} from '../src/shared/contracts';
import { planQueries } from '../src/main/modules/job-discovery/query-planner';
import {
  addRole,
  profileCard,
  profileImportFrom,
  searchConfigFor,
  skillsFrom,
  suggestRoles,
} from '../src/renderer/presentation/gnd/pages/onboarding/onboardingPlan';

const IMPORT_ID = '6f0b1c9e-3c2a-4a8e-9a77-0a1b2c3d4e5f';

const found = (value: string): CvCandidate => ({
  value,
  status: 'detected',
  origin: 'llm',
  evidence: null,
  blockIndex: null,
  reasons: [],
});
const unsure = (value: string): CvCandidate => ({
  ...found(value),
  status: 'ambiguous',
});
const none: CvCandidate = { ...found(''), value: null, status: 'missing' };

function experience(
  category: CvDraft['experiences'][number]['category'],
  roleTitle: CvCandidate,
  extra: Partial<CvDraft['experiences'][number]> = {},
): CvDraft['experiences'][number] {
  return {
    category,
    roleTitle,
    organisation: none,
    startDate: none,
    endDate: none,
    description: none,
    ...extra,
  };
}

function draft(overrides: Partial<CvDraft> = {}): CvDraft {
  return {
    parserVersion: 'cv-extract-full-v1',
    adapterId: 'pdf',
    adapterVersion: '1',
    profile: {
      displayName: found('Alex Morgan'),
      currentRole: found('Senior Product Designer'),
      location: found('Bristol'),
      currentStage: found('employed'),
      summary: unsure('Designer who…'),
    },
    experiences: [
      experience('employment', found('Senior Product Designer'), {
        organisation: found('Northwind'),
        startDate: found('2021-06-01'),
        endDate: found('present'),
      }),
      experience('employment', found('Lead UX Researcher')),
      experience('project', found('UI design')),
      experience('employment', unsure('Barista')),
      experience('education', found('BSc Computer Science'), {
        organisation: found('Example University'),
        startDate: found('2023-09-01'),
        endDate: found('2026-06-30'),
      }),
    ],
    extras: {
      email: none,
      phone: none,
      skills: [found('Figma'), found('Figma'), unsure('Juggling')],
    },
    ...overrides,
  };
}

describe('onboarding role suggestions', () => {
  it('suggests directions from detected titles only, current role first, without seniority or education', () => {
    expect(suggestRoles(draft())).toEqual([
      'Product Designer',
      'UX Researcher',
      'UI design',
    ]);
    expect(suggestRoles(null)).toEqual([]);
  });

  it('caps suggestions at the saved-search limit of five', () => {
    const many = draft({
      experiences: Array.from({ length: 9 }, (_, i) =>
        experience('employment', found(`Role ${i}`)),
      ),
    });
    expect(suggestRoles(many)).toHaveLength(5);
  });

  it('adds typed roles once, trimmed, and never past five', () => {
    expect(addRole(['Designer'], '  ux   researcher ')).toEqual([
      'Designer',
      'ux researcher',
    ]);
    const same = ['Designer'];
    expect(addRole(same, 'DESIGNER')).toBe(same);
    expect(addRole(same, '   ')).toBe(same);
    const full = ['a', 'b', 'c', 'd', 'e'];
    expect(addRole(full, 'f')).toBe(full);
  });
});

describe('onboarding profile approval', () => {
  it('writes only detected facts, keeps invalid dates out, and passes the apply contract', () => {
    const input = profileImportFrom(IMPORT_ID, draft())!;
    expect(applyImportInputSchema.safeParse(input).success).toBe(true);
    expect(input.profile).toEqual({
      displayName: 'Alex Morgan',
      currentRole: 'Senior Product Designer',
      location: 'Bristol',
      currentStage: 'employed',
    });
    expect(
      input.experiences.map((e) => 'value' in e && e.value.roleTitle),
    ).toEqual([
      'Senior Product Designer',
      'Lead UX Researcher',
      'UI design',
      'BSc Computer Science',
    ]);
    const first = input.experiences[0];
    expect('value' in first && first.value.startDate).toBe('2021-06-01');
    expect('value' in first && first.value.endDate).toBeNull();
  });

  it('confirms skills once and ignores unsure ones', () => {
    expect(skillsFrom(draft())).toEqual(['Figma']);
  });

  it('builds the card in the design’s shape', () => {
    const card = profileCard(
      draft({
        profile: { ...draft().profile, currentRole: none },
      }),
      ['Product Design', 'UX/UI'],
      'London',
      'any',
    );
    expect(card).toEqual({
      name: 'Alex Morgan',
      details: ['Bristol · BSc Computer Science'],
      lookingFor: 'Product Design · UX/UI',
      arrangement: 'London · Open to hybrid, remote & in person',
    });
    expect(profileCard(null, [], '', 'remote').name).toBe('Your profile');
  });
});

describe('onboarding saved search', () => {
  it('produces a valid configuration whose queries carry the arrangement', () => {
    const config = searchConfigFor(
      ['Product Designer', 'UX Researcher'],
      ' London ',
      'hybrid',
    );
    expect(jobDiscoveryConfigurationV1Schema.safeParse(config).success).toBe(
      true,
    );
    expect(config.intent.location).toBe('London');
    expect(config.name).toBe('Product Designer roles');
    expect(planQueries(config)[0]).toBe('Product Designer London hybrid');
  });
});
