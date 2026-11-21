// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardsFixture } from './fixtures/cards-fixture';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CardsFixture />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('shared cards and disclosure', () => {
  it('keeps static and nested cards non-focusable while the full-card action is a real button', async () => {
    const main = container.querySelector<HTMLElement>(
      '[data-testid="main-card"]',
    )!;
    const nested = container.querySelector<HTMLElement>(
      '[data-testid="nested-card"]',
    )!;
    const summary = container.querySelector<HTMLElement>(
      '[data-testid="summary-card"]',
    )!;
    expect(main.tagName).toBe('DIV');
    expect(main.tabIndex).toBe(-1);
    expect(nested.classList.contains('ui-card-subtle')).toBe(true);
    expect(summary.classList.contains('ui-card-compact')).toBe(true);
    expect(main.querySelector('.ui-card-header')?.textContent).toContain(
      'Ready',
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="model-card"]',
    )!;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await act(async () => button.click());
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('ui-card-selected')).toBe(true);
  });

  it('uses native disclosure semantics and retains content across toggles', async () => {
    const details = container.querySelector<HTMLDetailsElement>(
      '[data-testid="technical-details"]',
    )!;
    const summary = details.querySelector('summary')!;
    const content = details.querySelector('.ui-disclosure-content')!;
    expect(details.open).toBe(false);
    expect(content.textContent).toContain('Only local models');
    expect(summary.textContent).toContain('Technical details');
    await act(async () => summary.click());
    expect(details.open).toBe(true);
    await act(async () => summary.click());
    expect(details.open).toBe(false);
    expect(details.querySelector('.ui-disclosure-content')).toBe(content);
  });
});
