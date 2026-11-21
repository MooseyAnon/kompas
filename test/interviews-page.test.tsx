// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifications } from '../src/renderer/app/Notifications';
import { InterviewsPage } from '../src/renderer/pages/interviews/InterviewsPage';
import {
  backLocation,
  sessionLocation,
  tabLocation,
  useInterviewsNavigation,
} from '../src/renderer/pages/interviews/navigation';
import { Shell } from '../src/renderer/presentation/Shell';

const SESSION_ID = '0b7e3c1e-5d1f-4b8a-9a43-0f2d6c2a9e11';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let backend: ReturnType<typeof vi.fn>;

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
  backend = vi.fn(async (input: { action: string }) =>
    input.action.endsWith('.list')
      ? { ok: true, data: { items: [] as unknown[], nextCursor: null } }
      : input.action === 'insights.progress.get'
        ? {
            ok: true,
            data: {
              sessions: 0,
              subject: null,
              method: null,
              scoredRounds: 0,
              unscoredRounds: 0,
              pendingRounds: 0,
              reassessments: 0,
              pass: 0,
              fail: 0,
              averageScore: null,
              points: [],
              variedBars: false,
              limited: false,
            },
          }
        : {
            ok: false,
            error: {
              code: 'NOT_FOUND',
              message: 'Not found.',
              correlationId: 'x',
            },
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

function query<T extends HTMLElement = HTMLElement>(testId: string) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}
function press(key: string) {
  document.activeElement!.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true }),
  );
}
function selectedTab() {
  return container.querySelector('[role="tab"][aria-selected="true"]');
}
/** Prepare may list sessions and targets; nothing else runs on navigation. */
function expectOnlyReads() {
  const actions = backend.mock.calls.map(
    ([input]) => (input as { action: string }).action,
  );
  expect(
    actions.every((action) =>
      ['sessions.list', 'targets.list'].includes(action),
    ),
  ).toBe(true);
}

describe('Interviews page in the shell', () => {
  function Scene({ density }: { density: string }) {
    return <div data-testid="scene" data-density={density} />;
  }

  async function renderShell() {
    await act(async () =>
      root.render(
        <Notifications>
          <Shell Scene={Scene} />
        </Notifications>,
      ),
    );
  }

  it('opens from the palette with the full scene, no sidebar and no backend call', async () => {
    await renderShell();
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }),
      ),
    );
    await act(async () => query('destination-interviews')!.click());

    expect(query('page-interviews')).not.toBeNull();
    expect(query('interviews-page')).not.toBeNull();
    expect(query('scene')!.getAttribute('data-density')).toBe('full');
    expect(query('app-shell')!.classList).toContain('shell-workspace');
    expect(container.querySelector('.sidebar, .nav-item, .view')).toBeNull();
    expect(query('nav-trigger')).not.toBeNull();
    expect(container.querySelector('h1')!.textContent).toBe('Interviews');
    expect(query('interviews-prepare')).not.toBeNull();
    expectOnlyReads();
  });

  it('opens from the Home call to action', async () => {
    await renderShell();
    await act(async () =>
      container
        .querySelectorAll<HTMLButtonElement>('.home-actions button')[1]
        .click(),
    );
    expect(query('interviews-page')).not.toBeNull();
    expect(selectedTab()!.textContent).toBe('Prepare');
  });

  it('gives Jobs the full workspace scene', async () => {
    await renderShell();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-actions button')!
        .click(),
    );
    expect(query('scene')!.getAttribute('data-density')).toBe('full');
    expect(query('app-shell')!.classList).toContain('shell-workspace');
  });
});

