// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OpportunityDetail,
  OpportunitySummary,
} from '../src/shared/contracts/job-discovery';
import { JobsPage } from '../src/renderer/pages/jobs/JobsPage';

const ids = Array.from(
  { length: 24 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const now = '2026-11-16T00:00:00.000Z';
function opportunity(
  index: number,
  decision: OpportunitySummary['decision'] = 'new',
): OpportunitySummary {
  return {
    opportunityId: ids[index],
    title: `Role ${index}`,
    company: `Employer ${index}`,
    location: null,
    latestSource: {
      id: ids[(index + 1) % ids.length],
      provider: 'linkedin',
      discoveredUrl: 'https://example.com/job',
      collectionUrl: null,
      postingAge: null,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    decision,
    applicationId: decision === 'applied' ? ids[23] : null,
    verified: false,
    extractionStatus: 'no_verified_capture',
    matchStatus: 'missing',
    coverage: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let backend: ReturnType<typeof vi.fn>;
let records: OpportunitySummary[];
let failure: string | null;
let delayed: ((value: unknown) => void) | null;
let detailOverride: Partial<OpportunityDetail> = {};
const calls = (action: string) =>
  backend.mock.calls
    .map(
      ([input]) =>
        input as {
          module: string;
          action: string;
          payload: Record<string, string>;
        },
    )
    .filter((call) => call.action === action);
const response = (data: unknown) => ({ ok: true, data });
const reject = (code: string) => ({
  ok: false,
  error: { code, message: `${code} response`, correlationId: ids[0] },
});

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  records = [
    opportunity(0),
    opportunity(1),
    opportunity(2, 'saved'),
    opportunity(3, 'dismissed'),
    opportunity(4, 'applied'),
  ];
  failure = null;
  delayed = null;
  detailOverride = {};
  backend = vi.fn(
    async ({
      action,
      payload,
    }: {
      action: string;
      payload: Record<string, string>;
    }) => {
      if (action === 'savedSearches.list' || action === 'runs.list')
        return response({ items: [], nextCursor: null });
      if (action === 'opportunities.list') {
        if (delayed)
          return new Promise((resolve) => {
            delayed?.(resolve);
          });
        const entries = records.filter(
          (item) =>
            payload.decision === 'all' ||
            (item.decision === payload.decision && !item.applicationId),
        );
        const start = Number(payload.cursor ?? 0);
        const limit = Number(payload.limit);
        return response({
          items: entries.slice(start, start + limit),
          nextCursor:
            start + limit < entries.length ? String(start + limit) : null,
        });
      }
      if (action === 'opportunities.decide') {
        if (failure) return reject(failure);
        const index = records.findIndex(
          (item) => item.opportunityId === payload.opportunityId,
        );
        records[index] = {
          ...records[index],
          decision: payload.decision as OpportunitySummary['decision'],
        };
        return response({ item: records[index] });
      }
      if (action === 'opportunities.apply.preview')
        return response({
          applicationId: null,
          unverified: true,
          snapshot: 'no_verified_jd',
          manualMatchId: null,
          dismissed: false,
        });
      if (action === 'opportunities.apply') {
        const item = records.find(
          (entry) => entry.opportunityId === payload.opportunityId,
        )!;
        item.applicationId = ids[22];
        return response({ applicationId: ids[22] });
      }
      if (action === 'get' && payload.id === ids[22])
        return response({
          item: {
            application: {
              id: ids[22],
              currentStage: { stageKind: 'saved', stageLabel: 'Pending' },
            },
            stages: [],
            documents: [],
            notes: [],
            snapshot: null,
          },
        });
      if (action === 'opportunities.get') {
        const item = records.find(
          (entry) => entry.opportunityId === payload.opportunityId,
        );
        if (!item) return reject('NOT_FOUND');
        return response({
          item: {
            ...item,
            sources: item.latestSource ? [item.latestSource] : [],
            sourcesTruncated: false,
            canonicalUrl: null,
            verifiedCaptureId: null,
            verifiedAt: null,
            postingText: null,
            postingTextTruncated: false,
            extraction: null,
            match: null,
            skillFreshness: null,
            ...detailOverride,
          },
        });
      }
      return reject('NOT_FOUND');
    },
  );
  vi.stubGlobal('career', { request: backend });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<JobsPage />));
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
const cards = () =>
  Array.from(container.querySelectorAll('[data-opportunity-id]')).map((node) =>
    node.getAttribute('data-opportunity-id'),
  );

describe('Jobs Review inbox', () => {
  it('confirms unverified and missing JD before navigating to the Pending ATS detail', async () => {
    await render();
    await click('Review');
    await click('Apply');
    expect(container.textContent).toContain(
      'original source URL is unverified',
    );
    expect(container.textContent).toContain('without a saved JD snapshot');
    await click('Cancel');
    expect(calls('opportunities.apply')).toHaveLength(0);
    await click('Apply');
    await click('Confirm Pending application');
    expect(calls('opportunities.apply')[0].payload).toEqual({
      opportunityId: ids[0],
      confirmUnverified: true,
      withoutSnapshot: true,
      allowDuplicate: false,
    });
    expect(
      container.querySelector('[data-testid="jobs-view-applications"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="application-detail"]'),
    ).toBeTruthy();
  });
  it('enters from Jobs on New, filters cross-run identity and keeps tracked read-only', async () => {
    await render();
    await click('Review');
    expect(cards()).toEqual(ids.slice(0, 2));
    expect(calls('opportunities.list')[0].payload).toEqual({
      decision: 'new',
      limit: 20,
    });
    await click('All');
    expect(cards()).toEqual(ids.slice(0, 5));
    expect(container.textContent).toContain('Tracked as application');
    expect(
      container
        .querySelector(`[data-opportunity-id="${ids[4]}"]`)
        ?.querySelectorAll('button'),
    ).toHaveLength(2);
    await click('Saved');
    expect(cards()).toEqual([ids[2]]);
    await click('Dismissed');
    expect(cards()).toEqual([ids[3]]);
    await click('New');
    expect(cards()).toEqual(ids.slice(0, 2));
    records = records.filter((entry) => entry.decision !== 'new');
    await click('Refresh');
    expect(container.textContent).toContain('No new opportunities');
  });

  it('pages without duplicates and rejects late responses from another filter', async () => {
    records = Array.from({ length: 23 }, (_, i) => opportunity(i));
    await render();
    await click('Review');
    expect(cards()).toHaveLength(20);
    await click('Load more');
    expect(cards()).toHaveLength(23);
    await click('Refresh');
    expect(cards()).toHaveLength(20);
    let resolveOld: ((value: unknown) => void) | null = null;
    delayed = (resolve) => {
      resolveOld = resolve as (value: unknown) => void;
    };
    await click('Refresh');
    expect(resolveOld).toBeTruthy();
    delayed = null;
    await click('Saved');
    await act(async () =>
      resolveOld!(response({ items: [opportunity(0)], nextCursor: null })),
    );
    expect(cards()).toEqual([]);
    expect(container.textContent).toContain('No saved opportunities yet');
  });

  it('confirms decisions, keeps failed cards and returns from detail', async () => {
    await render();
    await click('Review');
    await click('Save');
    expect(cards()).toEqual([ids[1]]);
    expect(calls('opportunities.decide')[0].payload).toEqual({
      opportunityId: ids[0],
      decision: 'saved',
    });
    failure = 'CONFLICT';
    await click('Dismiss');
    expect(cards()).toEqual([ids[1]]);
    expect(container.textContent).toContain(
      'This decision is no longer available',
    );
    failure = 'NOT_FOUND';
    await click('Dismiss');
    expect(container.textContent).toContain('no longer available');
    failure = null;
    await click('Dismiss');
    expect(cards()).toEqual([]);
    await click('Dismissed');
    await click('Restore');
    expect(calls('opportunities.decide').at(-1)?.payload.decision).toBe('new');
    await click('New');
    const review = container.querySelector<HTMLButtonElement>(
      `[data-review-id="${ids[1]}"]`,
    )!;
    await act(async () => review.click());
    expect(
      container.querySelector('[data-testid="review-detail"]')?.textContent,
    ).toContain('Role 1');
    await click('Back to Review');
    expect(cards()).toContain(ids[1]);
    expect(
      backend.mock.calls.every(([input]) => input.module === 'jobDiscovery'),
    ).toBe(true);
    expect(calls('opportunities.get')[0].payload.opportunityId).toBe(ids[1]);
  });

  it('shows verified current evidence and only the stored required-skills coverage', async () => {
    const captureId = ids[10];
    const extractionId = ids[11];
    detailOverride = {
      verified: true,
      verifiedCaptureId: captureId,
      canonicalUrl: 'https://employer.example/role',
      extractionStatus: 'ready',
      matchStatus: 'scored',
      coverage: 0.5,
      postingText: 'Original verified posting text',
      extraction: {
        id: extractionId,
        captureId,
        status: 'extracted',
        errorCode: null,
        jd: {
          schemaVersion: 1,
          classification: 'job_description',
          title: null,
          company: null,
          location: null,
          responsibilities: [
            {
              text: 'Build reliable services',
              evidence: 'Build reliable services',
            },
          ],
          requiredSkills: [
            { text: 'TypeScript', evidence: 'TypeScript' },
            { text: 'Rust', evidence: 'Rust' },
          ],
          preferredSkills: [],
          educationRequirements: [],
          minimumYearsExperience: null,
          seniority: null,
          estimatedExperienceBand: null,
          employmentType: null,
          workArrangement: null,
          salaryText: null,
          inferences: [],
        },
        diagnostics: [],
        provenance: null,
        startedAt: now,
        finishedAt: now,
      },
      match: {
        schemaVersion: 1,
        opportunityId: ids[0],
        extractionId,
        status: 'scored',
        reason: 'COVERAGE',
        coverage: 0.5,
        matched: ['TypeScript'],
        unmatched: ['Rust'],
        requiredCount: 2,
        scorerVersion: 'required-skills-v1',
        profileSkillFingerprint: null,
        explicitMinimumYears: null,
        alignment: {
          location: 'unknown',
          years: 'unknown',
          seniority: 'unknown',
        },
        computedAt: now,
      },
    };
    await render();
    await click('Review');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[data-review-id="${ids[0]}"]`)!
        .click(),
    );
    expect(container.textContent).toContain('Build reliable services');
    expect(container.textContent).toContain('Required skills covered: 50%');
    expect(container.textContent).toContain(
      'Confirmed-skill freshness is unknown',
    );
    expect(container.querySelectorAll('a')).toHaveLength(2);
    expect(container.textContent).toContain('Original listing');
    expect(container.textContent).toContain('Verified company/ATS posting');
    expect(calls('runs.track')).toHaveLength(0);
    expect(calls('runs.refreshMatches')).toHaveLength(0);
    expect(calls('applications.create')).toHaveLength(0);
    await click('Save');
    expect(container.textContent).toContain('Review decision: saved');
    await click('Back to Review');
    expect(cards()).toEqual([ids[1]]);
  });

  it('keeps unverified and tracked detail honest, without decision authority for tracked records', async () => {
    await render();
    await click('Review');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[data-review-id="${ids[0]}"]`)!
        .click(),
    );
    expect(container.textContent).toContain(
      'No verified posting capture is available',
    );
    expect(container.textContent).toContain('No saved assessment is available');
    expect(container.textContent).not.toContain('Required skills covered:');
    await click('Back to Review');
    await click('All');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[data-review-id="${ids[4]}"]`)!
        .click(),
    );
    expect(container.textContent).toContain('Already in applications');
    expect(container.querySelector('.jobs-review-decision-actions')).toBeNull();
    expect(calls('opportunities.decide')).toHaveLength(0);
  });
});
