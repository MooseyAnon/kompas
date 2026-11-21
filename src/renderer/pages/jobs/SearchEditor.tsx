import React, { useEffect, useRef } from 'react';
import { ArrowLeft, Eye, Play, Save } from 'lucide-react';
import {
  JOB_DISCOVERY_LIMITS,
  type JobDiscoveryConfigurationV1,
} from '../../../shared/contracts/job-discovery';
import { Button } from '../../presentation/components/Button';
import { Disclosure } from '../../presentation/components/Disclosure';
import type { SearchForm } from './searchForm';

const budgets: {
  label: string;
  group: 'query' | 'run';
  key: string;
  min: number;
  max: number;
}[] = [
  {
    label: 'Queries',
    group: 'query',
    key: 'maxQueries',
    min: 1,
    max: JOB_DISCOVERY_LIMITS.maxQueries,
  },
  ...(
    [
      ['maxNewCandidates', 'New candidates', 1],
      ['maxInspectedCandidates', 'Inspected candidates', 1],
      ['maxCollectionPages', 'Collection pages', 0],
      ['maxTargetedSearchesPerCandidate', 'Targeted searches per candidate', 0],
      ['maxPagesPerTargetedSearch', 'Pages per targeted search', 0],
      ['maxConcurrentWebOperations', 'Concurrent web operations', 1],
      ['maxConcurrentExtractions', 'Concurrent extractions', 1],
      ['maxTransientRetries', 'Transient retries', 0],
      ['deadlineMs', 'Run deadline (ms)', 1],
    ] as const
  ).map(([key, label, min]) => ({
    label,
    group: 'run' as const,
    key,
    min,
    max: JOB_DISCOVERY_LIMITS[key],
  })),
];

