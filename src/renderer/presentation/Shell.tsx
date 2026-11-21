import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { type Destination } from '../app/destinations';
import { shellPlatform } from '../app/platform';
import { Page } from '../pages/Page';
import { CommandPalette } from './CommandPalette';
import { MeadowScene, type SceneDensity } from './meadow/MeadowScene';
import './Shell.css';

export function Shell({
  Scene = MeadowScene,
  companion = null,
}: {
  Scene?: React.ComponentType<{ density: SceneDensity }>;
  companion?: React.ReactNode;
}) {
  const [destination, setDestination] = useState<Destination>('home');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const platform = shellPlatform();

  function openPalette() {
    previousFocus.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : trigger.current;
    setPaletteOpen(true);
  }

  function closePalette() {
    setPaletteOpen(false);
    // React removes the modal and its inert background before focus returns.
    queueMicrotask(() => {
      const target = previousFocus.current;
      (target?.isConnected
        ? target
        : (trigger.current ??
          document.querySelector<HTMLElement>(
            '[data-testid="home-command-search"]',
          ))
      )?.focus();
    });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() === 'k' &&
        (platform === 'mac' ? event.metaKey : event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [platform, paletteOpen]);

  function choose(next: Destination) {
    setDestination(next);
    closePalette();
  }

  // Workspace pages keep a fixed header and scroll inside their own outlet.
  const workspace =
    destination === 'settings' ||
    destination === 'interviews' ||
    destination === 'jobs' ||
    destination === 'profile';

  return (
    <div
      className={`shell shell-${platform}${destination === 'home' ? ' shell-home' : ''}${workspace ? ' shell-workspace' : ''}`}
      data-testid="app-shell"
    >
      <Scene
        density={destination === 'home' || workspace ? 'full' : 'subtle'}
      />
      <header className="shell-header" inert={paletteOpen}>
        <div className="shell-drag" aria-hidden="true" />
        {destination !== 'home' && (
          <button
            ref={trigger}
            type="button"
            className="shell-trigger"
            aria-label="Open page palette"
            aria-expanded={paletteOpen}
            aria-controls="destination-menu"
            data-testid="nav-trigger"
            onClick={openPalette}
          >
            <Sparkles size={16} strokeWidth={2} aria-hidden="true" /> Pages
            <span className="shell-shortcut">
              {platform === 'mac' ? '⌘K' : 'Ctrl+K'}
            </span>
          </button>
        )}
      </header>
      <main
        className={`shell-content${destination === 'home' ? ' shell-content-home' : ''}${workspace ? ' shell-content-workspace' : ''}`}
        data-testid={`page-${destination}`}
        inert={paletteOpen}
      >
        <Page
          key={destination}
          destination={destination}
          onNavigate={setDestination}
          shortcut={platform === 'mac' ? '⌘K' : 'Ctrl+K'}
        />
      </main>
      {companion && <div className="shell-companion">{companion}</div>}
      {paletteOpen && (
        <CommandPalette
          active={destination}
          onChoose={choose}
          onClose={closePalette}
          shortcut={platform === 'mac' ? '⌘K' : 'Ctrl+K'}
        />
      )}
    </div>
  );
}
