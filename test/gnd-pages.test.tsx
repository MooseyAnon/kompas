// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifications } from '../src/renderer/app/Notifications';
import { JobDetail } from '../src/renderer/presentation/gnd/pages/jobs/JobDetail';
import { ApplicationsPage } from '../src/renderer/presentation/gnd/pages/applications/ApplicationsPage';
import { QuickActions } from '../src/renderer/presentation/gnd/pages/home/QuickActions';

const api = vi.hoisted(() => ({
  getReviewOpportunity: vi.fn(),
  decideReviewOpportunity: vi.fn(),
  previewReviewApply: vi.fn(),
  applyReviewOpportunity: vi.fn(),
  getProfile: vi.fn(),
  listExperiences: vi.fn(),
  listConfirmedSkills: vi.fn(),
  listTargets: vi.fn(),
  listSavedSearches: vi.fn(),
  listApplications: vi.fn(),
  getApplication: vi.fn(),
  openDocument: vi.fn(),
  recordApplicationStage: vi.fn(),
  listReviewOpportunities: vi.fn(),
  updateProfile: vi.fn(),
  listDocuments: vi.fn(),
  importDocument: vi.fn(),
  replaceConfirmedSkills: vi.fn(),
}));
vi.mock('../src/renderer/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/api')>()),
  ...api,
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const ID = '11111111-1111-4111-8111-111111111111';
const field = (text: string) => ({ text, evidence: text });

