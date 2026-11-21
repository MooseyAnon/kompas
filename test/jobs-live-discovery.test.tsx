// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoveryWorkflowStateOutput,
  discoveryCandidatesOutput,
  discoveryMatchesOutput,
  resolutionDiagnosticsOutput,
  newJobDiscoveryConfiguration,
  type DiscoveryCandidate,
  type DiscoveryWorkflowState,
  type DiscoveryRun,
  type ResolutionDiagnostics,
  type DiscoveryMatch,
} from '../src/shared/contracts/job-discovery';
import { JobsPage } from '../src/renderer/pages/jobs/JobsPage';
import { resolutionCopy } from '../src/renderer/pages/jobs/discoveryCopy';

const RUN = '7f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const SOURCE = '0b7e3c1e-5d1f-4b8a-9a43-0f2d6c2a9e11';
const OTHER = 'ee2f4c3a-b819-4235-bb21-ef741a8c7d31';
const OPPORTUNITY = 'b5e6a204-a884-4fa4-99c5-f26594d87eb1';
const SECOND = 'baaa7638-2645-4942-b0de-4a362513142b';
const ATTEMPT = '48a66dfd-bc05-4a0b-aad4-4082a0e891cd';
const NOW = '2026-11-15T10:00:00.000Z';
const run: DiscoveryRun = {
  id: RUN,
  savedSearchId: null,
  status: 'running',
  configSnapshot: {
    ...newJobDiscoveryConfiguration(),
    name: 'Analyst roles',
    intent: {
      ...newJobDiscoveryConfiguration().intent,
      targetRoles: ['Analyst'],
    },
  },
  queryPlan: ['Analyst site:linkedin.com/jobs'],
  stats: {
    queriesPlanned: 1,
    collectionPagesRead: 0,
    inspectedCandidates: 0,
    newCandidates: 0,
    targetedSearches: 0,
    targetedPagesRead: 0,
    extractions: 0,
    transientRetries: 0,
  },
  diagnostics: [],
  startedAt: NOW,
  finishedAt: null,
};
function candidate(sourceId = SOURCE, id = OPPORTUNITY): DiscoveryCandidate {
  return {
    id,
    sourceId,
    provider: 'linkedin',
    sourceKey: 'listing',
    discoveredUrl: `https://linkedin.com/jobs/view/${sourceId}`,
    collectionUrl: null,
    title: sourceId === SOURCE ? 'Analyst' : 'Designer',
    company: 'Studio',
    location: null,
    postingAge: null,
    canonicalUrl: null,
    resolutionStatus: 'discovered',
    resolutionReason: null,
    resolutionAttempts: 0,
    retryAvailable: false,
  };
}
function step(
  status: 'pending' | 'active' | 'succeeded' | 'failed' | 'skipped' = 'pending',
) {
  return { status, reason: null, retryAvailable: false };
}
function snapshot(rows: DiscoveryCandidate[]): DiscoveryWorkflowState {
  return {
    id: RUN,
    status: run.status,
    workActive: true,
    discovery: {
      planned: 1,
      submitted: 1,
      settled: 0,
      search: {
        operationActive: true,
        queueLength: 1,
        position: 1,
        state: 'waiting',
        waitingMs: 20,
        nextEligibleAt: null,
      },
    },
    activeSteps: [],
    counts: {
      admitted: rows.length,
      verified: 0,
      jdReady: 0,
      matched: 0,
      failed: 0,
    },
    milestones: {
      firstAdmittedAt: NOW,
      firstVerifiedAt: null,
      firstJdReadyAt: null,
      firstMatchedAt: null,
    },
    diagnostics: [],
    candidates: rows.map((row) => ({
      opportunityId: row.id,
      sourceId: row.sourceId,
      provider: row.provider,
      title: row.title,
      resolution: { ...step(), attempts: row.resolutionAttempts },
      extraction: { ...step(), omittedFields: [] },
      match: { ...step(), freshness: null, computedAt: null },
    })),
  };
}
const history: ResolutionDiagnostics = {
  source: {
    opportunityId: OPPORTUNITY,
    sourceId: SOURCE,
    provider: 'linkedin',
    discoveredUrl: candidate().discoveredUrl,
  },
  totalAttempts: 2,
  attempts: [
    {
      id: ATTEMPT,
      runId: RUN,
      sourceId: SOURCE,
      provider: 'linkedin',
      discoveredUrl: candidate().discoveredUrl,
      sequence: 2,
      status: 'completed',
      reason: 'identity_mismatch',
      startedAt: NOW,
      finishedAt: NOW,
      searches: [
        {
          ordinal: 1,
          query: 'exact submitted query',
          status: 'completed',
          errorCode: null,
          startedAt: NOW,
          finishedAt: NOW,
          results: [
            {
              ordinal: 1,
              url: 'https://employer.example/no',
              disposition: 'rejected',
              reason: 'identity_mismatch',
              captureId: null,
            },
            {
              ordinal: 2,
              url: 'https://employer.example/yes',
              disposition: 'accepted',
              reason: null,
              captureId: ATTEMPT,
            },
            {
              ordinal: 3,
              url: 'https://employer.example/skipped',
              disposition: 'not_opened',
              reason: 'budget_exhausted',
              captureId: null,
            },
          ],
        },
        {
          ordinal: 2,
          query: 'second exact query',
          status: 'failed',
          errorCode: 'RATE_LIMITED',
          startedAt: NOW,
          finishedAt: NOW,
          results: [],
        },
      ],
    },
  ],
};

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let backend: ReturnType<typeof vi.fn>;
let rows: DiscoveryCandidate[];
let state: DiscoveryWorkflowState;
let matches: DiscoveryMatch[];
let diagnostics: ResolutionDiagnostics;
let deferred: Promise<unknown> | null;
let delayed: (value: unknown) => void;
const actions = (name: string) =>
  backend.mock.calls.filter(([input]) => input.action === name);
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label,
  ) as HTMLButtonElement;
