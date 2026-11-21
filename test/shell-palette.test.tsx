// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifications } from '../src/renderer/app/Notifications';
import { Shell } from '../src/renderer/presentation/Shell';

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

function press(key: string, options: KeyboardEventInit = {}) {
  (document.activeElement ?? window).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, ...options }),
  );
}
function input(value: string, selector = '[data-testid="palette-search"]') {
  const field = container.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('shell palette', () => {
  it('embeds a nonmodal five-page search on Home and navigates by pointer and keyboard', async () => {
    const panel = container.querySelector(
      '[data-testid="home-command-panel"]',
    )!;
    expect(panel.getAttribute('role')).not.toBe('dialog');
    expect(container.querySelector('.palette-scrim')).toBeNull();
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(false);
    expect(panel.querySelectorAll('[role="option"]')).toHaveLength(5);
    const search = panel.querySelector<HTMLInputElement>('input')!;
    await act(async () => search.focus());
    await act(async () =>
      input('inter', '[data-testid="home-command-search"]'),
    );
    expect(panel.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () => press('Escape'));
    expect(panel.querySelectorAll('[role="option"]')).toHaveLength(5);
    expect(document.activeElement).toBe(search);
    await act(async () => press('ArrowDown'));
    expect(search.getAttribute('aria-activedescendant')).toBe(
      'home-command-jobs',
    );
    await act(async () => press('Enter'));
    expect(container.querySelector('[data-testid="page-jobs"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="home-command-panel"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="nav-trigger"]'),
    ).not.toBeNull();
  });

  it('Home shortcut opens the modal once and returns focus to the embedded search', async () => {
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="home-command-search"]',
    )!;
    await act(async () => search.focus());
    await act(async () => press('k', { ctrlKey: true }));
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="palette-search"]')).toBe(
      document.activeElement,
    );
    expect(
      container.querySelector('[data-testid="home-command-panel"]'),
    ).not.toBeNull();
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true);
    await act(async () => press('Escape'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('Home CTAs lead to existing Jobs and Interviews destinations', async () => {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-actions button')!
        .click(),
    );
    expect(container.querySelector('[data-testid="page-jobs"]')).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="nav-trigger"]')!
        .click(),
    );
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-testid="destination-home"]')!
        .click(),
    );
    await act(async () =>
      container
        .querySelectorAll<HTMLButtonElement>('.home-actions button')[1]
        .click(),
    );
    expect(
      container.querySelector('[data-testid="page-interviews"]'),
    ).not.toBeNull();
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
    expect(
      container
        .querySelector('[data-testid="alternate-scene"]')
        ?.getAttribute('data-density'),
    ).toBe('full');
    expect(container.querySelector('.shell-companion')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.shell-links button')!
        .click(),
    );
    expect(
      container
        .querySelector('[data-testid="alternate-scene"]')
        ?.getAttribute('data-density'),
    ).toBe('full');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="nav-trigger"]')!
        .click(),
    );
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-testid="destination-settings"]')!
        .click(),
    );
    expect(
      container
        .querySelector('[data-testid="alternate-scene"]')
        ?.getAttribute('data-density'),
    ).toBe('full');
  });

  it('filters five destinations, selects with arrows and Enter, and restores the prior focus', async () => {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-actions button')!
        .click(),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="nav-trigger"]',
    )!;
    await act(async () => trigger.click());
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="palette-search"]'),
    );
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(5);
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true);
    await act(async () => input('pro'));
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="destination-profile"]'),
    ).not.toBeNull();
    await act(async () => press('Enter'));
    expect(
      container.querySelector('[data-testid="page-profile"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="destination-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => press('k', { ctrlKey: true }));
    expect(
      container
        .querySelector('[data-testid="destination-profile"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    await act(async () => press('ArrowDown'));
    expect(
      container.querySelector('[aria-activedescendant="palette-settings"]'),
    ).not.toBeNull();
    await act(async () => press('Tab'));
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="palette-search"]'),
    );
    await act(async () => press('ArrowDown'));
    await act(async () => press('ArrowDown'));
    await act(async () => press('Enter'));
    expect(container.querySelector('[data-testid="page-jobs"]')).not.toBeNull();
  });

  it('closes on Escape, offers an honest no-results state and keeps the scene inert', async () => {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-actions button')!
        .click(),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="nav-trigger"]',
    )!;
    await act(async () => trigger.click());
    await act(async () => input('unknown'));
    expect(container.textContent).toContain('No matching pages.');
    await act(async () => press('Escape'));
    expect(document.activeElement).toBe(trigger);
    expect(
      container.querySelector('[data-testid="destination-menu"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="meadow-scene"]')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(container.querySelector('[data-testid="page-jobs"]')).not.toBeNull();
  });
});
