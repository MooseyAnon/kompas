import { describe, expect, it } from 'vitest';
import type {
  Application,
  OpportunityDetail,
  OpportunitySummary,
} from '../src/shared/contracts';
import {
  byMatch,
  jobView,
  missingNote,
} from '../src/renderer/presentation/gnd/pages/jobs/jobView';
import {
  forYou,
  nextInterview,
} from '../src/renderer/presentation/gnd/pages/home/homeView';
import {
  appliedLine,
  groupApplications,
  practiceFor,
  sortInterviews,
  initials,
  profileLine,
} from '../src/renderer/presentation/gnd/pages/applications/applicationsView';

const summary = (over: Partial<OpportunitySummary> = {}): OpportunitySummary =>
  ({
    opportunityId: '11111111-1111-4111-8111-111111111111',
    title: 'Graduate Engineer',
    company: 'Arm',
    location: 'Bristol',
    latestSource: null,
    decision: 'new',
    applicationId: null,
    verified: true,
    extractionStatus: 'extracted',
    matchStatus: 'scored',
    coverage: 0.5,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    lastSeenAt: null,
    ...over,
  }) as OpportunitySummary;

const field = (text: string) => ({ text, evidence: text });

function detail(over: Partial<OpportunitySummary> = {}): OpportunityDetail {
  return {
    ...summary(over),
    sources: [],
    sourcesTruncated: false,
    canonicalUrl: 'https://jobs.example.com/arm/1',
    verifiedCaptureId: null,
    verifiedAt: null,
    postingText: null,
    postingTextTruncated: false,
    skillFreshness: null,
    extraction: {
      jd: {
        title: field('Graduate Engineer – Systems'),
        company: field('Arm'),
        location: field('Cambridge / Bristol'),
        workArrangement: field('Hybrid'),
        salaryText: field('£42,500–£57,500 / year'),
      },
    },
    match: {
      status: 'scored',
      reason: 'COVERAGE',
      coverage: 0.5,
      matched: ['Python', 'Git'],
      unmatched: ['C++', 'Linux'],
      requiredCount: 4,
    },
  } as unknown as OpportunityDetail;
}

const app = (
  id: string,
  stageKind: Application['currentStage']['stageKind'],
  occurredAt = '2026-11-05T09:00:00.000Z',
  over: Partial<Application> = {},
): Application =>
  ({
    id,
    companyName: 'Arm',
    roleTitle: 'Graduate Program',
    location: 'Bristol',
    jobUrl: null,
    appliedAt: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    archivedAt: null,
    currentStage: {
      id: `${id}-s`,
      applicationId: id,
      stageLabel: stageKind === 'applied' ? 'Applied' : 'Interview',
      stageKind,
      stageSubtype: null,
      occurredAt,
      recordedAt: occurredAt,
      source: 'user',
      sourceRef: null,
      sourceEvidence: null,
      correctsEventId: null,
    },
    ...over,
  }) as Application;

