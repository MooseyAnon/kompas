import React, { useState } from 'react';
import { readTheme, switchTheme, THEMES } from './theme';
import { readMotion, saveMotion, type MotionPreference } from './motion';
import './ThemeSwitch.css';

const MOTION: { id: MotionPreference; label: string }[] = [
  { id: 'on', label: 'On' },
  { id: 'system', label: 'Follow my computer' },
];

/** Settings › System: pick the interface (Kompas or Meadow) and animations. */
export function ThemeSwitch() {
  const current = readTheme();
  const [motion, setMotion] = useState(readMotion);
  return (
    <>
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
      <fieldset className="theme-switch" data-testid="motion-switch">
        <legend>Animations</legend>
        <div className="theme-switch-options" role="radiogroup">
          {MOTION.map((option) => (
            <label key={option.id} className="theme-switch-option">
              <input
                type="radio"
                name="kompas-motion"
                value={option.id}
                checked={motion === option.id}
                onChange={() => {
                  saveMotion(option.id);
                  setMotion(option.id);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
        <p className="theme-switch-help">
          “Follow my computer” turns animations off when Reduce Motion is on.
        </p>
      </fieldset>
    </>
  );
}
