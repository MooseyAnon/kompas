// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { JobsPage } from '../src/renderer/pages/jobs/JobsPage';
import type {
  Application,
  ImportPreview,
} from '../src/shared/contracts/applications';

const now = '2026-11-16T00:00:00.000Z';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function application(
  n: number,
  kind: Application['currentStage']['stageKind'],
  label: string,
  archived = false,
): Application {
  return {
    id: id(n),
    companyName: `Employer ${n}`,
    roleTitle: `Role ${n}`,
    location: null,
    jobUrl: null,
    appliedAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: archived ? now : null,
    currentStage: {
      id: id(n + 100),
      applicationId: id(n),
      stageLabel: label,
      stageKind: kind,
      stageSubtype: null,
      occurredAt: now,
      recordedAt: now,
      source: 'user',
      sourceRef: null,
      sourceEvidence: null,
      correctsEventId: null,
    },
  };
}
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let backend: ReturnType<typeof vi.fn>;
let records: Application[];
let preview: ImportPreview;
let failList = false;
let history: Application['currentStage'][] = [];
let notes: Array<{
  id: string;
  applicationId: string;
  body: string;
  source: 'self_reported';
  stageEventId: null;
  observedAt: null;
  createdAt: string;
  updatedAt: string;
}> = [];
const calls = (action: string) =>
  backend.mock.calls
    .map(
      ([input]) =>
        input as { action: string; payload: Record<string, unknown> },
    )
    .filter((input) => input.action === action);