async function click(label: string) {
  expect(button(label), `button ${label}`).toBeTruthy();
  await act(async () => button(label).click());
}
async function openRun() {
  await act(async () => root.render(<JobsPage />));
  await act(async () =>
    (
      container.querySelector(
        '[data-testid="jobs-tab-discover"]',
      ) as HTMLElement
    ).click(),
  );
  await click('Open run');
}
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
  rows = [candidate()];
  state = snapshot(rows);
  matches = [];
  diagnostics = history;
  deferred = null;
  delayed = () => {};
  backend = vi.fn(
    async (input: { action: string; payload: { sourceId?: string } }) => {
      const { action } = input;
      if (action === 'savedSearches.list')
        return { ok: true, data: { items: [], nextCursor: null } };
      if (action === 'runs.list')
        return { ok: true, data: { items: [run], nextCursor: null } };
      if (action === 'runs.get')
        return { ok: true, data: { item: { ...run } } };
      if (action === 'runs.workflow.state.get') {
        if (deferred) return deferred;
        return {
          ok: true,
          data: discoveryWorkflowStateOutput.parse({ state }),
        };
      }
      if (action === 'runs.candidates')
        return {
          ok: true,
          data: discoveryCandidatesOutput.parse({ items: rows }),
        };
      if (action === 'runs.matches')
        return {
          ok: true,
          data: discoveryMatchesOutput.parse({ items: matches }),
        };
      if (action === 'runs.resolutionDiagnostics')
        return {
          ok: true,
          data: resolutionDiagnosticsOutput.parse(diagnostics),
        };
      if (action === 'runs.extractions')
        return { ok: true, data: { items: [] } };
      if (action === 'runs.cancel') {
        run.status = 'cancelled';
        state.status = 'cancelled';
        return { ok: true, data: { item: { ...run } } };
      }
      if (action === 'runs.retryResolution')
        return { ok: true, data: { item: rows[0] } };
      if (action === 'runs.retryExtraction')
        return { ok: true, data: { items: [] } };
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', correlationId: RUN },
      };
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
  run.status = 'running';
});

