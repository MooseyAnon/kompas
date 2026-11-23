import React from 'react';
import { readTheme, switchTheme, THEMES } from './theme';
import './ThemeSwitch.css';

/** Settings › System: pick the interface (Meadow or GND). Reloads the app. */
export function ThemeSwitch() {
  const current = readTheme();
  return (
    <fieldset className="theme-switch" data-testid="theme-switch">
      <legend>Interface</legend>
      <div className="theme-switch-options" role="radiogroup">
        {THEMES.map((theme) => (
          <label key={theme.id} className="theme-switch-option">
            <input
              type="radio"
              name="kompas-theme"
              value={theme.id}
              checked={current === theme.id}
              onChange={() => switchTheme(theme.id)}
            />
            {theme.label}
          </label>
        ))}
      </div>
      <p className="theme-switch-help">
        Both use the same data. Switching reloads the window.
      </p>
    </fieldset>
  );
}
