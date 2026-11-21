import React, { useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import './PillTabs.css';

export type PillTab<Id extends string> = {
  id: Id;
  label: string;
  icon: LucideIcon;
};

/** Ids that let a caller label its panel and return focus to a tab. */
export function pillTabId(idPrefix: string, tab: string) {
  return `${idPrefix}-tab-${tab}`;
}
export function pillTabPanelId(idPrefix: string) {
  return `${idPrefix}-panel`;
}

/**
 * Icon pill tablist with the Settings-style sliding highlight. Arrow keys,
 * Home and End move focus and select (automatic activation); the caller
 * renders the single panel with `pillTabPanelId`.
 */
export function PillTabs<Id extends string>({
  tabs,
  selected,
  onSelect,
  label,
  idPrefix,
}: {
  tabs: readonly PillTab<Id>[];
  selected: Id;
  onSelect: (tab: Id) => void;
  label: string;
  idPrefix: string;
}) {
  const [indicator, setIndicator] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const [indicatorReady, setIndicatorReady] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<Id, HTMLButtonElement | null>>>({});

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

    // Keep the selected pill inside a horizontally scrolled narrow row.
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

    const observer = new ResizeObserver(measure);
    observer.observe(track);
    for (const item of Object.values<HTMLButtonElement | null | undefined>(
      buttons.current,
    ))
      if (item) observer.observe(item);
    return () => observer.disconnect();
  }, [selected]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.findIndex((tab) => tab.id === selected);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft')
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;

    event.preventDefault();
    const tab = tabs[next];
    onSelect(tab.id);
    buttons.current[tab.id]?.focus();
  }

  return (
    <div className="ui-pill-tabs-scroll">
      <div
        className="ui-pill-tabs"
        role="tablist"
        aria-label={label}
        ref={strip}
      >
        <span
          aria-hidden="true"
          className={`ui-pill-tabs-indicator${indicatorReady ? ' is-ready' : ''}`}
          data-testid={`${idPrefix}-indicator`}
          style={{
            left: indicator.left,
            top: indicator.top,
            width: indicator.width,
            height: indicator.height,
            opacity: indicator.width ? 1 : 0,
          }}
        />
        {tabs.map((tab) => {
          const active = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                buttons.current[tab.id] = node;
              }}
              id={pillTabId(idPrefix, tab.id)}
              type="button"
              role="tab"
              className="ui-pill-tab"
              aria-selected={active}
              aria-controls={active ? pillTabPanelId(idPrefix) : undefined}
              tabIndex={active ? 0 : -1}
              data-testid={`${idPrefix}-tab-${tab.id}`}
              onKeyDown={onKeyDown}
              onClick={() => onSelect(tab.id)}
            >
              <tab.icon size={18} strokeWidth={2} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
