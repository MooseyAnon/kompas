import { usePendingCvImport } from './pages/onboarding/pendingCv';
import React, { useEffect, useRef, useState } from 'react';
import { getProfile } from '../../api';
import { type Destination } from './destinations';
import { shellPlatform } from '../../app/platform';
import { Page, type JobsEntry } from './GndPage';
import { CommandPalette } from '../CommandPalette';
import {
  GlowBackdrop,
  type BackdropDensity as SceneDensity,
} from './backdrop/GlowBackdrop';
import { TopNav } from './TopNav';
import './GndShell.css';

export function GndShell({
  Scene = GlowBackdrop,
  companion = null,
  initialDestination = 'home',
  initialJobsTab,
}: {
  Scene?: React.ComponentType<{ density: SceneDensity }>;
  companion?: React.ReactNode;
  initialDestination?: Destination;
  /** First tab Jobs opens on, e.g. Discover right after onboarding. */
  initialJobsTab?: 'discover' | 'saved' | 'review';
}) {
  // A CV still being read after onboarding is saved to the profile when done.
  usePendingCvImport();
  const [destination, setDestination] =
    useState<Destination>(initialDestination);
  const [jobs, setJobs] = useState<JobsEntry | undefined>(
    initialJobsTab ? { tab: initialJobsTab } : undefined,
  );
  const [paletteOpen, setPaletteOpenState] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);

  /** Open/close the palette, returning focus to where it was on close. */
  function setPaletteOpen(next: boolean | ((open: boolean) => boolean)) {
    setPaletteOpenState((open) => {
      const value = typeof next === 'function' ? next(open) : next;
      if (value && !open) {
        previousFocus.current =
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
            ? document.activeElement
            : null;
      } else if (!value && open) {
        const target = previousFocus.current;
        // React removes the modal and its inert background first.
        queueMicrotask(() =>
          (target?.isConnected
            ? target
            : document.querySelector<HTMLElement>('[data-testid="nav-home"]')
          )?.focus(),
        );
      }
      return value;
    });
  }
  const [name, setName] = useState('Account');
  const platform = shellPlatform();
  const shortcut = platform === 'mac' ? '⌘K' : 'Ctrl+K';

  useEffect(() => {
    void getProfile()
      .then((profile) => {
        const first = profile.displayName.trim().split(/\s+/u)[0];
        if (first) setName(first);
      })
      .catch(() => {});
  }, [destination]);

  // ⌘K / Ctrl+K opens the page palette from anywhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() === 'k' &&
        (platform === 'mac' ? event.metaKey : event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [platform]);

  /** Go to a page; Jobs can be opened on a specific job or tab. */
  function navigate(next: Destination, entry?: JobsEntry) {
    setJobs(entry);
    setDestination(next);
    setPaletteOpen(false);
  }

  return (
    <div
      className={`gnd-shell gnd-shell-${platform} gnd-shell-page-${destination}`}
      data-testid="app-shell"
    >
      <Scene density="full" />
      <TopNav
        active={destination}
        name={name}
        onNavigate={(next) => navigate(next)}
        inert={paletteOpen}
      />
      <main
        className="gnd-shell-content"
        data-testid={`page-${destination}`}
        inert={paletteOpen}
      >
        <Page
          key={`${destination}-${jobs?.opportunityId ?? jobs?.runId ?? jobs?.tab ?? jobs?.profileTab ?? (jobs?.filters ? 'filters' : '')}-${jobs?.practice ? `${jobs.practice.method}:${jobs.practice.subject ?? ''}` : ''}`}
          destination={destination}
          onNavigate={navigate}
          jobs={jobs}
        />
      </main>
      {companion && <div className="gnd-shell-companion">{companion}</div>}
      {paletteOpen && (
        <CommandPalette
          // Your applications is the Profile page in GND.
          active={destination === 'applications' ? 'profile' : destination}
          onChoose={(next) => navigate(next)}
          onClose={() => setPaletteOpen(false)}
          shortcut={shortcut}
        />
      )}
    </div>
  );
}
