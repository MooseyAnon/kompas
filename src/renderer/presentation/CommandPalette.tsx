import React, { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { destinations, type Destination } from '../app/destinations';
import './CommandPalette.css';

export function CommandSurface({
  active,
  onChoose,
  mode,
  shortcut,
}: {
  active: Destination;
  onChoose: (destination: Destination) => void;
  mode: 'embedded' | 'modal';
  shortcut: string;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(
    mode === 'embedded' ? 0 : destinations.findIndex(({ id }) => id === active),
  );
  const input = useRef<HTMLInputElement>(null);
  const results = destinations.filter(({ label }) =>
    label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const index = Math.min(selected, Math.max(0, results.length - 1));

  useEffect(() => {
    if (mode === 'modal') input.current?.focus();
  }, [mode]);

  const prefix = mode === 'modal' ? 'palette' : 'home-command';

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Tab' && mode === 'modal') {
      // Only the combobox is tabbable; options are selected with arrows/Enter.
      event.preventDefault();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) {
        setSelected(
          (current) =>
            (Math.min(current, results.length - 1) +
              (event.key === 'ArrowDown' ? 1 : results.length - 1)) %
            results.length,
        );
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (results[index]) onChoose(results[index].id);
    } else if (event.key === 'Escape') {
      if (mode === 'embedded' && query) {
        event.preventDefault();
        setQuery('');
        setSelected(0);
      }
    }
  }

  return (
    <div
      className={`palette palette-${mode}`}
      data-testid={mode === 'modal' ? 'destination-menu' : 'home-command-panel'}
      onKeyDown={onKeyDown}
    >
      <div className="palette-search">
        <Search size={20} strokeWidth={2} aria-hidden="true" />
        <input
          ref={input}
          role="combobox"
          aria-label={mode === 'modal' ? 'Search pages' : 'Search home pages'}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${prefix}-results`}
          aria-activedescendant={
            results.length ? `${prefix}-${results[index].id}` : undefined
          }
          value={query}
          placeholder={mode === 'modal' ? 'Go to a page…' : 'Search pages…'}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          data-testid={`${prefix}-search`}
        />
        <kbd>{mode === 'modal' ? 'esc' : shortcut}</kbd>
      </div>
      <div
        id={`${prefix}-results`}
        role="listbox"
        aria-label="Pages"
        className="palette-results"
      >
        {results.length ? (
          results.map(({ id, label, icon: Icon }, position) => (
            <div
              key={id}
              id={`${prefix}-${id}`}
              role="option"
              aria-selected={position === index}
              aria-current={active === id ? 'page' : undefined}
              className="palette-option"
              data-testid={
                mode === 'modal'
                  ? `destination-${id}`
                  : `home-command-destination-${id}`
              }
              onMouseEnter={() => setSelected(position)}
              onClick={() => onChoose(id)}
            >
              <span className="palette-option-label">
                <Icon size={20} strokeWidth={2} aria-hidden="true" />
                {label}
              </span>
              {active === id && (
                <span className="palette-current">
                  <span className="palette-current-label">Current</span>
                  <CornerDownLeft size={17} aria-hidden="true" />
                </span>
              )}
            </div>
          ))
        ) : (
          <p className="palette-empty">No matching pages.</p>
        )}
      </div>
      <p className="palette-hint">↑ ↓ to select · enter to open</p>
    </div>
  );
}

export function CommandPalette({
  active,
  onChoose,
  onClose,
  shortcut,
}: {
  active: Destination;
  onChoose: (destination: Destination) => void;
  onClose: () => void;
  shortcut: string;
}) {
  return (
    <div
      className="palette-layer"
      data-testid="palette-layer"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="palette-scrim" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Go to a page">
        <CommandSurface
          active={active}
          onChoose={onChoose}
          mode="modal"
          shortcut={shortcut}
        />
      </div>
    </div>
  );
}
