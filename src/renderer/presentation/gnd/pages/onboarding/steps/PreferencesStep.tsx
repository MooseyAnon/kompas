import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { WorkArrangement } from '../../../../../../shared/contracts';
import { Button } from '../../../../components/Button';
import { StepHeading } from '../OnboardingFrame';
import { WORK_ARRANGEMENT_OPTIONS } from '../onboardingPlan';

export function PreferencesStep({
  location,
  arrangement,
  onLocation,
  onArrangement,
  onNext,
  busy = false,
  error = '',
}: {
  busy?: boolean;
  error?: string;
  location: string;
  arrangement: WorkArrangement;
  onLocation: (value: string) => void;
  onArrangement: (value: WorkArrangement) => void;
  onNext: () => void;
}) {
  return (
    <form
      className="gnd-stack gnd-preferences"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <StepHeading
        title="Any preference"
        lead={<p>Help us find roles that suit you</p>}
      />
      <div className="gnd-fields">
        <div className="gnd-field">
          <label className="gnd-label" htmlFor="gnd-location">
            Location
          </label>
          <input
            id="gnd-location"
            className="gnd-input"
            placeholder="City, region or country"
            maxLength={200}
            value={location}
            onChange={(event) => onLocation(event.target.value)}
          />
        </div>
        <div className="gnd-field">
          <label className="gnd-label" htmlFor="gnd-arrangement">
            Work arrangement
          </label>
          <div className="gnd-select">
            <select
              id="gnd-arrangement"
              className="gnd-input"
              value={arrangement}
              onChange={(event) =>
                onArrangement(event.target.value as WorkArrangement)
              }
            >
              {WORK_ARRANGEMENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </div>
        </div>
      </div>
      {error && (
        <p className="gnd-message" role="alert">
          {error}
        </p>
      )}
      <Button size="hero" type="submit" disabled={busy}>
        Find roles
      </Button>
    </form>
  );
}
