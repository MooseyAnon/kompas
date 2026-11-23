import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../../../components/Button';
import { StepHeading } from '../OnboardingFrame';
import { MAX_ROLES, addRole } from '../onboardingPlan';

/**
 * Role chips: suggestions from the CV start selected; a chip toggles, and
 * typed roles are added as selected chips. At most five go into the search.
 */
export function RolesStep({
  suggested,
  roles,
  onChange,
  onNext,
}: {
  suggested: string[];
  roles: string[];
  onChange: (roles: string[]) => void;
  onNext: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [extra, setExtra] = useState<string[]>(() =>
    roles.filter((role) => !suggested.includes(role)),
  );
  const chips = [...suggested, ...extra];
  const full = roles.length >= MAX_ROLES;

  function toggle(role: string) {
    if (roles.includes(role)) onChange(roles.filter((item) => item !== role));
    else if (!full) onChange([...roles, role]);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = addRole(roles, typed);
    if (next !== roles) {
      const added = next[next.length - 1];
      if (!chips.some((chip) => chip.toLowerCase() === added.toLowerCase()))
        setExtra([...extra, added]);
      onChange(next);
    }
    setTyped('');
  }

  return (
    <div className="gnd-stack gnd-roles">
      <StepHeading
        title="Your next role"
        lead={<p>Help us find roles that suit you</p>}
      />
      <form className="gnd-field gnd-field-wide" onSubmit={submit}>
        <label className="gnd-visually-hidden" htmlFor="gnd-role-search">
          Add a role
        </label>
        <input
          id="gnd-role-search"
          className="gnd-input"
          placeholder={
            full
              ? 'You’ve picked five roles'
              : 'Search more roles that we missed'
          }
          value={typed}
          disabled={full}
          maxLength={200}
          onChange={(event) => setTyped(event.target.value)}
        />
      </form>

      {chips.length > 0 && (
        <div className="gnd-stack gnd-stack-tight">
          <p className="gnd-lead">
            {suggested.length
              ? 'Roles we found for you based on your CV'
              : 'Roles you’ve added'}
          </p>
          <ul className="gnd-chips" aria-label="Roles">
            {chips.map((role) => {
              const selected = roles.includes(role);
              return (
                <li key={role}>
                  <button
                    type="button"
                    className="gnd-chip"
                    aria-pressed={selected}
                    disabled={!selected && full}
                    onClick={() => toggle(role)}
                  >
                    {role}
                    {selected && <X aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Button size="hero" disabled={!roles.length} onClick={onNext}>
        That’s my direction
      </Button>
    </div>
  );
}