describe('job cards', () => {
  it('prefers the read listing’s details and joins place and setup', () => {
    const job = jobView(summary(), detail());
    expect(job).toMatchObject({
      title: 'Graduate Engineer – Systems',
      place: 'Cambridge / Bristol · Hybrid',
      salary: '£42,500–£57,500 / year',
      matchPercent: 50,
      requiredCount: 4,
      listingUrl: 'https://jobs.example.com/arm/1',
    });
    expect(missingNote(job)).toBe(
      '2 key requirements not yet shown in your profile',
    );
  });

  it('falls back to the summary before the listing is read, without inventing a score', () => {
    const job = jobView(summary({ coverage: null, matchStatus: 'missing' }));
    expect(job).toMatchObject({
      title: 'Graduate Engineer',
      place: 'Bristol',
      salary: null,
      matchPercent: null,
    });
    expect(missingNote(job)).toBeNull();
  });

  it('sorts best matches first and unscored last', () => {
    const jobs = [
      jobView(summary({ opportunityId: 'a', coverage: null })),
      jobView(summary({ opportunityId: 'b', coverage: 0.9 })),
      jobView(summary({ opportunityId: 'c', coverage: 0.4 })),
    ].sort(byMatch);
    expect(jobs.map((job) => job.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('home', () => {
  it('points the For you card at the next useful step', () => {
    expect(forYou(3, false, true).title).toBe('3 new roles to review');
    expect(forYou(1, true, true).title).toBe('One new role to review');
    expect(forYou(0, true, true)).toMatchObject({ tab: 'discover' });
    expect(forYou(0, false, false)).toMatchObject({
      action: 'Set up a search',
      tab: 'filters',
    });
  });

  it('shows the soonest interview ahead, else the latest one', () => {
    const now = new Date('2026-11-10T00:00:00.000Z');
    const past = app('p', 'interview', '2026-11-01T09:00:00.000Z');
    const soon = app('s', 'interview', '2026-11-12T09:00:00.000Z');
    const later = app('l', 'interview', '2026-11-20T09:00:00.000Z');
    expect(nextInterview([later, past, soon], now)?.id).toBe('s');
    expect(nextInterview([past], now)?.id).toBe('p');
    expect(nextInterview([app('x', 'applied')], now)).toBeNull();
  });
});

describe('your applications', () => {
  it('counts only sent applications as applied; opened listings are openings', () => {
    const groups = groupApplications([
      app('a', 'applied'),
      app('i', 'interview'),
      app('s', 'saved'),
      app('z', 'applied', undefined, { archivedAt: '2026-11-06T00:00:00Z' }),
    ]);
    expect(groups.applied.map((x) => x.id)).toEqual(['a', 'i']);
    expect(groups.interviews.map((x) => x.id)).toEqual(['i']);
    expect(groups.openings.map((x) => x.id)).toEqual(['s']);
  });

  it('lists upcoming interviews soonest first, then past ones', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    const past = app('p', 'interview', '2026-11-01T09:00:00.000Z');
    const soon = app('s', 'interview', '2026-11-12T09:00:00.000Z');
    const later = app('l', 'interview', '2026-11-20T09:00:00.000Z');
    expect(sortInterviews([later, past, soon], now).map((x) => x.id)).toEqual([
      's',
      'l',
      'p',
    ]);
  });

  it('sets up a mock interview for a role', () => {
    expect(
      practiceFor({ roleTitle: 'Designer', companyName: 'Arm' }, 'deep_loop'),
    ).toEqual({
      method: 'deep_loop',
      subject: 'Designer at Arm',
      guidance: 'A mock interview for the Designer role at Arm.',
    });
  });

  it('builds the profile line and initials in the design’s shape', () => {
    expect(initials('Alex Morgan')).toBe('AM');
    expect(initials('  cher ')).toBe('C');
    expect(
      profileLine({ location: 'Bristol', currentRole: null } as never, [
        {
          category: 'education',
          roleTitle: 'BSc Computer Science',
          organisation: 'Example University',
          startDate: '2023-09-01',
          endDate: '2026-06-30',
        } as never,
      ]),
    ).toBe('Bristol · BSc Computer Science · Example University · 2023–2026');
    expect(appliedLine(app('a', 'applied'))).toBe(
      'Marked as applied by you · 5 Nov 2026',
    );
  });
});

import { formFromPreset } from '../src/renderer/pages/interviews/prepare/prepareForm';

describe('practice presets', () => {
  it('fills the Prepare form without starting anything', () => {
    expect(formFromPreset()).toEqual(
      expect.objectContaining({ method: 'quick_fire', subject: '' }),
    );
    expect(
      formFromPreset({ method: 'deep_loop', subject: 'Designer at Arm' }),
    ).toEqual(
      expect.objectContaining({
        method: 'deep_loop',
        subject: 'Designer at Arm',
        additionalGuidance: '',
      }),
    );
  });
});
