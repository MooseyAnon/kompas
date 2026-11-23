import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Bot, Database, Globe2, Mic, Monitor } from 'lucide-react';
import { LocalAi } from '../../../../pages/settings/local-ai/LocalAi';
import { OllamaNudge } from './OllamaNudge';
import { OllamaSetup } from '../onboarding/OllamaSetup';
import { localAiReady } from '../onboarding/steps/LocalAiStep';
import { AudioSettings } from '../../../../pages/settings/audio/AudioSettings';
import { BrowserSettings } from '../../../../pages/settings/browsers/BrowserSettings';
import { SystemSettings } from '../../../../pages/settings/system/SystemSettings';
import { DiagnosticsSettings } from '../../../../pages/settings/diagnostics/DiagnosticsSettings';
import { StorageSettings } from '../../../../pages/settings/storage/StorageSettings';
import '../../../../pages/settings/SettingsPage.css';
import './GndSettingsPage.css';

const sections = [
  { id: 'local-ai', label: 'Local AI', icon: Bot },
  { id: 'audio', label: 'Audio', icon: Mic },
  { id: 'browsers', label: 'Browsers', icon: Globe2 },
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity },
  { id: 'storage', label: 'Data & Storage', icon: Database },
] as const;
type Section = (typeof sections)[number]['id'];

/** Settings in the GND style; the sections themselves are shared with Meadow. */
export function GndSettingsPage() {
  const [selected, setSelected] = useState<Section>('local-ai');
  const selectSection = (next: Section) => setSelected(next);
  const [aiVersion, setAiVersion] = useState(0);
  // Until Ollama and its model are ready, Local AI shows the setup steps.
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void localAiReady().then((value) => live && setAiReady(value));
    return () => {
      live = false;
    };
  }, []);
  const [indicator, setIndicator] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const [indicatorReady, setIndicatorReady] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const outlet = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // Do not slide the indicator in from the origin on first paint.
    const frame = requestAnimationFrame(() => setIndicatorReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    const track = strip.current;
    const button = buttons.current[selected];
    if (!track || !button) return;
    const measure = () =>
      setIndicator({
        left: button.offsetLeft,
        top: button.offsetTop,
        width: button.offsetWidth,
        height: button.offsetHeight,
      });
    measure();
    const scroller = track.parentElement;
    if (scroller) {
      const left = button.offsetLeft;
      if (left < scroller.scrollLeft + 8) scroller.scrollLeft = left - 8;
      else if (
        left + button.offsetWidth + 8 >
        scroller.scrollLeft + scroller.clientWidth
      )
        scroller.scrollLeft =
          left + button.offsetWidth - scroller.clientWidth + 8;
    }
    // A destination always starts at its beginning; the header and scene do not move.
    if (outlet.current) outlet.current.scrollTop = 0;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    for (const item of Object.values(buttons.current))
      if (item) observer.observe(item);
    return () => observer.disconnect();
  }, [selected]);

  function onKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const delta =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = sections[(index + delta + sections.length) % sections.length];
    selectSection(next.id);
    buttons.current[next.id]?.focus();
  }

  return (
    <section className="settings-page gnd-settings" data-testid="settings-page">
      <header className="gnd-settings-head">
        <h1 className="gnd-page-title">Settings</h1>
        <p className="gnd-muted">
          Check what Kompas can use on this computer, and set it up.
        </p>
      </header>
      {aiReady === false && (
        <OllamaNudge
          onSetUp={
            selected === 'local-ai'
              ? undefined
              : () => {
                  selectSection('local-ai');
                  buttons.current['local-ai']?.focus();
                }
          }
        />
      )}
      <nav aria-label="Settings sections" className="settings-nav-scroll">
        <div className="settings-nav" ref={strip}>
          <span
            aria-hidden="true"
            className={`settings-indicator${indicatorReady ? ' is-ready' : ''}`}
            data-testid="settings-indicator"
            style={{
              left: indicator.left,
              top: indicator.top,
              width: indicator.width,
              height: indicator.height,
              opacity: indicator.width ? 1 : 0,
            }}
          />
          {sections.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                buttons.current[item.id] = node;
              }}
              type="button"
              className="settings-pill"
              aria-current={selected === item.id ? 'page' : undefined}
              data-testid={`settings-nav-${item.id}`}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => selectSection(item.id)}
            >
              <item.icon size={17} strokeWidth={2} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      </nav>
      <div
        ref={outlet}
        className="gnd-settings-card settings-outlet"
        data-testid={`settings-view-${selected}`}
      >
        <div key={selected} className="settings-section-arrival">
          {selected === 'local-ai' ? (
            aiReady === false ? (
              <div className="gnd-settings-setup">
                <h2>Set up Ollama</h2>
                <p className="gnd-muted">
                  Kompas reads your CV and finds roles with a model that runs on
                  your computer, so nothing leaves it. It’s free.
                </p>
                <OllamaSetup
                  onReady={() => {
                    setAiReady(true);
                    setAiVersion((v) => v + 1);
                  }}
                />
              </div>
            ) : (
              <LocalAi key={aiVersion} />
            )
          ) : selected === 'audio' ? (
            <AudioSettings />
          ) : selected === 'browsers' ? (
            <BrowserSettings />
          ) : selected === 'system' ? (
            <SystemSettings
              onOpenLocalAi={() => {
                selectSection('local-ai');
                buttons.current['local-ai']?.focus();
              }}
            />
          ) : selected === 'diagnostics' ? (
            <DiagnosticsSettings />
          ) : (
            <StorageSettings />
          )}
        </div>
      </div>
    </section>
  );
}
