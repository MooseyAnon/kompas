// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentsSection } from '../src/renderer/pages/profile/DocumentsSection';
import type { CvImport, Experience, Profile } from '../src/shared/contracts';

const id = '00000000-0000-4000-8000-000000000001';
const documentId = '00000000-0000-4000-8000-000000000002';
const now = '2026-11-16T00:00:00.000Z';
const candidate = (value: string | null) => ({
  value,
  status: value ? ('detected' as const) : ('missing' as const),
  origin: value ? ('llm' as const) : null,
  evidence: value,
  blockIndex: value ? 0 : null,
  reasons: [],
});
const draft = {
  parserVersion: 'cv-extract-full-v1' as const,
  adapterId: 'pdf',
  adapterVersion: '1',
  profile: {
    displayName: candidate('Candidate'),
    currentRole: candidate(null),
    currentStage: candidate(null),
    location: candidate(null),
    summary: candidate(null),
  },
  experiences: [
    {
      category: 'employment' as const,
      roleTitle: candidate('Analyst'),
      organisation: candidate('Firm'),
      startDate: candidate(null),
      endDate: candidate(null),
      description: candidate(null),
    },
  ],
  extras: {
    email: candidate(null),
    phone: candidate(null),
    skills: [candidate('SQL')],
  },
};
const profile: Profile = {
  id: 'local',
  displayName: '',
  currentStage: null,
  currentRole: null,
  location: null,
  summary: null,
  createdAt: now,
  updatedAt: now,
};
const doc = {
  id: documentId,
  category: 'cv',
  originalName: 'fixture.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 100,
  sha256: 'a'.repeat(64),
  createdAt: now,
};
let item: CvImport;
let calls: string[];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let applied: unknown;
async function click(text: string) {
  const node = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  );
  expect(node, `button ${text}`).toBeDefined();
  await act(async () => {
    node!.click();
  });
}
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  applied = null;
  item = {
    id,
    documentId,
    status: 'ready',
    sourceSha256: 'a'.repeat(64),
    appliedStatus: 'not_applied',
    draft,
    diagnostics: {
      detected: 2,
      ambiguous: 0,
      missing: 0,
      modelAttempted: true,
      modelResolved: 0,
      modelStatus: 'succeeded',
      warnings: [],
      errorCode: null,
      durationMs: 10,
    },
    createdAt: now,
    updatedAt: now,
  };
  Object.defineProperty(window, 'career', {
    configurable: true,
    value: {
      request: async ({
        action,
        payload,
      }: {
        action: string;
        payload: Record<string, unknown>;
      }) => {
        calls.push(action);
        let data: unknown;
        switch (action) {
          case 'list':
            data = { items: [doc] };
            break;
          case 'start':
          case 'get':
          case 'retry':
            data = { item };
            break;
          case 'cancel':
            item = { ...item, status: 'cancelled' };
            data = { cancelled: true };
            break;
          case 'discard':
            data = { discarded: true };
            break;
          case 'profile.applyImport':
            applied = payload;
            data = {
              profile,
              experiences: [],
              alreadyApplied:
                calls.filter((call) => call === action).length > 1,
            };
            break;
          case 'skills.list':
            data = { names: [] };
            break;
          case 'skills.replace':
            data = { names: payload.names };
            break;
          default:
            if (action === 'cvImports.list')
              data = { items: [{ ...item, draft: undefined }] };
            else throw Error(`Unexpected action ${action}`);
        }
        return { ok: true, data };
      },
    },
  });
  // Distinguish the two module-owned list commands.
  const request = window.career.request;
  window.career.request = ((envelope: Parameters<typeof request>[0]) =>
    envelope.module === 'cvImports' && envelope.action === 'list'
      ? Promise.resolve({
          ok: true as const,
          data: { items: [{ ...item, draft: undefined }] },
        })
      : request(envelope)) as typeof request;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <DocumentsSection
        profile={profile}
        experiences={[]}
        skills={[]}
        onChanged={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('resumes existing draft without reparse; confirms only selected fields and returns idempotent receipt', async () => {
  expect(calls).not.toContain('start');
  await click('Resume review');
  expect(container.textContent).toContain('CV: Candidate');
  const checkbox = [
    ...container.querySelectorAll('input[type="checkbox"]'),
  ][0] as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  await act(async () => {
    checkbox.click();
  });
  await click('Confirm selected profile, experience and skills');
  expect(applied).toMatchObject({
    importId: id,
    profile: {},
    experiences: [{ decision: 'add', value: { roleTitle: 'Analyst' } }],
    skills: ['SQL'],
  });
  await click('Confirm selected profile, experience and skills');
  expect(container.textContent).toContain('Already applied');
  expect(calls).not.toContain('retry');
});

it('prefills and preselects the review as soon as parsing finishes without overwriting edits', async () => {
  item = { ...item, status: 'processing', draft: null };
  vi.useFakeTimers();
  try {
    await click('Resume review');
    item = {
      ...item,
      status: 'ready',
      draft,
      updatedAt: '2026-11-16T00:00:01.000Z',
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    const name = container.querySelector(
      'input[aria-label="Proposed displayName"]',
    ) as HTMLInputElement;
    expect(name.value).toBe('Candidate');
    expect(
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (
        container.querySelector(
          'select[aria-label="CV entry 1 decision"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe('add');
    expect(
      (
        container.querySelector(
          'textarea:not([aria-label])',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('SQL');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(name, 'Edited Candidate');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(name.value).toBe('Edited Candidate');
    await click('Confirm selected profile, experience and skills');
    expect(applied).toMatchObject({
      profile: { displayName: 'Edited Candidate' },
      skills: ['SQL'],
    });
  } finally {
    vi.useRealTimers();
  }
});

it('prefills review-only summary, experience and skills and saves corrected selections on confirmation', async () => {
  const reviewOnly = (value: string) => ({
    ...candidate(value),
    status: 'needs_review' as const,
  });
  item = { ...item, status: 'processing', draft: null };
  vi.useFakeTimers();
  try {
    await click('Resume review');
    item = {
      ...item,
      status: 'partial',
      draft: {
        ...draft,
        profile: {
          ...draft.profile,
          summary: reviewOnly('CV summary spanning multiple source lines.'),
          currentStage: reviewOnly('invalid_stage'),
        },
        experiences: [
          {
            ...draft.experiences[0],
            roleTitle: reviewOnly('Analyst'),
            startDate: reviewOnly('2020-01-01'),
          },
        ],
        extras: { ...draft.extras, skills: [reviewOnly('SQL')] },
      },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    const summary = container.querySelector(
      'textarea[aria-label="Proposed summary"]',
    ) as HTMLTextAreaElement;
    expect(summary.value).toBe('CV summary spanning multiple source lines.');
    const checkboxes = [
      ...container.querySelectorAll('input[type="checkbox"]'),
    ] as HTMLInputElement[];
    expect(checkboxes[3].checked).toBe(false);
    expect(checkboxes[4].checked).toBe(true);
    expect(
      (
        container.querySelector(
          'select[aria-label="CV entry 1 decision"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe('add');
    expect(
      (
        container.querySelector(
          'textarea:not([aria-label])',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('SQL');
    expect(container.textContent).toContain('needs_review');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(summary, 'Corrected summary');
      summary.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Confirm selected profile, experience and skills');
    expect(applied).toMatchObject({
      profile: { summary: 'Corrected summary' },
      experiences: [
        {
          decision: 'add',
          value: { roleTitle: 'Analyst', startDate: '2020-01-01' },
        },
      ],
      skills: ['SQL'],
    });
    expect(
      (applied as { profile: Record<string, unknown> }).profile,
    ).not.toHaveProperty('currentStage');
  } finally {
    vi.useRealTimers();
  }
});

it('keeps an earlier draft visible when retry fails or is cancelled', async () => {
  item = {
    ...item,
    status: 'failed',
    diagnostics: {
      ...item.diagnostics,
      errorCode: 'MODEL_UNAVAILABLE',
      modelStatus: 'unavailable',
    },
  };
  await click('Resume review');
  expect(container.textContent).toContain('Previous draft retained');
  expect(container.textContent).toContain('MODEL_UNAVAILABLE');
  expect(container.textContent).toContain('Local AI settings');
  expect(calls).not.toContain('start');
});

it('defaults a matching experience to keep instead of adding a duplicate', async () => {
  const existing: Experience = {
    id: '00000000-0000-4000-8000-000000000003',
    profileId: 'local',
    category: 'employment',
    roleTitle: 'Analyst',
    organisation: 'Firm',
    startDate: null,
    endDate: null,
    description: '',
    verificationStatus: 'user_confirmed',
    sourceDocumentId: null,
    createdAt: now,
    updatedAt: now,
  };
  await act(async () => {
    root.render(
      <DocumentsSection
        profile={profile}
        experiences={[existing]}
        skills={[]}
        onChanged={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
  });
  await click('Resume review');
  expect(
    (
      container.querySelector(
        'select[aria-label="CV entry 1 decision"]',
      ) as HTMLSelectElement
    ).value,
  ).toBe(`keep:${existing.id}`);
});

it('shows raw month names and saves their canonical precision without losing dates', async () => {
  item = {
    ...item,
    draft: {
      ...draft,
      experiences: [
        {
          ...draft.experiences[0],
          startDate: { ...candidate('Sept 2023'), status: 'needs_review' },
          endDate: { ...candidate('May 2024'), status: 'needs_review' },
        },
      ],
    },
  };
  await click('Resume review');
  const dates = [
    ...container.querySelectorAll('fieldset input[placeholder^="e.g. Sept"]'),
  ] as HTMLInputElement[];
  expect(dates.map((input) => input.value)).toEqual(['Sept 2023', 'May 2024']);
  expect(container.textContent).toContain('Saves as 2023-09');
  expect(container.textContent).toContain('Saves as 2024-05');

  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(dates[0], 'Spring 2023');
    dates[0].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Confirm selected profile, experience and skills');
  expect(applied).toBeNull();
  expect(container.textContent).toContain(
    'Unrecognised date; correct or clear',
  );

  await act(async () => {
    setter.call(dates[0], 'Sept 2023');
    dates[0].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Confirm selected profile, experience and skills');
  expect(applied).toMatchObject({
    experiences: [
      { decision: 'add', value: { startDate: '2023-09', endDate: '2024-05' } },
    ],
  });
});
