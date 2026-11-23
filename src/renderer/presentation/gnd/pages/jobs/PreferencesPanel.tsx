import React, { useEffect, useId, useState } from 'react';
import { Check, ChevronDown, MapPin, Plus, X } from 'lucide-react';
import {
  SALARY_CURRENCIES,
  SALARY_MAXIMUM,
  type JobDiscoveryConfigurationV1,
  type SalaryCurrency,
} from '../../../../../shared/contracts';
import { knownPlace, suggestPlaces } from './places';
import { addEntry, LIST_LIMITS, type ListKey } from './searchFilterRules';
import {
  CONTRACT_OPTIONS,
  CURRENCY_SYMBOL,
  LEVEL_OPTIONS,
  SETUP_OPTIONS,
  preferencesOf,
  summaryChips,
  withoutChip,
  withPreferences,
  type Preferences,
} from './searchPreferences';
import type { SearchPreferences, Section } from './useSearchPreferences';
import './PreferencesPanel.css';

type Config = JobDiscoveryConfigurationV1;
const MAX_PLACES = 5;

/**
 * "Your preferences": a summary of every choice as removable chips, then a
 * collapsible section per preference. Used as the Search filters page and as
 * the panel beside the jobs list. Every change saves straight away.
 */
export function PreferencesPanel({
  prefs,
  variant,
}: {
  prefs: SearchPreferences;
  variant: 'page' | 'side';
}) {
  const { config, suggested, errors } = prefs;
  if (!config) return null;
  const intent = config.intent;
  const chosen = preferencesOf(intent);
  const set = (patch: Partial<Preferences>, section: Section) =>
    prefs.save({ ...config, intent: withPreferences(intent, patch) }, section);
  const open = variant === 'page';
  const chips = summaryChips(intent);
  const boards = config.sources.collectionProviders;

  return (
    <div className={`gnd-pref is-${variant}`}>
      <section className="gnd-pref-summary" aria-labelledby="gnd-pref-title">
        <h2 id="gnd-pref-title" className="gnd-pref-title">
          Your preferences
        </h2>
        {chips.length ? (
          <ul className="gnd-pref-chips">
            {chips.map((chip) => {
              const value = chip.key.split(':').slice(1).join(':');
              return (
                <li
                  key={chip.key}
                  className={`gnd-pref-chip${suggested.includes(value) ? ' is-suggested' : ''}`}
                >
                  {chip.label}
                  <button
                    type="button"
                    aria-label={`Remove ${chip.label}`}
                    onClick={() => {
                      const next = withoutChip(intent, chip.key);
                      if (!next.targetRoles.length) {
                        prefs.fail(
                          'roles',
                          'Keep at least one role. Add another before removing this one.',
                        );
                        return;
                      }
                      prefs.save(
                        { ...config, intent: next },
                        sectionOf(chip.key),
                      );
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="gnd-muted">
            Nothing set yet. Pick what you’re after below.
          </p>
        )}
      </section>

      <Fold
        title="Roles"
        count={intent.targetRoles.length}
        defaultOpen
        error={errors.roles}
      >
        <ChipList
          list="roles"
          add="Add role"
          placeholder="e.g. Staff Product Designer"
          items={intent.targetRoles}
          suggested={suggested}
          onChange={(list) => prefs.setIntent({ targetRoles: list }, 'roles')}
          minOne
        />
      </Fold>

      <Fold
        title="Location"
        count={chosen.locations.length}
        defaultOpen={open}
        error={errors.location}
      >
        <PlacePicker
          places={chosen.locations}
          suggested={suggested}
          onChange={(locations) => set({ locations }, 'location')}
        />
      </Fold>

      <Fold
        title="Work setup"
        count={chosen.setups.length}
        defaultOpen={open}
        error={errors.setup}
        hint="Pick none to see all."
      >
        <PickList
          label="Work setup"
          options={SETUP_OPTIONS}
          value={chosen.setups}
          onChange={(setups) => set({ setups }, 'setup')}
        />
      </Fold>

      <Fold
        title="Experience level"
        count={chosen.levels.length}
        defaultOpen={open}
        error={errors.level}
      >
        <PickList
          label="Experience level"
          options={LEVEL_OPTIONS.map((o) => ({ ...o, detail: o.years }))}
          value={chosen.levels}
          onChange={(levels) => set({ levels }, 'level')}
        />
      </Fold>

      <Fold
        title="Contract type"
        count={chosen.contracts.length}
        defaultOpen={open}
        error={errors.contract}
      >
        <PickList
          label="Contract type"
          options={CONTRACT_OPTIONS}
          value={chosen.contracts}
          onChange={(contracts) => set({ contracts }, 'contract')}
        />
      </Fold>

      <Fold
        title="Salary"
        count={
          (chosen.salary.minimum ? 1 : 0) +
          (chosen.salary.onlyWithSalary ? 1 : 0)
        }
        defaultOpen={open}
        error={errors.salary}
      >
        <SalaryField
          salary={chosen.salary}
          onChange={(salary) => set({ salary }, 'salary')}
          onProblem={(message) =>
            message ? prefs.fail('salary', message) : prefs.clear('salary')
          }
        />
      </Fold>

      <Fold
        title="Field and start year"
        count={(intent.field ? 1 : 0) + (intent.targetYear ? 1 : 0)}
        defaultOpen={false}
        error={errors.field}
      >
        <div className={variant === 'page' ? 'gnd-form-two' : 'gnd-pref-stack'}>
          <TextField
            id={`gnd-f-field-${variant}`}
            label="Field"
            placeholder="e.g. Fintech"
            value={intent.field ?? ''}
            onCommit={(value) =>
              prefs.setIntent({ field: value || null }, 'field')
            }
          />
          <TextField
            id={`gnd-f-year-${variant}`}
            label="Start year"
            placeholder="e.g. 2027"
            help="Useful for graduate schemes"
            inputMode="numeric"
            value={intent.targetYear ? String(intent.targetYear) : ''}
            onCommit={(value) => {
              if (!value) return prefs.setIntent({ targetYear: null }, 'field');
              const year = Number.parseInt(value, 10);
              if (!(year >= 2000 && year <= 2100)) {
                prefs.fail('field', 'Enter a year between 2000 and 2100.');
                return;
              }
              prefs.setIntent({ targetYear: year }, 'field');
            }}
          />
        </div>
      </Fold>

      <Fold
        title="Companies"
        count={intent.companies.length}
        defaultOpen={false}
        error={errors.companies}
        hint="Optional. Leave empty to see every company."
      >
        <ChipList
          list="companies"
          add="Add company"
          placeholder="e.g. Monzo"
          items={intent.companies}
          onChange={(list) => prefs.setIntent({ companies: list }, 'companies')}
        />
      </Fold>

      <Fold
        title="Keywords"
        count={intent.keywords.length}
        defaultOpen={false}
        error={errors.keywords}
        hint="Optional. Words the listing should mention."
      >
        <ChipList
          list="keywords"
          add="Add keyword"
          placeholder="e.g. research"
          items={intent.keywords}
          onChange={(list) => prefs.setIntent({ keywords: list }, 'keywords')}
        />
      </Fold>

      <Fold
        title="Job boards"
        count={boards.length}
        defaultOpen={false}
        error={errors.boards}
        hint="Keep at least one on."
      >
        <div className="gnd-pref-stack">
          {(['linkedin', 'indeed'] as const).map((board) => {
            const on = boards.includes(board);
            return (
              <label key={board} className="gnd-filters-check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    if (on && boards.length === 1) {
                      prefs.fail('boards', 'Keep at least one job board on.');
                      return;
                    }
                    prefs.save(
                      {
                        ...config,
                        sources: {
                          collectionProviders: on
                            ? boards.filter((b) => b !== board)
                            : [...boards, board],
                        },
                      },
                      'boards',
                    );
                  }}
                />
                <span className="gnd-filters-box" aria-hidden="true">
                  <Check />
                </span>
                {board === 'linkedin' ? 'LinkedIn' : 'Indeed'}
              </label>
            );
          })}
        </div>
      </Fold>
    </div>
  );
}

function sectionOf(key: string): Section {
  const kind = key.split(':')[0];
  const map: Record<string, Section> = {
    role: 'roles',
    location: 'location',
    setup: 'setup',
    level: 'level',
    contract: 'contract',
    salary: 'salary',
    'with-salary': 'salary',
    field: 'field',
    company: 'companies',
    keyword: 'keywords',
  };
  return map[kind] ?? 'roles';
}

/** A collapsible section. Opens itself when it has an error to show. */
function Fold({
  title,
  count,
  defaultOpen,
  error,
  hint,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const id = useId();
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  return (
    <section className={`gnd-pref-fold${open ? ' is-open' : ''}`}>
      <h3 className="gnd-pref-fold-h">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <span>{title}</span>
          {count > 0 && <span className="gnd-pref-count">{count}</span>}
          <ChevronDown aria-hidden="true" />
        </button>
      </h3>
      <div id={id} className="gnd-pref-fold-body" hidden={!open}>
        {hint && <p className="gnd-help">{hint}</p>}
        {children}
        {error && (
          <p className="gnd-form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/** Multi-select chips; picking none means any. */
function PickList<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; detail?: string }[];
  value: T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <div
      className={`gnd-pref-picks${options.some((o) => o.detail) ? ' is-rows' : ''}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const on = value.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className="gnd-pref-pick"
            aria-pressed={on}
            onClick={() =>
              onChange(
                on
                  ? value.filter((v) => v !== option.value)
                  : options
                      .map((o) => o.value)
                      .filter((v) => v === option.value || value.includes(v)),
              )
            }
          >
            {on && <Check aria-hidden="true" />}
            <span>{option.label}</span>
            {option.detail && (
              <span className="gnd-pref-pick-detail">{option.detail}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Location pills with suggestions as you type. No place twice. */
function PlacePicker({
  places,
  suggested,
  onChange,
}: {
  places: string[];
  suggested: string[];
  onChange: (next: string[]) => void;
}) {
  const [typed, setTyped] = useState('');
  const [active, setActive] = useState(0);
  const [problem, setProblem] = useState('');
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const inputId = useId();
  const options = suggestPlaces(typed, places);
  const showList = focused && typed.trim().length > 0 && options.length > 0;

  function pick(value: string) {
    const place = knownPlace(value) ?? value.replace(/\s+/gu, ' ').trim();
    if (!place) return;
    // "Lon" with London already picked means London, not a new place "Lon".
    const typedStart = place.toLowerCase();
    const startsPicked = places.find((p) =>
      p.toLowerCase().startsWith(typedStart),
    );
    if (!knownPlace(value) && startsPicked) {
      setProblem(`${startsPicked} is already in your locations.`);
      return;
    }
    const result = addEntry(places, place, MAX_PLACES);
    if (result.problem === 'duplicate') {
      setProblem(`${place} is already in your locations.`);
      return;
    }
    if (result.problem === 'full') {
      setProblem(
        `You can add up to ${MAX_PLACES} locations. Remove one first.`,
      );
      return;
    }
    setProblem('');
    setTyped('');
    setActive(0);
    onChange(result.list);
  }

  return (
    <div className="gnd-pref-places">
      {places.length > 0 && (
        <ul className="gnd-pref-chips">
          {places.map((place) => (
            <li
              key={place}
              className={`gnd-pref-chip${suggested.includes(place) ? ' is-suggested' : ''}`}
            >
              <MapPin aria-hidden="true" className="gnd-pref-chip-icon" />
              {place}
              <button
                type="button"
                aria-label={`Remove ${place}`}
                onClick={() => {
                  setProblem('');
                  onChange(places.filter((p) => p !== place));
                }}
              >
                <X aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="gnd-pref-combo">
        <label className="gnd-visually-hidden" htmlFor={inputId}>
          Add a location
        </label>
        <input
          id={inputId}
          className="gnd-input"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          placeholder={
            places.length
              ? 'Add another city or country'
              : 'Type a city, e.g. London'
          }
          value={typed}
          maxLength={200}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setTyped(e.target.value);
            setActive(0);
            setProblem('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && showList) {
              e.preventDefault();
              setActive((active + 1) % options.length);
            } else if (e.key === 'ArrowUp' && showList) {
              e.preventDefault();
              setActive((active - 1 + options.length) % options.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(showList ? options[active].value : typed);
            } else if (e.key === 'Escape') {
              setTyped('');
            }
          }}
        />
        {showList && (
          <ul id={listId} className="gnd-pref-options" role="listbox">
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option.value)}
              >
                <MapPin aria-hidden="true" />
                <span>{option.value}</span>
                <span className="gnd-pref-option-detail">{option.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {problem && (
        <p className="gnd-form-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** Minimum yearly salary, its currency, and whether to hide unpaid listings. */
function SalaryField({
  salary,
  onChange,
  onProblem,
}: {
  salary: Preferences['salary'];
  onChange: (next: Preferences['salary']) => void;
  onProblem: (message: string) => void;
}) {
  const shown = salary.minimum ? salary.minimum.toLocaleString('en-GB') : '';
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const id = useId();

  function commit() {
    const text = draft
      .trim()
      .toLowerCase()
      .replace(/[£€$,\s]/gu, '');
    if (!text) {
      onProblem('');
      if (salary.minimum !== null) onChange({ ...salary, minimum: null });
      return;
    }
    const match = /^(\d+(?:\.\d+)?)(k)?$/u.exec(text);
    if (!match) {
      onProblem('Enter an amount, like 45000 or 45k.');
      return;
    }
    const amount = Math.round(Number(match[1]) * (match[2] ? 1000 : 1));
    if (amount > SALARY_MAXIMUM) {
      onProblem('That’s more than we can filter by. Try a lower amount.');
      return;
    }
    onProblem('');
    if (amount !== salary.minimum)
      onChange({ ...salary, minimum: amount || null });
  }

  return (
    <div className="gnd-pref-salary">
      <label className="gnd-label" htmlFor={id}>
        Minimum yearly salary
      </label>
      <div className="gnd-pref-salary-row">
        <span className="gnd-pref-currency">
          <select
            className="gnd-input"
            aria-label="Currency"
            value={salary.currency}
            onChange={(e) =>
              onChange({
                ...salary,
                currency: e.target.value as SalaryCurrency,
              })
            }
          >
            {SALARY_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {CURRENCY_SYMBOL[c]} {c}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </span>
        <input
          id={id}
          className="gnd-input"
          inputMode="numeric"
          placeholder="e.g. 45,000"
          value={draft}
          maxLength={12}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
      </div>
      <label className="gnd-filters-check gnd-pref-check">
        <input
          type="checkbox"
          checked={salary.onlyWithSalary}
          onChange={() =>
            onChange({ ...salary, onlyWithSalary: !salary.onlyWithSalary })
          }
        />
        <span className="gnd-filters-box" aria-hidden="true">
          <Check />
        </span>
        Only show jobs with salary
      </label>
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onCommit,
  placeholder,
  help,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  help?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next.slice(0, 200));
  };
  return (
    <div className="gnd-form-field">
      <label className="gnd-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="gnd-input"
        value={draft}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {help && <span className="gnd-help">{help}</span>}
    </div>
  );
}

/** Typed entries as chips, with an Add button that opens an input beside them. */
function ChipList({
  list: listKey,
  add,
  placeholder,
  items,
  suggested = [],
  onChange,
  minOne,
}: {
  list: ListKey;
  add: string;
  placeholder: string;
  items: string[];
  suggested?: string[];
  onChange: (list: string[]) => void;
  minOne?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const max = LIST_LIMITS[listKey];
  const inputId = useId();

  function confirm() {
    const result = addEntry(items, draft, max);
    if (result.problem === 'full') {
      setProblem(`You can add up to ${max}. Remove one first.`);
      return;
    }
    if (result.problem === 'duplicate') {
      setProblem(`${draft.trim()} is already added.`);
      return;
    }
    if (!result.problem) onChange(result.list);
    setDraft('');
    setOpen(false);
    setProblem('');
  }

  return (
    <>
      <div className="gnd-filter-chips">
        {items.map((item) => (
          <span
            key={item}
            className={`gnd-chip${suggested.includes(item) ? ' is-suggested' : ''}`}
          >
            {item}
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => {
                if (minOne && items.length === 1) {
                  setProblem(
                    'Keep at least one role. Add another before removing this one.',
                  );
                  return;
                }
                setProblem('');
                onChange(items.filter((x) => x !== item));
              }}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        ))}
        {open ? (
          <span className="gnd-chip-adding">
            <label className="gnd-visually-hidden" htmlFor={inputId}>
              {add}
            </label>
            <input
              id={inputId}
              className="gnd-input"
              value={draft}
              maxLength={200}
              placeholder={placeholder}
              autoFocus
              onChange={(e) => {
                setDraft(e.target.value);
                setProblem('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirm();
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setOpen(false);
                  setDraft('');
                }
              }}
            />
            <button
              type="button"
              className="gnd-chip-confirm"
              onClick={confirm}
            >
              Add
            </button>
            <button
              type="button"
              className="gnd-chip-cancel"
              aria-label="Cancel"
              onClick={() => {
                setOpen(false);
                setDraft('');
                setProblem('');
              }}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="gnd-chip-add"
            onClick={() => setOpen(true)}
          >
            <Plus aria-hidden="true" /> {add}
          </button>
        )}
      </div>
      {problem && (
        <p className="gnd-form-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

export type { Config };