describe('Jobs live discovery', () => {
  it('shows admissions while a later search waits; independently updates verification, JD and unscored match', async () => {
    await openRun();
    expect(container.textContent).toContain('Analyst');
    expect(container.textContent).toContain(
      'Search queue: waiting · position 1',
    );
    expect(container.textContent).toContain('1 admitted');
    rows[0] = {
      ...rows[0],
      canonicalUrl: 'https://employer.example/jobs/analyst',
      resolutionStatus: 'extracted',
    };
    state.candidates[0].resolution.status = 'succeeded';
    state.candidates[0].extraction.status = 'succeeded';
    state.candidates[0].extraction.omittedFields = ['salaryText'];
    state.candidates[0].match.status = 'succeeded';
    state.candidates[0].match.freshness = 'unknown_skills';
    state.counts = {
      admitted: 1,
      verified: 1,
      jdReady: 1,
      matched: 1,
      failed: 0,
    };
    matches = [
      {
        schemaVersion: 1,
        opportunityId: OPPORTUNITY,
        extractionId: ATTEMPT,
        status: 'unscored',
        reason: 'NO_CONFIRMED_SKILLS',
        coverage: null,
        matched: [],
        unmatched: [],
        requiredCount: 1,
        scorerVersion: 'required-skills-v1',
        profileSkillFingerprint: null,
        explicitMinimumYears: null,
        alignment: {
          location: 'unknown',
          years: 'unknown',
          seniority: 'unknown',
        },
        computedAt: NOW,
      },
    ];
    await click('Refresh results');
    const step = (name: string) =>
      container.querySelector(`[data-step="${name}"]`)?.textContent;
    expect(container.textContent).toContain(
      'https://employer.example/jobs/analyst',
    );
    expect(step('jd')).toBe('Job descriptionReady');
    expect(step('skills')).toContain('Unscored');
    expect(step('skills')).toContain('No user-confirmed skills');
    expect(container.textContent).toContain('Skill freshness: unknown');
    expect(container.textContent).not.toContain('0% required-skill coverage');
    expect(actions('runs.workflow.execute')).toHaveLength(0);
    expect(actions('runs.resolve')).toHaveLength(0);
    expect(actions('runs.extract')).toHaveLength(0);
    expect(actions('runs.refreshMatches')).toHaveLength(0);
  });

  it('keeps a failed sibling, shows exact ordered evidence and copies only returned history', async () => {
    rows.push(candidate(OTHER, SECOND));
    state = snapshot(rows);
    state.candidates[1].resolution = {
      status: 'failed',
      reason: 'identity_mismatch',
      attempts: 2,
      retryAvailable: false,
    };
    state.counts.failed = 1;
    await openRun();
    expect(container.textContent).toContain('Analyst');
    expect(container.textContent).toContain('Designer');
    const details =
      container.querySelector<HTMLDetailsElement>('.jobs-evidence')!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle', { bubbles: false }));
    });
    expect(details.textContent).toContain('exact submitted query');
    expect(details.textContent).toContain('Read and checked; rejected');
    expect(details.textContent).toContain('Read and checked; accepted');
    expect(details.textContent).toContain('Not opened');
    expect(details.textContent).toContain('RATE_LIMITED');
    expect(details.textContent).toContain(
      'Detailed history not recorded for 1 earlier attempt',
    );
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await click('Copy diagnostics');
    expect(writeText).toHaveBeenCalledWith(resolutionCopy(history));
    expect(writeText.mock.calls[0][0]).not.toContain('rawReadPage');
    expect(writeText.mock.calls[0][0]).not.toContain(`[capture ${ATTEMPT}]`);
  });

  it('guards cancel and retries, keeps partial results, and does not resume interrupted runs', async () => {
    state.candidates[0].resolution = {
      status: 'failed',
      reason: 'page_unavailable',
      attempts: 1,
      retryAvailable: false,
    };
    await openRun();
    expect(button('Retry resolution')).toBeUndefined();
    await click('Cancel run');
    await act(async () => {
      button('Confirm cancel').click();
      button('Confirm cancel')?.click();
    });
    expect(actions('runs.cancel')).toHaveLength(1);
    expect(container.textContent).toContain('cancelled');
    expect(container.textContent).toContain('Analyst');
    state.candidates[0].resolution.retryAvailable = true;
    await click('Refresh results');
    await act(async () => {
      button('Retry resolution').click();
      button('Retry resolution')?.click();
    });
    expect(actions('runs.retryResolution')).toHaveLength(1);
    expect(actions('runs.workflow.execute')).toHaveLength(0);
    run.status = 'interrupted';
    state.status = 'interrupted';
    await click('Refresh results');
    expect(container.textContent).toContain('cannot resume');
  });

  it('fences a stale response after leaving a run and treats unknown post-relaunch counters honestly', async () => {
    state.discovery.submitted = null;
    state.discovery.settled = null;
    state.discovery.search = {
      operationActive: false,
      queueLength: 0,
      position: null,
      state: 'idle',
      waitingMs: 0,
      nextEligibleAt: null,
    };
    await openRun();
    expect(container.textContent).toContain(
      'Submitted searches: unknown after restart',
    );
    expect(container.textContent).toContain(
      'No live search information available',
    );
    deferred = new Promise((resolve) => {
      delayed = resolve;
    });
    await act(async () => button('Refresh results').click());
    await act(async () =>
      (
        container.querySelector('[data-testid="jobs-tab-saved"]') as HTMLElement
      ).click(),
    );
    await act(async () =>
      delayed({
        ok: true,
        data: discoveryWorkflowStateOutput.parse({ state }),
      }),
    );
    expect(actions('runs.cancel')).toHaveLength(0);
    expect(actions('runs.retryResolution')).toHaveLength(0);
  });

  it('refreshes the recent-run row when the selected run settles', async () => {
    await openRun();
    expect(container.querySelector('.jobs-run-list')?.textContent).toContain(
      'running',
    );
    run.status = 'partial';
    state.status = 'partial';
    await click('Refresh results');
    expect(container.querySelector('.jobs-run-detail')?.textContent).toContain(
      'partial',
    );
    expect(container.querySelector('.jobs-run-list')?.textContent).toContain(
      'partial',
    );
    expect(
      container.querySelector('.jobs-run-list')?.textContent,
    ).not.toContain('running');
  });

  it('shows unavailable local model, limits retries to advertised terminal actions, and labels legacy history', async () => {
    run.status = 'partial';
    rows[0].canonicalUrl = 'https://employer.example/role';
    state = snapshot(rows);
    state.status = 'partial';
    state.workActive = false;
    state.candidates[0].resolution.status = 'succeeded';
    state.candidates[0].extraction = {
      status: 'failed',
      reason: 'MODEL_UNAVAILABLE',
      retryAvailable: true,
      omittedFields: [],
    };
    diagnostics = { ...history, attempts: [] };
    await openRun();
    expect(container.textContent).toContain('Local model unavailable');
    expect(button('Retry extraction')).toBeTruthy();
    await act(async () => {
      const details =
        container.querySelector<HTMLDetailsElement>('.jobs-evidence')!;
      details.open = true;
      details.dispatchEvent(new Event('toggle', { bubbles: false }));
    });
    expect(container.textContent).toContain(
      'Detailed history not recorded for 2 earlier attempt',
    );
    await click('Retry extraction');
    expect(actions('runs.retryExtraction')).toHaveLength(1);
    state.candidates[0].extraction.retryAvailable = false;
    await click('Refresh results');
    expect(button('Retry extraction')).toBeUndefined();
    expect(actions('runs.workflow.execute')).toHaveLength(0);
  });

  it('collapses and expands the open run without hiding candidates', async () => {
    await openRun();
    const toggle =
      container.querySelector<HTMLButtonElement>('.jobs-collapse')!;
    const body = container.querySelector<HTMLElement>('.jobs-run-body')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Expand run');
    expect(body.hidden).toBe(true);
    expect(container.textContent).toContain('Analyst');
    await act(async () => toggle.click());
    expect(body.hidden).toBe(false);
  });
});
