// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  jobDiscoveryConfigurationV1Schema,
  newJobDiscoveryConfiguration,
  type DiscoveryRun,
  type SavedSearch,
} from '../src/shared/contracts/job-discovery';
import { JobsPage } from '../src/renderer/pages/jobs/JobsPage';
import { Notifications } from '../src/renderer/app/Notifications';
import {
  validateSearch,
  searchForm,
} from '../src/renderer/pages/jobs/searchForm';
import { Shell } from '../src/renderer/presentation/Shell';

const ID = '0b7e3c1e-5d1f-4b8a-9a43-0f2d6c2a9e11';
const RUN = '7f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const NOW = '2026-11-15T10:00:00.000Z';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let backend: ReturnType<typeof vi.fn>;
let searches: SavedSearch[];
let runs: DiscoveryRun[];
let failures: Record<string, string>;
let delayedStart: Promise<unknown> | null;

function item(overrides: Partial<SavedSearch['config']> = {}): SavedSearch {
  return {
    id: ID,
    config: {
      ...newJobDiscoveryConfiguration(),
      name: 'Analyst roles',
      intent: {
        ...newJobDiscoveryConfiguration().intent,
        targetRoles: ['Data Analyst'],
      },
      ...overrides,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}
function run(savedSearchId = ID): DiscoveryRun {
  return {
    id: RUN,
    savedSearchId,
    status: 'running',
    configSnapshot: item().config,
    queryPlan: ['Data Analyst site:linkedin.com/jobs'],
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
}
function error(code: string) {
  return {
    ok: false,
    error: { code, message: `${code}: try again`, correlationId: ID },
  };
}
function calls(action?: string) {
  return backend.mock.calls
    .map(([input]) => input as { action: string; payload: Record<string, any> })
    .filter((input) => !action || input.action === action);
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
  searches = [];
  runs = [];
  failures = {};
  delayedStart = null;
  backend = vi.fn(
    async ({
      action,
      payload,
    }: {
      action: string;
      payload: Record<string, any>;
    }) => {
      if (failures[action]) return error(failures[action]);
      if (action === 'savedSearches.list')
        return {
          ok: true,
          data: {
            items: searches.slice(
              payload.cursor ? 1 : 0,
              payload.cursor ? 2 : 1,
            ),
            nextCursor: searches.length > 1 && !payload.cursor ? ID : null,
          },
        };
      if (action === 'runs.list')
        return {
          ok: true,
          data: {
            items: runs
              .slice(payload.cursor ? 1 : 0, payload.cursor ? 2 : 1)
              .map(
                ({ configSnapshot: _config, queryPlan: _plan, ...summary }) =>
                  summary,
              ),
            nextCursor: runs.length > 1 && !payload.cursor ? RUN : null,
          },
        };
      if (
        action === 'savedSearches.create' ||
        action === 'savedSearches.update'
      ) {
        const config = jobDiscoveryConfigurationV1Schema.parse(payload.config);
        const saved = item(config);
        searches = [
          saved,
          ...searches.filter((search) => search.id !== saved.id),
        ];
        return { ok: true, data: { item: saved } };
      }
      if (action === 'savedSearches.setActive') {
        const saved = searches.find((search) => search.id === payload.id)!;
        saved.config = { ...saved.config, active: payload.active };
        return { ok: true, data: { item: saved } };
      }
      if (action === 'runs.preview')
        return { ok: true, data: { queries: ['Backend planned query'] } };
      if (action === 'runs.start') {
        if (delayedStart) await delayedStart;
        if (runs.some((entry) => entry.status === 'running'))
          return error('CONFLICT');
        const next = run(payload.savedSearchId);
        runs.unshift(next);
        return { ok: true, data: { item: next } };
      }
      if (action === 'runs.workflow.execute')
        return { ok: true, data: { accepted: true } };
      if (action === 'runs.get')
        return {
          ok: true,
          data: { item: runs.find((entry) => entry.id === payload.id) },
        };
      return error('NOT_FOUND');
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
function byId(id: string) {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text,
  );
  expect(button, `button: ${text}`).toBeDefined();
  await act(async () => button!.click());
}
async function change(id: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#jobs-${id}`,
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Jobs saved searches', () => {
  it('uses the workspace shell, keyboard tabs, and no work on navigation', async () => {
    function Scene({ density }: { density: string }) {
      return <div data-density={density} />;
    }
    await act(async () =>
      root.render(
        <Notifications>
          <Shell Scene={Scene} />
        </Notifications>,
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-actions button')!
        .click(),
    );
    expect(byId('jobs-page')).toBeTruthy();
    expect(container.querySelector('[data-density="full"]')).toBeTruthy();
    expect(container.querySelector('.shell-workspace')).toBeTruthy();
    const saved = byId('jobs-tab-saved');
    saved.focus();
    await act(async () =>
      saved.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(byId('jobs-tab-discover'));
    expect(byId('jobs-view-discover')).toBeTruthy();
    expect(
      calls().every((call) =>
        ['savedSearches.list', 'runs.list'].includes(call.action),
      ),
    ).toBe(true);
  });

  it('shows empty state, retries failed loads, paginates searches and historical runs', async () => {
    failures['savedSearches.list'] = 'IO_ERROR';
    await render();
    expect(container.textContent).toContain('IO_ERROR');
    delete failures['savedSearches.list'];
    await click('Retry');
    expect(container.textContent).toContain('No saved searches yet');
    searches = [
      item(),
      {
        ...item(),
        id: 'ee2f4c3a-b819-4235-bb21-ef741a8c7d31',
        config: { ...item().config, name: 'Second search' },
      },
    ];
    runs = [
      run(),
      {
        ...run(),
        id: 'b5e6a204-a884-4fa4-99c5-f26594d87eb1',
        status: 'interrupted',
        finishedAt: NOW,
      },
    ];
    await act(async () => root.render(<JobsPage key="loaded" />));
    await act(async () => byId('jobs-tab-discover').click());
    await click('Load more runs');
    expect(container.textContent).toContain('interrupted');
    await act(async () => byId('jobs-tab-saved').click());
    await click('Load more searches');
    expect(container.textContent).toContain('Second search');
    await act(async () => byId('jobs-new').click());
    await click('Back to saved searches');
    // Reload the snapshot after the fixture changes; no per-card run lookup.
    expect(calls('runs.get')).toHaveLength(0);
  });

  it('validates fields without truncating, preserves all advanced configuration on edit and previews only persisted state', async () => {
    const existing = item({
      run: {
        ...item().config.run,
        deadlineMs: 120000,
        maxTargetedSearchesPerCandidate: 0,
      },
      query: { strategy: 'deterministic_v1', maxQueries: 2 },
    });
    searches = [existing];
    await render();
    await click('Edit');
    expect(
      (container.querySelector('#jobs-budget-deadlineMs') as HTMLInputElement)
        .value,
    ).toBe('120000');
    await change('name', 'Changed search');
    await click('Preview saved queries');
    expect(calls('runs.preview')).toHaveLength(0);
    expect(container.textContent).toContain('Save your changes');
    await click('Save search');
    expect(
      calls('savedSearches.update')[0].payload.config.run
        .maxTargetedSearchesPerCandidate,
    ).toBe(0);
    expect(
      calls('savedSearches.update')[0].payload.config.query.maxQueries,
    ).toBe(2);
    await click('Preview saved queries');
    expect(container.textContent).toContain('Backend planned query');
    await change('roles', 'Data Analyst\ndata analyst');
    await click('Save search');
    expect(container.textContent).toContain('Target roles must be distinct');
    expect(calls('savedSearches.update')).toHaveLength(1);
    const long = searchForm(existing.config);
    long.config.name = 'a'.repeat(121);
    expect(validateSearch(long).errors.name).toBeTruthy();
  });

  it('creates, toggles active, and starts exactly once with execute after start', async () => {
    await render();
    await act(async () => byId('jobs-new').click());
    expect(
      (container.querySelector('#jobs-name') as HTMLInputElement).value,
    ).toBe('');
    await change('name', 'New search');
    await change('roles', 'Data Analyst\nProduct Analyst');
    await click('Save search');
    expect(calls('savedSearches.create')).toHaveLength(1);
    expect(calls('runs.preview')).toHaveLength(0);
    await click('Back to saved searches');
    await click('Deactivate');
    expect(calls('savedSearches.setActive')[0].payload.active).toBe(false);
    expect(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Run',
      )!.disabled,
    ).toBe(true);
    await click('Activate');
    await click('Run');
    expect(calls('runs.start')).toHaveLength(1);
    expect(calls('runs.workflow.execute')).toHaveLength(1);
    expect(
      calls().findIndex((call) => call.action === 'runs.start'),
    ).toBeLessThan(
      calls().findIndex((call) => call.action === 'runs.workflow.execute'),
    );
    expect(byId('jobs-run-detail').textContent).toContain(RUN);
    expect(calls('runs.resolve')).toHaveLength(0);
    expect(calls('runs.extract')).toHaveLength(0);
  });

  it('keeps a created run visible on execution failure, without retrying or cancelling it on navigation', async () => {
    searches = [item()];
    failures['runs.workflow.execute'] = 'IO_ERROR';
    await render();
    await click('Run');
    expect(container.textContent).toContain('execution was not confirmed');
    await click('Back to saved searches');
    expect(container.textContent).toContain('View active run');
    await click('View active run');
    expect(byId('jobs-run-detail').textContent).toContain(RUN);
    expect(calls('runs.start')).toHaveLength(1);
    expect(calls('runs.cancel')).toHaveLength(0);
  });

  it('prevents a second start while the first request is pending, and uses the active-run link', async () => {
    searches = [item()];
    let release!: () => void;
    delayedStart = new Promise<void>((resolve) => {
      release = resolve;
    });
    await render();
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Run')!
        .click();
    });
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Run')!
        .click();
    });
    expect(calls('runs.start')).toHaveLength(1);
    await act(async () => release());
    await click('Back to saved searches');
    expect(container.textContent).toContain('View active run');
    expect(calls('runs.start')).toHaveLength(1);
  });

  it('blocks inactive searches, surfaces backend conflicts and never retries a conflicting start', async () => {
    searches = [item({ active: false })];
    await render();
    await click('Edit');
    await click('Start discovery');
    expect(container.textContent).toContain('Activate this saved search');
    expect(calls('runs.start')).toHaveLength(0);
    await click('Back to saved searches');
    await click('Activate');
    failures['runs.start'] = 'CONFLICT';
    await click('Run');
    expect(container.textContent).toContain('CONFLICT');
    expect(calls('runs.start')).toHaveLength(1);
    expect(calls('runs.workflow.execute')).toHaveLength(0);
    expect(calls('runs.list').length).toBeGreaterThan(1);
  });

  it('leaves a running backend job untouched when leaving and returning via the page palette', async () => {
    searches = [item()];
    runs = [run()];
    function Scene({ density }: { density: string }) {
      return <div data-density={density} />;
    }
    await act(async () =>
      root.render(
        <Notifications>
          <Shell Scene={Scene} />
        </Notifications>,
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-actions button')!
        .click(),
    );
    await click('View active run');
    expect(byId('jobs-run-detail').textContent).toContain(RUN);
    await act(async () => byId('nav-trigger').click());
    await act(async () => byId('destination-home').click());
    expect(byId('page-home')).toBeTruthy();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-actions button')!
        .click(),
    );
    expect(container.textContent).toContain('View active run');
    await click('View active run');
    expect(byId('jobs-run-detail').textContent).toContain(RUN);
    expect(calls('runs.cancel')).toHaveLength(0);
    expect(calls('runs.start')).toHaveLength(0);
  });
});
