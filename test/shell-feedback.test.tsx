// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/renderer/api';
import { ErrorBoundary } from '../src/renderer/app/ErrorBoundary';
import {
  failureNotice,
  Notifications,
  useNotify,
} from '../src/renderer/app/Notifications';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function ReportFailure() {
  const notify = useNotify();
  return (
    <button
      onClick={() =>
        notify(
          failureNotice(
            new ApiError('IO_ERROR', 'Local storage unavailable'),
            'Try again',
          ),
        )
      }
    >
      Report
    </button>
  );
}

describe('shell feedback', () => {
  it('shows recoverable codes and supports dismissal without raw stacks', async () => {
    await act(async () =>
      root.render(
        <Notifications>
          <ReportFailure />
        </Notifications>,
      ),
    );
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'IO_ERROR',
    );
    expect(container.textContent).not.toContain('at ReportFailure');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Dismiss notification"]',
        )!
        .click(),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      failureNotice(new Error('private document text'), 'Try again').message,
    ).toBe('Try again');
  });

  it('isolates unexpected render exceptions with a safe reload action', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    function Broken(): React.ReactNode {
      throw new Error('private document text');
    }
    try {
      await act(async () =>
        root.render(
          <ErrorBoundary>
            <Broken />
          </ErrorBoundary>,
        ),
      );
      expect(
        container.querySelector('[data-testid="shell-fallback"]')?.textContent,
      ).toContain('Reload workspace');
      expect(container.textContent).not.toContain('private document text');
    } finally {
      consoleError.mockRestore();
    }
  });
});