describe('Interviews inner tabs', () => {
  beforeEach(async () => {
    await act(async () => root.render(<InterviewsPage />));
  });

  it('exposes exactly three labelled tabs with one selected and tabbable', () => {
    const tablist = container.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute('aria-label')).toBe('Interview sections');
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Prepare',
      'History',
      'Competencies',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
    ]);
    expect(tabs.every((tab) => tab.querySelector('svg'))).toBe(true);

    const panel = container.querySelector('[role="tabpanel"]')!;
    expect(tabs[0].getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
  });

  it('switches panels by pointer and labels the panel with the active tab', async () => {
    await act(async () => query('interviews-tab-history')!.click());
    expect(selectedTab()!.textContent).toBe('History');
    expect(query('interviews-history-empty')).not.toBeNull();
    expect(query('interviews-prepare')).toBeNull();
    expect(
      container
        .querySelector('[role="tabpanel"]')!
        .getAttribute('aria-labelledby'),
    ).toBe(query('interviews-tab-history')!.id);

    await act(async () => query('interviews-tab-competencies')!.click());
    expect(query('interviews-competencies-empty')).not.toBeNull();
  });

  it('moves selection and focus with arrows, Home and End', async () => {
    await act(async () => query('interviews-tab-prepare')!.focus());

    await act(async () => press('ArrowRight'));
    expect(selectedTab()!.textContent).toBe('History');
    expect(document.activeElement).toBe(query('interviews-tab-history'));

    await act(async () => press('End'));
    expect(document.activeElement).toBe(query('interviews-tab-competencies'));

    await act(async () => press('ArrowRight'));
    expect(document.activeElement).toBe(query('interviews-tab-prepare'));

    await act(async () => press('ArrowLeft'));
    expect(selectedTab()!.textContent).toBe('Competencies');

    await act(async () => press('Home'));
    expect(selectedTab()!.textContent).toBe('Prepare');
    expect(document.activeElement).toBe(query('interviews-tab-prepare'));
  });

  it('shows honest content without scores, counts or sessions', () => {
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d+\s*%|score|minutes?|\bmin\b/i);
    const decorations = [...container.querySelectorAll('.meadow-card-corner')];
    expect(decorations.length).toBeGreaterThan(0);
    for (const decoration of decorations)
      expect(decoration.getAttribute('aria-hidden')).toBe('true');
    expectOnlyReads();
  });
});

describe('Interviews session outlet', () => {
  it('enters by session id as a focused variant, not a fourth tab, and goes back to its tab', async () => {
    await act(async () =>
      root.render(
        <InterviewsPage
          initialLocation={{
            view: 'session',
            sessionId: SESSION_ID,
            returnTo: 'history',
          }}
        />,
      ),
    );
    const outlet = query('interviews-session-outlet')!;
    expect(outlet.getAttribute('data-session-id')).toBe(SESSION_ID);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(
      container.querySelector('[role="region"]')!.getAttribute('aria-label'),
    ).toBe('Interview session');
    expect(query('interviews-session-back')!.textContent).toBe(
      'Back to History',
    );

    await act(async () => query('interviews-session-back')!.click());
    expect(query('interviews-session-outlet')).toBeNull();
    expect(selectedTab()!.textContent).toBe('History');
    expect(document.activeElement).toBe(query('interviews-tab-history'));
    // Entering and leaving only read the snapshot and History; nothing starts or pauses.
    expect(
      backend.mock.calls.every(([input]) =>
        ['workflow.state.get', 'insights.sessions.list'].includes(
          (input as { action: string }).action,
        ),
      ),
    ).toBe(true);
  });

  it('opens a valid id from the current tab and rejects invalid ids', async () => {
    let controls!: ReturnType<typeof useInterviewsNavigation>;
    function Harness() {
      controls = useInterviewsNavigation(tabLocation('competencies'));
      return null;
    }
    await act(async () => root.render(<Harness />));

    let opened = true;
    await act(async () => {
      opened = controls.openSession('not-a-session');
    });
    expect(opened).toBe(false);
    expect(controls.location).toEqual(tabLocation('competencies'));

    await act(async () => {
      opened = controls.openSession(SESSION_ID);
    });
    expect(opened).toBe(true);
    expect(controls.location).toEqual({
      view: 'session',
      sessionId: SESSION_ID,
      returnTo: 'competencies',
    });

    await act(async () => controls.leaveSession());
    expect(controls.location).toEqual(tabLocation('competencies'));
  });
});

describe('Interviews navigation semantics', () => {
  it('keeps the original return tab when switching sessions and leaves tabs unchanged on back', () => {
    const first = sessionLocation(tabLocation('prepare'), SESSION_ID)!;
    const second = sessionLocation(
      first,
      '7f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    )!;
    expect(second).toEqual({
      view: 'session',
      sessionId: '7f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
      returnTo: 'prepare',
    });
    expect(backLocation(second)).toEqual(tabLocation('prepare'));
    expect(backLocation(tabLocation('history'))).toEqual(
      tabLocation('history'),
    );
    expect(sessionLocation(tabLocation('prepare'), '')).toBeNull();
  });
});
