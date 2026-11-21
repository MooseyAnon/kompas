// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfilePage } from '../src/renderer/pages/profile/ProfilePage';

const id = '00000000-0000-4000-8000-000000000001';
const now = '2026-11-16T00:00:00.000Z';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: { action: string; payload: Record<string, unknown> }[];
let profile: Record<string, unknown>;
let targets: Record<string, unknown>[];
let experiences: Record<string, unknown>[];
let skills: string[];

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
function input(label: string, value: string) {
  const node = [...container.querySelectorAll('input,textarea')].find(
    (element) => element.closest('label')?.textContent?.includes(label),
  ) as HTMLInputElement;
  expect(node, `field ${label}`).toBeDefined();
  const setter = Object.getOwnPropertyDescriptor(
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(async () => {
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
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) =>
    setTimeout(fn, 0),
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  calls = [];
  targets = [];
  experiences = [];
  skills = [];
  profile = {
    id: 'local',
    displayName: '',
    currentRole: null,
    currentStage: null,
    location: null,
    summary: null,
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
        calls.push({ action, payload });
        let data: unknown;
        switch (action) {
          case 'profile.get':
            data = { profile };
            break;
          case 'profile.update':
            profile = { ...profile, ...(payload.patch as object) };
            data = { profile };
            break;
          case 'experiences.list':
            data = { items: experiences };
            break;
          case 'experiences.create':
            experiences.push({
              ...payload,
              id,
              profileId: 'local',
              verificationStatus: 'user_confirmed',
              sourceDocumentId: null,
              createdAt: now,
              updatedAt: now,
            });
            data = { item: experiences.at(-1) };
            break;
          case 'experiences.update':
            experiences = experiences.map((item) =>
              item.id === payload.id
                ? { ...item, ...(payload.patch as object) }
                : item,
            );
            data = { item: experiences.find((item) => item.id === payload.id) };
            break;
          case 'targets.list':
            data = { items: targets };
            break;
          case 'targets.create':
            targets.push({
              ...payload,
              id: `00000000-0000-4000-8000-${String(targets.length + 2).padStart(12, '0')}`,
              profileId: 'local',
              createdAt: now,
              updatedAt: now,
            });
            data = { item: targets.at(-1) };
            break;
          case 'targets.update':
            targets = targets.map((item) =>
              item.id === payload.id
                ? { ...item, ...(payload.patch as object) }
                : item,
            );
            data = { item: targets.find((item) => item.id === payload.id) };
            break;
          case 'skills.list':
            data = { names: skills };
            break;
          case 'skills.replace':
            skills = payload.names as string[];
            data = { names: skills };
            break;
          case 'documents.list':
          case 'cvImports.list':
            data = { items: [] };
            break;
          default:
            throw Error(`Unexpected ${action}`);
        }
        return { ok: true, data };
      },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ProfilePage onNavigate={vi.fn()} />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('keeps six accessible tabs and reads without starting parse or inference', async () => {
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(6);
  expect(container.textContent).toContain('No confirmed skills yet');
  await click('Documents');
  expect(container.textContent).toContain('No documents stored yet');
  expect(
    calls.every(
      ({ action }) => !['start', 'retry', 'summary.generate'].includes(action),
    ),
  ).toBe(true);
  await click('Education');
  expect(container.textContent).toContain('No education recorded yet');
});

it('manually saves details, an education record, confirmed skills and two independent targets', async () => {
  await click('Edit details');
  input('Name', 'A Person');
  input('Current role', 'Analyst');
  input('Summary', 'A summary');
  await click('Save details');
  expect(profile.summary).toBe('A summary');
  await click('Education');
  await click('Add education');
  input('Role or title', 'Degree');
  await click('Save entry');
  expect(experiences[0].category).toBe('education');
  await click('Skills');
  await click('Edit skills');
  input('Skills (one per line', 'Python\nSQL');
  await click('Save confirmed skills');
  expect(skills).toEqual(['Python', 'SQL']);
  expect(document.body.textContent).toContain('2 skills');
  await click('Targets');
  for (const role of ['Researcher', 'Designer']) {
    await click('Add target');
    input('Target role', role);
    await click('Save target');
  }
  expect(targets.map((item) => item.roleTitle)).toEqual([
    'Researcher',
    'Designer',
  ]);
  await click('Deactivate');
  expect(targets.some((item) => item.active === false)).toBe(true);
  expect(calls.some(({ action }) => action === 'cvImports.start')).toBe(false);
});

it('saves month-only dates and keeps them editable on the profile page', async () => {
  await click('Experience');
  await click('Add experience');
  input('Role or title', 'Analyst');
  input('Start date', 'May 2021');
  await click('Save entry');
  expect(experiences[0].startDate).toBe('2021-05');
  await click('Edit');
  const date = [...container.querySelectorAll('input')].find((node) =>
    node.closest('label')?.textContent?.includes('Start date'),
  ) as HTMLInputElement;
  expect(date.value).toBe('2021-05');
  input('End date', 'Sept 2023');
  await click('Save entry');
  expect(experiences[0].endDate).toBe('2023-09');
});
