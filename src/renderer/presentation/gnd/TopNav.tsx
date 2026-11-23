import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import logo from './brand/gnd-logo@2x.png';
import {
  accountDestinations,
  destinations,
  primaryDestinations,
  type Destination,
} from './destinations';
import './TopNav.css';

const byId = (id: Destination) =>
  destinations.find((destination) => destination.id === id)!;

/**
 * GND top bar: logo, the three main pages as a pill switch, and the person's
 * name, which opens Profile, Your applications and Settings.
 */
export function TopNav({
  active,
  name,
  onNavigate,
  inert,
}: {
  active: Destination;
  name: string;
  onNavigate: (next: Destination) => void;
  inert?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Your applications opens the same page as Profile.
  const accountActive =
    active === 'applications' ||
    (accountDestinations as readonly string[]).includes(active);

  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function onPointer(event: PointerEvent) {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [menuOpen]);

  function choose(next: Destination) {
    setMenuOpen(false);
    onNavigate(next);
  }

  function onMenuKey(event: React.KeyboardEvent) {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      trigger.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : items.length - 1;
      items[(index + step) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setMenuOpen(false);
    }
  }

  return (
    <header className="gnd-topnav" inert={inert} data-testid="top-nav">
      <div className="gnd-topnav-drag" aria-hidden="true" />
      <button
        type="button"
        className="gnd-topnav-logo"
        aria-label="GND home"
        onClick={() => onNavigate('home')}
      >
        <img src={logo} alt="" draggable={false} />
      </button>

      <nav className="gnd-topnav-pills" aria-label="Main">
        {primaryDestinations.map((id) => {
          const { label, icon: Icon } = byId(id);
          return (
            <button
              key={id}
              type="button"
              className="gnd-topnav-pill"
              aria-current={active === id ? 'page' : undefined}
              data-testid={`nav-${id}`}
              onClick={() => onNavigate(id)}
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="gnd-topnav-account">
        <button
          ref={trigger}
          type="button"
          className={`gnd-topnav-name${accountActive ? ' is-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          data-testid="nav-account"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {name}
          <ChevronDown aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Account"
            className="gnd-topnav-menu"
            onKeyDown={onMenuKey}
          >
            {accountDestinations.map((id) => {
              const { label, icon: Icon } = byId(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-current={active === id ? 'page' : undefined}
                  data-testid={`nav-${id}`}
                  onClick={() => choose(id)}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </header>
  );
}
