import React, { useLayoutEffect, useRef, useState } from 'react';
import { Activity, Bot, Database, Globe2, Mic, Monitor } from 'lucide-react';
import type { HardwareProfile } from '../../../shared/contracts';
import { Card, CardButton } from '../../presentation/components/Card';
import { MeadowCardCorner } from '../../presentation/meadow/decorations/MeadowCardCorner';
import { LocalAi } from './local-ai/LocalAi';
import { AudioSettings } from './audio/AudioSettings';
import { BrowserSettings } from './browsers/BrowserSettings';
import { SystemSettings } from './system/SystemSettings';
import { DiagnosticsSettings } from './diagnostics/DiagnosticsSettings';
import { StorageSettings } from './storage/StorageSettings';
import './SettingsPage.css';

const sections = [
  { id: 'local-ai', label: 'Local AI', icon: Bot },
  { id: 'audio', label: 'Audio', icon: Mic },
  { id: 'browsers', label: 'Browsers', icon: Globe2 },
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity },
  { id: 'storage', label: 'Data & Storage', icon: Database },
] as const;
type Section = (typeof sections)[number]['id'];

const supporting = [
  { id: 'browsers', description: 'Open to check installed browsers.' },
  { id: 'system', description: 'Device capacity snapshot.' },
  { id: 'diagnostics', description: 'Open to review recent activity.' },
  { id: 'local-ai', description: 'Open to check the local model.' },
] as const;

export function SettingsPage() {
  const [selected, setSelected] = useState<Section>('local-ai');
  const selectSection = (next: Section) => setSelected(next);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
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
    <section className="settings-page" data-testid="settings-page">
      <header className="settings-intro">
        <span className="settings-eyebrow">YOUR WORKSPACE</span>
        <h1>Settings</h1>
        <p>
          Personalize your workspace and check what’s available on this device.
        </p>
      </header>
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
              <item.icon size={18} strokeWidth={2} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="settings-workspace">
        <Card
          className={`settings-main-card${selected === 'local-ai' ? ' settings-main-card-ai' : selected === 'audio' ? ' settings-main-card-audio' : selected === 'browsers' ? ' settings-main-card-browsers' : selected === 'system' ? ' settings-main-card-system' : selected === 'diagnostics' ? ' settings-main-card-diagnostics' : selected === 'storage' ? ' settings-main-card-storage' : ''}`}
          padding="regular"
        >
          <div
            ref={outlet}
            className="settings-outlet"
            data-testid={`settings-view-${selected}`}
          >
            <div key={selected} className="settings-section-arrival">
              {selected === 'local-ai' ? (
                <LocalAi onHardware={setHardware} />
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
        </Card>
        <aside
          className={`settings-support${selected === 'local-ai' ? ' settings-support-ai' : selected === 'audio' ? ' settings-support-audio' : ''}`}
          aria-label="Other Settings sections"
        >
          {supporting
            .filter((item) => item.id !== selected)
            .map((item) => {
              const section = sections.find((entry) => entry.id === item.id)!;
              return (
                <CardButton
                  key={item.id}
                  className={`settings-support-card${item.id === 'system' || item.id === 'diagnostics' ? ' settings-support-decorated' : ''}`}
                  data-testid={`settings-support-${item.id}`}
                  onClick={() => {
                    selectSection(item.id);
                    buttons.current[item.id]?.focus();
                  }}
                >
                  <span className="settings-support-heading">
                    <section.icon size={19} aria-hidden="true" />
                    <strong>{section.label}</strong>
                  </span>
                  <span className="settings-support-description">
                    {item.id === 'system' && hardware
                      ? `${hardware.platform} · ${hardware.architecture} · ${(hardware.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB RAM`
                      : item.description}
                  </span>
                  {item.id === 'system' || item.id === 'diagnostics' ? (
                    <MeadowCardCorner
                      variant={item.id === 'system' ? 'subtle' : 'floral'}
                    />
                  ) : null}
                </CardButton>
              );
            })}
        </aside>
      </div>
    </section>
  );
}
