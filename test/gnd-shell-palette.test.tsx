// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifications } from '../src/renderer/app/Notifications';
import { GndShell as Shell } from '../src/renderer/presentation/gnd/GndShell';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

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
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Notifications>
        <Shell />
      </Notifications>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const byId = (id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function press(key: string, options: KeyboardEventInit = {}) {
  (document.activeElement ?? window).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, ...options }),
  );
}
function input(value: string) {
  const field = byId('palette-search') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('GND: shell navigation', () => {
  it('switches the three main pages from the top bar and marks the current one', async () => {
    expect(byId('page-home')).not.toBeNull();
    expect(byId('nav-home')?.getAttribute('aria-current')).toBe('page');
    await act(async () => byId('nav-jobs')!.click());
    expect(byId('page-jobs')).not.toBeNull();
    expect(byId('nav-jobs')?.getAttribute('aria-current')).toBe('page');
    expect(byId('nav-home')?.hasAttribute('aria-current')).toBe(false);
    await act(async () => byId('nav-interviews')!.click());
    expect(byId('page-interviews')).not.toBeNull();
  });

  it('opens Profile and Settings from the name menu, by keyboard too', async () => {
    const account = byId('nav-account') as HTMLButtonElement;
    expect(account.getAttribute('aria-expanded')).toBe('false');
    await act(async () => account.click());
    expect(account.getAttribute('aria-expanded')).toBe('true');
    const items = container.querySelectorAll('[role="menuitem"]');
    expect([...items].map((item) => item.textContent)).toEqual([
      'Profile',
      'Settings',
    ]);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => press('ArrowDown'));
    expect(document.activeElement).toBe(items[1]);
    await act(async () => press('Escape'));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(account);

    await act(async () => account.click());
    await act(async () =>
      (
        container.querySelectorAll('[role="menuitem"]')[0] as HTMLElement
      ).click(),
    );
    expect(byId('page-profile')).not.toBeNull();
    expect(account.classList.contains('is-active')).toBe(true);
  });

  it('opens the page palette with the shortcut, filters, selects with arrows and Enter, and restores focus', async () => {
    const jobs = byId('nav-jobs') as HTMLButtonElement;
    jobs.focus();
    await act(async () => press('k', { ctrlKey: true }));
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(byId('palette-search'));
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(5);
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true);
    await act(async () => input('pro'));
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () => press('Enter'));
    expect(byId('page-profile')).not.toBeNull();
    expect(byId('destination-menu')).toBeNull();
    await act(async () => {});
    expect(document.activeElement).toBe(jobs);
  });

  it('closes on Escape with an honest no-results state and keeps the scene decorative', async () => {
    await act(async () => press('k', { ctrlKey: true }));
    await act(async () => input('unknown'));
    expect(container.textContent).toContain('No matching pages.');
    await act(async () => press('Escape'));
    expect(byId('destination-menu')).toBeNull();
    expect(byId('app-backdrop')?.getAttribute('aria-hidden')).toBe('true');
    expect(byId('page-home')).not.toBeNull();
  });

  it('passes only visual density to a replaceable scene and leaves the companion slot empty', async () => {
    function AlternateScene({
      density,
    }: {
      density: 'full' | 'subtle' | 'none';
    }) {
      return <div data-testid="alternate-scene" data-density={density} />;
    }
    await act(async () =>
      root.render(
        <Notifications>
          <Shell Scene={AlternateScene} />
        </Notifications>,
      ),
    );
    expect(byId('alternate-scene')?.getAttribute('data-density')).toBe('full');
    expect(container.querySelector('.shell-companion')).toBeNull();
    await act(async () => byId('nav-jobs')!.click());
    expect(byId('alternate-scene')?.getAttribute('data-density')).toBe('full');
  });
});