const scored = {
  opportunityId: ID,
  title: 'Graduate Software Engineer',
  company: 'Graphcore',
  location: 'Bristol',
  latestSource: null,
  decision: 'new',
  applicationId: null,
  coverage: 0.5,
  canonicalUrl: 'https://jobs.example.com/graphcore/1',
  extraction: {
    jd: {
      title: field('Graduate Software Engineer, AI/ML Test Systems 2027'),
      company: field('Graphcore'),
      location: field('Cambridge / Bristol'),
      workArrangement: field('Hybrid · varies by team'),
      salaryText: field('£48,000 (Bachelor’s)'),
      employmentType: field('Graduate programme'),
      responsibilities: [field('Build ML test workloads.')],
    },
  },
  match: {
    status: 'scored',
    reason: 'COVERAGE',
    coverage: 0.5,
    matched: ['Python', 'Relevant degree'],
    unmatched: ['C++', 'Linux'],
    requiredCount: 4,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('open', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const text = () => container.textContent ?? '';
async function click(name: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!button) throw new Error(`No button ${name}`);
  await act(async () => button.click());
}

describe('job detail', () => {
  it('shows the read listing, the 2 of 4 match and each requirement honestly', async () => {
    api.getReviewOpportunity.mockResolvedValue(scored);
    await act(async () =>
      root.render(
        <JobDetail opportunityId={ID} onBack={vi.fn()} onNavigate={vi.fn()} />,
      ),
    );
    expect(text()).toContain(
      'Graduate Software Engineer, AI/ML Test Systems 2027',
    );
    expect(text()).toContain('£48,000 (Bachelor’s)');
    expect(text()).toContain('Hybrid · varies by team');
    expect(text()).toContain('50%');
    expect(text()).toContain('2 of 4 requirements reflected');
    expect(text()).toContain('Python · reflected');
    expect(text()).toContain('C++ · not yet shown');
    expect(container.querySelectorAll('.gnd-match-bar .is-on')).toHaveLength(2);
    expect(
      container.querySelector('a[href="https://jobs.example.com/graphcore/1"]'),
    ).not.toBeNull();
  });

  it('says why a job is not scored instead of showing a number', async () => {
    api.getReviewOpportunity.mockResolvedValue({
      ...scored,
      coverage: null,
      extraction: null,
      match: null,
    });
    await act(async () =>
      root.render(
        <JobDetail opportunityId={ID} onBack={vi.fn()} onNavigate={vi.fn()} />,
      ),
    );
    expect(text()).toContain('Not scored yet');
    expect(text()).toContain('The listing hasn’t been read yet.');
    expect(text()).not.toContain('%');
  });

  it('apply opens the listing and keeps it as an opening until the user says they applied', async () => {
    api.getReviewOpportunity.mockResolvedValue(scored);
    api.previewReviewApply.mockResolvedValue({
      applicationId: null,
      dismissed: false,
      unverified: false,
      snapshot: 'available',
      manualMatchId: null,
    });
    api.applyReviewOpportunity.mockResolvedValue('app-1');
    const onNavigate = vi.fn();
    await act(async () =>
      root.render(
        <JobDetail
          opportunityId={ID}
          onBack={vi.fn()}
          onNavigate={onNavigate}
        />,
      ),
    );
    await click('Apply for role');
    expect(window.open).toHaveBeenCalledWith(
      'https://jobs.example.com/graphcore/1',
      '_blank',
      'noopener',
    );
    // Tracked as an opening (the back end's "saved" stage), not as applied.
    expect(api.applyReviewOpportunity).toHaveBeenCalledWith(ID, {
      confirmUnverified: false,
      withoutSnapshot: false,
      allowDuplicate: false,
    });
    expect(api.recordApplicationStage).not.toHaveBeenCalled();
    expect(text()).toContain('Did you send your application?');

    await click('Not yet');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(text()).toContain('I’ve applied');

    await click('I’ve applied');
    expect(api.recordApplicationStage).toHaveBeenCalledWith({
      applicationId: 'app-1',
      stageLabel: 'Applied',
      stageKind: 'applied',
    });
    expect(onNavigate).toHaveBeenCalledWith('applications');
  });

  it('saves for later and can undo', async () => {
    api.getReviewOpportunity.mockResolvedValue(scored);
    api.decideReviewOpportunity
      .mockResolvedValueOnce({ ...scored, decision: 'saved' })
      .mockResolvedValueOnce({ ...scored, decision: 'new' });
    await act(async () =>
      root.render(
        <JobDetail opportunityId={ID} onBack={vi.fn()} onNavigate={vi.fn()} />,
      ),
    );
    await click('Save for later');
    expect(api.decideReviewOpportunity).toHaveBeenLastCalledWith(ID, 'saved');
    await click('Saved · undo');
    expect(api.decideReviewOpportunity).toHaveBeenLastCalledWith(ID, 'new');
  });
});

describe('your applications', () => {
  const stage = (kind: string, label: string) => ({
    id: `s-${kind}`,
    applicationId: kind,
    stageLabel: label,
    stageKind: kind,
    stageSubtype: null,
    occurredAt: '2026-11-05T09:00:00.000Z',
    recordedAt: '2026-11-05T09:00:00.000Z',
    source: 'user',
    sourceRef: null,
    sourceEvidence: null,
    correctsEventId: null,
  });
  const application = (id: string, kind: string, label: string) => ({
    id,
    companyName: 'Arm',
    roleTitle: `Role ${id}`,
    location: 'Bristol',
    jobUrl: null,
    appliedAt: null,
    createdAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T09:00:00.000Z',
    archivedAt: null,
    currentStage: stage(kind, label),
  });

  it('asks a new profile to upload a CV or answer a few questions, and holds back applications', async () => {
    api.getProfile.mockResolvedValue({
      displayName: 'Sam',
      location: null,
      currentRole: null,
      summary: null,
      avatar: 'mascot:peek',
    });
    api.listExperiences.mockResolvedValue([]);
    api.listConfirmedSkills.mockResolvedValue([]);
    api.listTargets.mockResolvedValue([]);
    api.listSavedSearches.mockResolvedValue({ items: [] });
    api.listApplications.mockResolvedValue({ items: [], nextCursor: null });
    api.listReviewOpportunities.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    api.listDocuments.mockResolvedValue([]);
    await act(async () =>
      root.render(
        <Notifications>
          <ApplicationsPage onNavigate={vi.fn()} />
        </Notifications>,
      ),
    );
    expect(text()).toContain('Profile');
    expect(text()).toContain('Upload your CV');
    expect(text()).toContain('Choose a CV file');
    expect(text()).toContain('Don’t have a CV?');
    expect(text()).toContain('Answer a few questions');
    expect(text()).not.toContain('Add an application');
    expect(text()).not.toContain('jobs applied');
    expect(container.querySelector('.gnd-app-filters')).toBeNull();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it('shows the profile card, opened listings as opportunities, sent ones as applied, and opens a submitted CV', async () => {
    api.getProfile.mockResolvedValue({
      displayName: 'Alex Morgan',
      location: 'Bristol',
      currentRole: null,
      summary: 'Computer science graduate.',
    });
    api.listExperiences.mockResolvedValue([]);
    api.listConfirmedSkills.mockResolvedValue(['Python', 'Git']);
    api.listTargets.mockResolvedValue([
      { roleTitle: 'Software Engineer', active: true },
    ]);
    api.listSavedSearches.mockResolvedValue({ items: [] });
    api.listApplications.mockResolvedValue({
      items: [
        application('a', 'applied', 'Applied'),
        application('o1', 'saved', 'Pending'),
        {
          ...application('i', 'interview', 'Portfolio review'),
          roleTitle: 'Designer',
        },
      ],
      nextCursor: null,
    });
    const interviewStage = {
      ...stage('interview', 'Portfolio review'),
      applicationId: 'i',
      occurredAt: '2099-01-12T14:00:00.000Z',
    };
    api.listReviewOpportunities.mockResolvedValue({
      items: [
        { ...scored, opportunityId: 'saved-job', decision: 'saved' },
        { ...scored, opportunityId: 'new-job', title: 'New role' },
      ],
      nextCursor: null,
    });
    api.getApplication.mockImplementation(async (id: string) => ({
      application: { id },
      stages: id === 'i' ? [interviewStage] : [],
      documents:
        id === 'a'
          ? [
              {
                id: 'd',
                documentId: 'doc-1',
                purpose: 'submitted_cv',
                unlinkedAt: null,
                unavailable: false,
              },
            ]
          : [],
    }));
    api.updateProfile.mockImplementation(async (patch: object) => ({
      displayName: 'Alex Morgan',
      location: 'Bristol',
      currentRole: null,
      summary: 'Computer science graduate.',
      ...patch,
    }));
    api.listDocuments.mockResolvedValue([
      {
        id: 'doc-1',
        category: 'cv',
        originalName: 'Alex Morgan CV.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 1,
        sha256: 'x',
        createdAt: '2026-11-05T09:00:00.000Z',
      },
    ]);
    api.replaceConfirmedSkills.mockImplementation(async (names) => names);
    const onNavigate = vi.fn();
    await act(async () =>
      root.render(
        <Notifications>
          <ApplicationsPage onNavigate={onNavigate} />
        </Notifications>,
      ),
    );
    // A profile without a picture is given a sprout, which is saved.
    expect(api.updateProfile).toHaveBeenCalledWith({
      avatar: expect.stringMatching(/^mascot:/),
    });
    expect(container.querySelector('.gnd-avatar img')).not.toBeNull();
    expect(text()).toContain('Alex Morgan');
    expect(text()).toContain('Software Engineer');
    expect(text()).toContain('2 applied');
    expect(text()).toContain('1 interview');
    expect(text()).toContain('1 saved');
    expect(text()).toContain('2 jobs applied');
    expect(text()).toContain('Your documents');
    expect(text()).toContain('Alex Morgan CV.pdf');
    expect(container.querySelectorAll('.gnd-dots .is-on')).toHaveLength(2);
    const opportunities = container.querySelector('.gnd-opportunities')!;
    expect(opportunities.textContent).toContain('Role o1');
    expect(opportunities.textContent).toContain('Listing opened');
    await click('View CV');
    expect(api.openDocument).toHaveBeenCalledWith('doc-1');
    await click('Add skills');
    const search = container.querySelector(
      'input[aria-label="Search skills"]',
    ) as HTMLInputElement;
    await act(async () => search.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(search, 'fig');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const option = container.querySelector('[role="option"]') as HTMLElement;
    expect(option.textContent).toBe('Figma');
    await act(async () => option.click());
    expect(api.replaceConfirmedSkills).toHaveBeenCalledWith([
      'Python',
      'Git',
      'Figma',
    ]);

    await click('I’ve applied');
    expect(api.recordApplicationStage).toHaveBeenCalledWith({
      applicationId: 'o1',
      stageLabel: 'Applied',
      stageKind: 'applied',
    });

    await click('1 interview');
    expect(
      container.querySelectorAll('[data-testid="interview-card"]'),
    ).toHaveLength(1);
    expect(text()).toContain('Portfolio review – Arm');
    await click('Practise');
    expect(onNavigate).toHaveBeenCalledWith('interviews', {
      practice: {
        method: 'deep_loop',
        subject: 'Designer at Arm',
        guidance: 'A mock interview for the Designer role at Arm.',
      },
    });
  });
});

describe('home quick actions', () => {
  it('opens practice set up for the action, and shows unbuilt ones as coming soon', async () => {
    const onNavigate = vi.fn();
    await act(async () =>
      root.render(<QuickActions onNavigate={onNavigate} />),
    );
    expect(container.querySelectorAll('.gnd-quick-card')).toHaveLength(4);
    expect(container.textContent).not.toContain('Create a new CV');
    expect(container.textContent).not.toContain('Upload a newer CV');
    await click('Practise a mock interview');
    expect(onNavigate).toHaveBeenCalledWith('interviews', {
      practice: { method: 'deep_loop' },
    });
    await click('Practise interview questions');
    expect(onNavigate).toHaveBeenLastCalledWith('interviews', {
      practice: { method: 'quick_fire' },
    });
    const score = container.querySelector('[data-testid="quick-score-cv"]')!;
    expect(score.tagName).not.toBe('BUTTON');
    expect(score.textContent).toContain('Coming soon');
  });
});