const ok = (data: unknown) => ({ ok: true, data });

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
  records = [];
  failList = false;
  history = [];
  notes = [];
  preview = {
    suppliedUrl: 'https://example.org/job',
    observedUrl: 'https://example.org/job',
    readSucceeded: true,
    extractionSucceeded: true,
    snapshotAvailable: true,
    reason: null,
    webError: null,
    companyName: 'Suggested company',
    roleTitle: 'Suggested role',
    location: null,
    snapshot: {
      schemaVersion: 1,
      source: 'manual',
      sourceUrl: 'https://example.org/job',
      capturedAt: now,
      title: null,
      company: null,
      location: null,
      descriptionText: 'Full original job description',
      contentBlocks: [],
    },
  };
  backend = vi.fn(
    async ({
      action,
      module,
      payload,
    }: {
      action: string;
      module: string;
      payload: Record<string, any>;
    }) => {
      if (action === 'savedSearches.list' || action === 'runs.list')
        return ok({ items: [], nextCursor: null });
      if (module === 'documents' && action === 'list') return ok({ items: [] });
      if (action === 'list') {
        if (failList)
          return {
            ok: false,
            error: {
              code: 'IO_ERROR',
              message: 'Read failed',
              correlationId: id(1),
            },
          };
        const matching = records.filter(
          (item) =>
            Boolean(item.archivedAt) === payload.archived &&
            (!payload.search ||
              `${item.companyName} ${item.roleTitle}`
                .toLowerCase()
                .includes(payload.search.toLowerCase())),
        );
        const start = payload.cursor
          ? matching.findIndex((item) => item.id === payload.cursor) + 1
          : 0;
        const items = matching.slice(start, start + payload.limit);
        return ok({
          items,
          nextCursor:
            start + payload.limit < matching.length ? items.at(-1)?.id : null,
        });
      }
      if (action === 'imports.preview') return ok(preview);
      if (action === 'get') {
        const item = records.find((record) => record.id === payload.id);
        return item
          ? ok({
              item: {
                application: item,
                stages: history.length ? history : [item.currentStage],
                snapshot: null,
                notes,
                documents: [],
              },
            })
          : {
              ok: false,
              error: {
                code: 'NOT_FOUND',
                message: 'Not found',
                correlationId: id(1),
              },
            };
      }
      if (action === 'stages.record' || action === 'stages.correct') {
        const item = records.find(
          (record) => record.id === payload.applicationId,
        )!;
        const current = item.currentStage;
        const next = {
          ...current,
          id: id(200 + history.length),
          stageLabel: payload.stageLabel,
          stageKind: payload.stageKind,
          stageSubtype: payload.stageSubtype ?? null,
          occurredAt: payload.occurredAt ?? now,
          correctsEventId: action === 'stages.correct' ? current.id : null,
        };
        history = [...(history.length ? history : [current]), next];
        item.currentStage = next;
        return ok({ item: next });
      }
      if (action === 'archive' || action === 'restore') {
        const item = records.find((record) => record.id === payload.id)!;
        item.archivedAt = action === 'archive' ? now : null;
        return ok({ item });
      }
      if (action === 'notes.create') {
        const note = {
          id: id(300),
          applicationId: payload.applicationId,
          body: payload.body,
          source: payload.source,
          stageEventId: null,
          observedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        notes = [note];
        return ok({ item: note });
      }
      if (action === 'notes.remove') {
        notes = [];
        return ok({ done: true });
      }
      if (action === 'create') {
        const item = application(
          records.length + 1,
          payload.initialStage.stageKind,
          payload.initialStage.stageLabel,
        );
        item.companyName = payload.companyName;
        item.roleTitle = payload.roleTitle;
        item.jobUrl = payload.jobUrl;
        records.unshift(item);
        return ok({
          item: {
            application: item,
            stages: [item.currentStage],
            snapshot: payload.snapshot ?? null,
            notes: [],
            documents: [],
          },
        });
      }
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          correlationId: id(1),
        },
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
});
async function render() {
  await act(async () => root.render(<JobsPage />));
  await click('Applications');
}
async function click(text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === text,
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const input = Array.from(container.querySelectorAll('label'))
    .find((node) => node.textContent?.startsWith(label))
    ?.querySelector('input');
  expect(input, label).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    container
      .querySelector<HTMLFormElement>('.ats-create form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

describe('Applications workspace', () => {
  it('keeps repeated interview events and current-only corrections on the board, with archived history', async () => {
    records = [application(1, 'interview', 'Recruiter interview')];
    await render();
    await click('Open application');
    expect(calls('get')).toHaveLength(1);
    expect(calls('stages.record')).toHaveLength(0);
    const stageForm =
      container.querySelector<HTMLFormElement>('.ats-timeline form')!;
    const label = Array.from(stageForm.querySelectorAll('input')).find(
      (input) => input.placeholder.includes('Technical'),
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(label, 'Technical Round 1');
      label.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      stageForm.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(container.querySelectorAll('.ats-timeline li')).toHaveLength(2);
    expect(container.textContent).toContain('Technical Round 1');
    expect(calls('stages.record')).toHaveLength(1);
    await click('Correct current event');
    const correctionForm =
      container.querySelector<HTMLFormElement>('.ats-timeline form')!;
    const correctionLabel = Array.from(
      correctionForm.querySelectorAll('input'),
    ).find((input) => input.placeholder.includes('Technical'))!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(correctionLabel, 'Technical Round 2');
      correctionLabel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      correctionForm.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(calls('stages.correct')).toHaveLength(1);
    expect(container.textContent).toContain('Replaced by correction');
    expect(container.querySelectorAll('.ats-timeline li')).toHaveLength(3);
    await click('Back to Applications');
    expect(
      container.querySelector('[aria-label="Interviewing"]')?.textContent,
    ).toContain('Technical Round 2');
    await click('Open application');
    vi.stubGlobal('confirm', () => true);
    await click('Archive application');
    await click('Back to Applications');
    await click('Archived');
    await click('Open application');
    expect(container.textContent).toContain('Technical Round 2');
    await click('Restore application');
    expect(calls('restore')).toHaveLength(1);
  });
  it('groups all kinds, pages and filters without pretending loaded counts are totals', async () => {
    records = [
      application(1, 'saved', 'Pending'),
      application(2, 'applied', 'Applied'),
      application(3, 'screening', 'Phone screen'),
      application(4, 'interview', 'Technical round 2'),
      application(5, 'assessment', 'Take-home'),
      application(6, 'offer', 'Offer'),
      application(7, 'rejected', 'Rejected'),
      application(8, null, 'Custom'),
      ...Array.from({ length: 16 }, (_, i) =>
        application(i + 9, 'saved', 'Pending'),
      ),
      application(25, 'withdrawn', 'Withdrawn'),
      application(26, 'saved', 'Archived', true),
    ];
    await render();
    expect(container.querySelectorAll('[data-application-id]')).toHaveLength(
      20,
    );
    expect(container.textContent).toContain(
      '20 loaded applications · More available',
    );
    expect(
      container.querySelector('[aria-label="Interviewing"]')?.textContent,
    ).toContain('Technical round 2');
    expect(
      container.querySelector('[aria-label="Interviewing"]')?.textContent,
    ).toContain('Take-home');
    expect(
      container.querySelector('[aria-label="Pending"]')?.textContent,
    ).toContain('Custom');
    await click('Load more applications');
    expect(container.querySelectorAll('[data-application-id]')).toHaveLength(
      25,
    );
    await click('Archived');
    expect(container.textContent).toContain('Archived');
    expect(container.querySelectorAll('[data-application-id]')).toHaveLength(1);
    await click('Active');
    await fill('Search company', 'Employer 4');
    await click('Search');
    expect(container.querySelectorAll('[data-application-id]')).toHaveLength(1);
    await click('List');
    expect(container.querySelector('.ats-list')).toBeTruthy();
    failList = true;
    await click('Search');
    expect(container.textContent).toContain('Read failed');
    failList = false;
    await click('Retry');
    expect(container.textContent).not.toContain('Read failed');
  });

  it('creates distinct manual applications without invoking Web and preserves existing stage', async () => {
    await render();
    await click('Add application');
    await click('Enter manually');
    await fill('Company', 'Example');
    await fill('Role', 'Analyst');
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = 'interview';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await fill('Specific stage label', 'Technical Interview Round 2');
    await submit();
    expect(calls('create')).toHaveLength(1);
    expect(calls('imports.preview')).toHaveLength(0);
    expect(calls('create')[0].payload.initialStage).toEqual({
      stageKind: 'interview',
      stageLabel: 'Technical Interview Round 2',
    });
    expect(container.textContent).toContain('Stage timeline');
    await click('Back to Applications');
    await click('Add application');
    await click('Enter manually');
    await fill('Company', 'Example');
    await fill('Role', 'Analyst');
    await submit();
    expect(calls('create')).toHaveLength(2);
  });

  it('previews without writing, corrects metadata, explicitly confirms complete snapshot and falls back on failure', async () => {
    await render();
    await click('Add application');
    await fill('Job URL', 'https://example.org/job');
    await click('Preview job URL');
    expect(calls('create')).toHaveLength(0);
    await fill('Company', 'Correct employer');
    await act(async () => {
      const check = container.querySelector<HTMLInputElement>(
        '.ats-preview input[type="checkbox"]',
      )!;
      check.click();
    });
    await act(async () => {
      const form =
        container.querySelector<HTMLFormElement>('.ats-create form')!;
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(calls('create')).toHaveLength(1);
    expect(calls('create')[0].payload.snapshot).toEqual(preview.snapshot);
    expect(calls('create')[0].payload.companyName).toBe('Correct employer');
    await click('Back to Applications');
    await click('Add application');
    preview = {
      ...preview,
      snapshot: null,
      snapshotAvailable: false,
      readSucceeded: false,
      extractionSucceeded: false,
      reason: 'page_unavailable',
      companyName: null,
      roleTitle: null,
    };
    await fill('Job URL', 'https://example.org/job');
    await click('Preview job URL');
    expect(container.textContent).toContain('The page could not be read');
    await click('Enter manually');
    await fill('Company', 'Manual');
    await fill('Role', 'Researcher');
    await submit();
    expect(calls('create')[1].payload.jobUrl).toBe('https://example.org/job');
    expect(calls('create')[1].payload.snapshot).toBeUndefined();
  });
});