export function SearchEditor({
  form,
  savedId,
  errors,
  notice,
  busy,
  activeRunId,
  preview,
  onChange,
  onBack,
  autoFocus = true,
  onSave,
  onPreview,
  onStart,
  onViewActiveRun,
}: {
  form: SearchForm;
  savedId: string | null;
  errors: Record<string, string>;
  notice: string | null;
  busy: boolean;
  activeRunId: string | null;
  preview: string[] | null;
  onChange: (form: SearchForm) => void;
  /** Omitted while the pane shows the default blank form. */
  onBack?: () => void;
  autoFocus?: boolean;
  onSave: () => void;
  onPreview: () => void;
  onStart: () => void;
  onViewActiveRun: () => void;
}) {
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) name.current?.focus();
  }, [savedId, autoFocus]);
  function setIntent<K extends keyof JobDiscoveryConfigurationV1['intent']>(
    key: K,
    value: JobDiscoveryConfigurationV1['intent'][K],
  ) {
    onChange({
      ...form,
      config: {
        ...form.config,
        intent: { ...form.config.intent, [key]: value },
      },
    });
  }
  function input(
    label: string,
    key: 'name' | 'roles' | 'year' | 'companies' | 'keywords',
    multiline = false,
  ) {
    const value = key === 'name' ? form.config.name : form[key];
    const path =
      key === 'name'
        ? 'name'
        : key === 'roles'
          ? 'intent.targetRoles'
          : key === 'year'
            ? 'intent.targetYear'
            : `intent.${key}`;
    const props = {
      id: `jobs-${key}`,
      value,
      'aria-invalid': !!errors[path],
      'aria-describedby': errors[path] ? `jobs-error-${key}` : undefined,
      onChange: (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) =>
        onChange(
          key === 'name'
            ? { ...form, config: { ...form.config, name: event.target.value } }
            : { ...form, [key]: event.target.value },
        ),
    };
    return (
      <label className="jobs-field" htmlFor={`jobs-${key}`} key={key}>
        <span>{label}</span>
        {multiline ? (
          <textarea {...props} rows={key === 'roles' ? 3 : 2} />
        ) : (
          <input {...props} type={key === 'year' ? 'number' : 'text'} />
        )}
        {errors[path] && (
          <small id={`jobs-error-${key}`} className="jobs-error">
            {errors[path]}
          </small>
        )}
      </label>
    );
  }
  function optional(label: string, key: 'field' | 'seniority' | 'location') {
    const path = `intent.${key}`;
    return (
      <label className="jobs-field" htmlFor={`jobs-${key}`} key={key}>
        <span>{label}</span>
        <input
          id={`jobs-${key}`}
          value={form.config.intent[key] ?? ''}
          aria-invalid={!!errors[path]}
          onChange={(event) => setIntent(key, event.target.value || null)}
        />
        {errors[path] && <small className="jobs-error">{errors[path]}</small>}
      </label>
    );
  }

  return (
    <div className="jobs-editor" data-testid="jobs-editor">
      {onBack && (
        <Button
          variant="ghost"
          leadingIcon={<ArrowLeft size={17} />}
          onClick={onBack}
          disabled={busy}
        >
          Back to saved searches
        </Button>
      )}
      <h2>{savedId ? 'Edit search' : 'Create a search'}</h2>
      <p>
        {savedId ? 'Update this' : 'Set up a new'} job discovery search. One
        role, company or keyword per line.
      </p>
      {activeRunId && onBack && (
        <div className="jobs-active">
          <span>A discovery is already running.</span>
          <Button variant="secondary" onClick={onViewActiveRun}>
            View active run
          </Button>
        </div>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="jobs-form-grid">
          {input('Search name · 120 characters', 'name')}
          {input('Target roles · 1–5, in order', 'roles', true)}
          {optional('Location · optional', 'location')}
          {optional('Field · optional', 'field')}
          {optional('Seniority · optional', 'seniority')}
          {input('Target year · optional, 2000–2100', 'year')}
          {input('Companies · up to 10', 'companies', true)}
          {input('Keywords · up to 10', 'keywords', true)}
        </div>
        <fieldset className="jobs-sources">
          <legend>Sources · choose at least one</legend>
          {(['linkedin', 'indeed'] as const).map((provider) => (
            <label key={provider}>
              <input
                type="checkbox"
                checked={form.config.sources.collectionProviders.includes(
                  provider,
                )}
                onChange={(event) =>
                  onChange({
                    ...form,
                    config: {
                      ...form.config,
                      sources: {
                        collectionProviders: event.target.checked
                          ? [
                              ...form.config.sources.collectionProviders,
                              provider,
                            ]
                          : form.config.sources.collectionProviders.filter(
                              (name) => name !== provider,
                            ),
                      },
                    },
                  })
                }
              />
              {provider === 'linkedin' ? 'LinkedIn' : 'Indeed'}
            </label>
          ))}
          {errors['sources.collectionProviders'] && (
            <small className="jobs-error">
              {errors['sources.collectionProviders']}
            </small>
          )}
        </fieldset>
        <label className="jobs-check">
          <input
            type="checkbox"
            checked={form.config.active}
            onChange={(event) =>
              onChange({
                ...form,
                config: { ...form.config, active: event.target.checked },
              })
            }
          />{' '}
          Active (required to preview or run)
        </label>
        <Disclosure label="Advanced run limits" className="jobs-advanced">
          <p>
            These are maximum budgets, not guaranteed results. Zero skips
            optional work where supported.
          </p>
          <div className="jobs-form-grid">
            {budgets.map(({ label, group, key, min, max }) => {
              const value =
                group === 'query'
                  ? form.config.query.maxQueries
                  : form.config.run[
                      key as keyof JobDiscoveryConfigurationV1['run']
                    ];
              const path = `${group}.${key}`;
              return (
                <label
                  className="jobs-field"
                  htmlFor={`jobs-budget-${key}`}
                  key={key}
                >
                  <span>
                    {label} · {min}–{max}
                  </span>
                  <input
                    id={`jobs-budget-${key}`}
                    type="number"
                    min={min}
                    max={max}
                    step="1"
                    value={Number.isNaN(value) ? '' : value}
                    aria-invalid={!!errors[path]}
                    onChange={(event) => {
                      const number =
                        event.target.value === ''
                          ? NaN
                          : Number(event.target.value);
                      onChange({
                        ...form,
                        config:
                          group === 'query'
                            ? {
                                ...form.config,
                                query: {
                                  ...form.config.query,
                                  maxQueries: number,
                                },
                              }
                            : {
                                ...form.config,
                                run: { ...form.config.run, [key]: number },
                              },
                      });
                    }}
                  />
                  {errors[path] && (
                    <small className="jobs-error">{errors[path]}</small>
                  )}
                </label>
              );
            })}
          </div>
        </Disclosure>
        {notice && (
          <p className="jobs-feedback" role="status">
            {notice}
          </p>
        )}
        {preview && (
          <div className="jobs-preview">
            <h3>Saved query plan</h3>
            <ol>
              {preview.map((query, index) => (
                <li key={index}>{query}</li>
              ))}
            </ol>
          </div>
        )}
        <div className="jobs-actions">
          <Button
            type="button"
            variant="secondary"
            leadingIcon={<Eye size={17} />}
            disabled={busy || !savedId || !form.config.active}
            onClick={onPreview}
          >
            Preview saved queries
          </Button>
          <Button
            type="submit"
            variant="secondary"
            leadingIcon={<Save size={17} />}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Save search'}
          </Button>
          <Button
            type="button"
            leadingIcon={<Play size={17} />}
            onClick={onStart}
            disabled={busy || !!activeRunId}
          >
            Start discovery
          </Button>
        </div>
        {!savedId && (
          <p className="jobs-hint">
            Save this search to enable a query preview.
          </p>
        )}
      </form>
    </div>
  );
}
