import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import grass from '../../meadow/assets/grass-tuft-3-v1.png';
import whiteFlower from '../../meadow/assets/single-white-flower.png';
import './MethodChoice.css';

export type MethodChoiceOption<T extends string> = {
  value: T;
  label: string;
  description: string;
  detail: string;
  icon: LucideIcon;
};

/**
 * Interview method selector as native radios styled as cards, so arrow keys,
 * focus and form semantics follow the platform. Plain props only.
 */
export function MethodChoice<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  disabled = false,
  note,
}: {
  name: string;
  legend: string;
  options: readonly MethodChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  note?: string;
}) {
  const noteId = note ? `${name}-note` : undefined;

  return (
    <fieldset
      className="method-choice"
      disabled={disabled}
      aria-describedby={noteId}
    >
      <legend className="method-choice-legend">{legend}</legend>
      <div className="method-choice-options">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={`method-choice-card${checked ? ' is-selected' : ''}`}
              data-testid={`method-choice-${option.value}`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
              />
              <span className="method-choice-icon" aria-hidden="true">
                <option.icon size={22} strokeWidth={2} />
              </span>
              <span className="method-choice-copy">
                <strong>{option.label}</strong>
                <span>{option.description}</span>
                <small>{option.detail}</small>
              </span>
              <span className="method-choice-mark" aria-hidden="true">
                {checked && <Check size={14} strokeWidth={3} />}
              </span>
              <span className="method-choice-decor" aria-hidden="true">
                <img className="method-choice-grass" src={grass} alt="" />
                {checked && (
                  <img
                    className="method-choice-flower"
                    src={whiteFlower}
                    alt=""
                  />
                )}
              </span>
            </label>
          );
        })}
      </div>
      {note && (
        <p id={noteId} className="method-choice-note">
          {note}
        </p>
      )}
    </fieldset>
  );
}
