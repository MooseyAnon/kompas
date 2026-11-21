import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Activity,
  Ban,
  ChevronRight,
  CircleCheck,
  CircleX,
  Database,
  ListChecks,
  RefreshCw,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type {
  InferenceOperationSummary,
  OperationRun,
} from '../../../../shared/contracts';
import {
  listInferenceDiagnostics,
  systemPing,
  telemetryRunsList,
} from '../../../api';
import { errorText } from '../shared';
import { Button } from '../../../presentation/components/Button';
import { Disclosure } from '../../../presentation/components/Disclosure';
import './DiagnosticsSettings.css';

const RUN_LIMIT = 50;
const INFERENCE_LIMIT = 20;

type Loadable<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: T[] };
type StorageStatus = 'checking' | 'ready' | 'unavailable' | 'unknown';
type Outcome = OperationRun['outcome'];
type SelectionKind = 'run' | 'inference';
type Selection = { kind: SelectionKind; id: string } | null;

// Both projections share the success/failure/cancelled vocabulary; there is no warning outcome.
const OUTCOMES: Record<Outcome, { label: string; icon: LucideIcon }> = {
  success: { label: 'Success', icon: CircleCheck },
  failure: { label: 'Failure', icon: CircleX },
  cancelled: { label: 'Cancelled', icon: Ban },
};

const STORAGE_LABELS: Record<StorageStatus, string> = {
  checking: 'Checking local storage…',
  ready: 'Local storage ready',
  unavailable: 'Local storage unavailable',
  unknown: 'Storage status unavailable',
};

function parseTime(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fullTime(value: string): string {
  return parseTime(value)?.toLocaleString() ?? 'Unknown time';
}

function shortDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'Not reported';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function exactDuration(ms: number | null): string {
  return ms === null ? 'Not reported' : `${ms.toLocaleString()} ms`;
}

function reported(value: string | number | null): string | number {
  return value ?? 'Not reported';
}

function averageDuration(items: OperationRun[]): number | null {
  const durations = items
    .map((item) => item.durationMs)
    .filter((value) => Number.isFinite(value));
  if (durations.length === 0) return null;
  return durations.reduce((sum, value) => sum + value, 0) / durations.length;
}

/** Lets identifiers like `saved_search.query_plan` wrap at separators instead of mid-word. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[._:/-])/);
  return (
    <>
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </React.Fragment>
      ))}
    </>
  );
}

function Timestamp({ value }: { value: string }) {
  const date = parseTime(value);
  if (!date) return <>Unknown time</>;
  // Minute precision keeps the column narrow; the inspector shows the full local time.
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })}
    </time>
  );
}

function OutcomePill({ outcome }: { outcome: Outcome }) {
  const { label, icon: Icon } = OUTCOMES[outcome];
  return (
    <span className={`diagnostics-outcome diagnostics-outcome-${outcome}`}>
      <Icon aria-hidden="true" />
      {label}
    </span>
  );
}

function InspectButton({
  label,
  selected,
  onInspect,
  testId,
}: {
  label: string;
  selected: boolean;
  onInspect: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="diagnostics-inspect"
      aria-label={label}
      aria-pressed={selected}
      title="Inspect"
      data-testid={testId}
      onClick={(event) => {
        event.stopPropagation();
        onInspect();
      }}
    >
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

function MetricStrip({ runs }: { runs: Loadable<OperationRun> }) {
  const items = runs.state === 'ready' ? runs.items : null;
  const count = (outcome: Outcome) =>
    items?.filter((item) => item.outcome === outcome).length;
  const average = items ? averageDuration(items) : null;
  const unavailable = runs.state === 'loading' ? 'Loading…' : 'Unavailable';
  const metrics = [
    {
      key: 'loaded',
      label: 'Operations loaded',
      value: items?.length,
      hint:
        average === null
          ? `Of up to ${RUN_LIMIT} recent`
          : `Avg ${shortDuration(average)} across loaded`,
      icon: ListChecks,
    },
    {
      key: 'success',
      label: 'Succeeded',
      value: count('success'),
      hint: 'In loaded records',
      icon: CircleCheck,
    },
    {
      key: 'failure',
      label: 'Failed',
      value: count('failure'),
      hint: 'In loaded records',
      icon: CircleX,
    },
    {
      key: 'cancelled',
      label: 'Cancelled',
      value: count('cancelled'),
      hint: 'In loaded records',
      icon: Ban,
    },
  ];

  return (
    <ul
      className="diagnostics-metrics"
      aria-label="Summary of loaded operations"
      aria-busy={runs.state === 'loading'}
      data-testid="diagnostics-metrics"
    >
      {metrics.map(({ key, label, value, hint, icon: Icon }) => (
        <li
          key={key}
          className={`diagnostics-metric diagnostics-metric-${key}`}
          data-testid={`diagnostics-metric-${key}`}
        >
          <span className="diagnostics-metric-icon">
            <Icon aria-hidden="true" />
          </span>
          <span className="diagnostics-metric-label">{label}</span>
          <strong className="diagnostics-metric-value">{value ?? '—'}</strong>
          <span className="diagnostics-metric-hint">
            {items ? hint : unavailable}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="diagnostics-facts">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function Identifier({ value }: { value: string }) {
  // Truncation is visual only; the full ID stays in the DOM and selects as one unit.
  return (
    <code className="diagnostics-id" title={value}>
      {value}
    </code>
  );
}

type DetailsProps = {
  run: OperationRun | null;
  inference: InferenceOperationSummary | null;
  hiddenByFilters: boolean;
  nothingRecorded: boolean;
};

const DetailsPanel = forwardRef<HTMLElement, DetailsProps>(
  function DetailsPanel(
    { run, inference, hiddenByFilters, nothingRecorded },
    ref,
  ) {
    const announcement = run
      ? `Showing details for ${run.operation}`
      : inference
        ? `Showing Local AI details for ${inference.operation}`
        : '';

    return (
      <section
        ref={ref}
        className="diagnostics-pane diagnostics-details"
        aria-labelledby="diagnostics-details-title"
        data-testid="diagnostics-details"
      >
        <header className="diagnostics-pane-header">
          <h3 id="diagnostics-details-title">Operation details</h3>
          {(run || inference) && (
            <span className="diagnostics-pane-meta">
              {run ? 'Recent operation' : 'Local AI'}
            </span>
          )}
        </header>
        <p className="diagnostics-sr-only" role="status">
          {announcement}
        </p>
        {run ? (
          <>
            <div className="diagnostics-details-title">
              <strong>{run.operation}</strong>
              <OutcomePill outcome={run.outcome} />
            </div>
            {hiddenByFilters && (
              <p
                className="diagnostics-note"
                data-testid="diagnostics-details-hidden"
              >
                This record is hidden by the current filters.
              </p>
            )}
            <Facts
              rows={[
                ['Module', run.moduleId],
                ['Started', fullTime(run.startedAt)],
                ['Finished', fullTime(run.finishedAt)],
                ['Duration', exactDuration(run.durationMs)],
                ['Error code', run.errorCode ?? 'None reported'],
                ['Run ID', <Identifier key="id" value={run.id} />],
              ]}
            />
          </>
        ) : inference ? (
          <>
            <div className="diagnostics-details-title">
              <strong>{inference.operation}</strong>
              <OutcomePill outcome={inference.status} />
            </div>
            <Facts
              rows={[
                ['Model', reported(inference.modelId)],
                ['Provider', reported(inference.providerId)],
                ['Started', fullTime(inference.startedAt)],
                ['Finished', fullTime(inference.finishedAt)],
                ['Duration', exactDuration(inference.durationMs)],
                ['First token', exactDuration(inference.firstTokenMs)],
                ['Input tokens', reported(inference.inputTokens)],
                ['Output tokens', reported(inference.outputTokens)],
                ['Tool calls', reported(inference.toolCalls)],
                ['Error code', inference.errorCode ?? 'None reported'],
                ['Operation ID', <Identifier key="id" value={inference.id} />],
              ]}
            />
            <p className="diagnostics-note">
              Token counts are provider-reported when present.
            </p>
          </>
        ) : (
          <p className="diagnostics-placeholder">
            {nothingRecorded
              ? 'No recorded operations to inspect yet.'
              : 'Select an operation to inspect.'}
          </p>
        )}
      </section>
    );
  },
);

export function DiagnosticsSettings() {
  const [runs, setRuns] = useState<Loadable<OperationRun>>({
    state: 'loading',
  });
  const [inference, setInference] = useState<
    Loadable<InferenceOperationSummary>
  >({ state: 'loading' });
  const [storage, setStorage] = useState<StorageStatus>('checking');
  const [outcome, setOutcome] = useState<'all' | Outcome>('all');
  const [module, setModule] = useState('all');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const sequence = useRef(0);
  const detailsRef = useRef<HTMLElement>(null);

  const refresh = useCallback(() => {
    const current = ++sequence.current;
    const isCurrent = () => sequence.current === current;
    // Keep a selection only if the refreshed list still contains that exact record.
    const pruneSelection = (kind: SelectionKind, ids: string[] | null) =>
      setSelection((previous) =>
        previous?.kind === kind && !ids?.includes(previous.id)
          ? null
          : previous,
      );

    setRuns({ state: 'loading' });
    setInference({ state: 'loading' });
    setStorage('checking');

    void telemetryRunsList(RUN_LIMIT).then(
      (items) => {
        if (!isCurrent()) return;
        setRuns({ state: 'ready', items });
        pruneSelection(
          'run',
          items.map((item) => item.id),
        );
      },
      (error) => {
        if (!isCurrent()) return;
        setRuns({
          state: 'error',
          message: errorText(error, 'Recent activity could not be loaded.'),
        });
        pruneSelection('run', null);
      },
    );
    void listInferenceDiagnostics(INFERENCE_LIMIT).then(
      (items) => {
        if (!isCurrent()) return;
        setInference({ state: 'ready', items });
        pruneSelection(
          'inference',
          items.map((item) => item.id),
        );
      },
      (error) => {
        if (!isCurrent()) return;
        setInference({
          state: 'error',
          message: errorText(error, 'Local AI activity could not be loaded.'),
        });
        pruneSelection('inference', null);
      },
    );
    void systemPing().then(
      (status) => {
        if (isCurrent())
          setStorage(status.storageReady ? 'ready' : 'unavailable');
      },
      () => {
        if (isCurrent()) setStorage('unknown');
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh]);

  const inspect = (kind: SelectionKind, id: string) => {
    setSelection({ kind, id });
    // On stacked layouts the inspector sits below the tables; bring it into view.
    requestAnimationFrame(() =>
      detailsRef.current?.scrollIntoView({ block: 'nearest' }),
    );
  };

  const loadedRuns = runs.state === 'ready' ? runs.items : [];
  const loadedInference = inference.state === 'ready' ? inference.items : [];
  const modules = [...new Set(loadedRuns.map((item) => item.moduleId))].sort();
  const activeModule = modules.includes(module) ? module : 'all';
  const query = search.trim().toLowerCase();
  const visibleRuns = loadedRuns.filter(
    (item) =>
      (outcome === 'all' || item.outcome === outcome) &&
      (activeModule === 'all' || item.moduleId === activeModule) &&
      (!query ||
        [item.operation, item.moduleId, item.errorCode ?? ''].some((field) =>
          field.toLowerCase().includes(query),
        )),
  );
  const clearFilters = () => {
    setOutcome('all');
    setModule('all');
    setSearch('');
  };

  const selectedRun =
    selection?.kind === 'run'
      ? (loadedRuns.find((item) => item.id === selection.id) ?? null)
      : null;
  const selectedInference =
    selection?.kind === 'inference'
      ? (loadedInference.find((item) => item.id === selection.id) ?? null)
      : null;
  const selectedRunHidden =
    selectedRun !== null &&
    !visibleRuns.some((item) => item.id === selectedRun.id);
  const nothingRecorded =
    runs.state === 'ready' &&
    inference.state === 'ready' &&
    loadedRuns.length === 0 &&
    loadedInference.length === 0;

  return (
    <section
      className="settings-section diagnostics-settings"
      aria-label="Diagnostics"
    >
      <header className="diagnostics-heading">
        <span className="diagnostics-heading-icon" aria-hidden="true">
          <Activity size={22} />
        </span>
        <div className="diagnostics-heading-copy">
          <h2>Diagnostics</h2>
          <p>Recent local operations and Local AI diagnostics.</p>
        </div>
        <div className="diagnostics-heading-actions">
          <span
            className={`diagnostics-storage diagnostics-storage-${storage}`}
            data-testid="diagnostics-storage"
          >
            <Database aria-hidden="true" />
            {STORAGE_LABELS[storage]}
          </span>
          <Button
            variant="secondary"
            leadingIcon={<RefreshCw aria-hidden="true" />}
            data-testid="diagnostics-refresh"
            onClick={refresh}
          >
            Refresh
          </Button>
        </div>
      </header>

      <MetricStrip runs={runs} />

      <div className="diagnostics-layout">
        <section
          className="diagnostics-pane diagnostics-runs-pane"
          aria-labelledby="diagnostics-runs-title"
        >
          <header className="diagnostics-pane-header">
            <h3 id="diagnostics-runs-title">Recent operations</h3>
            <span className="diagnostics-pane-meta">
              Showing up to {RUN_LIMIT} recent records
              {runs.state === 'ready' && ` · ${loadedRuns.length} loaded`}
            </span>
          </header>

          {runs.state === 'loading' && (
            <p role="status" className="diagnostics-placeholder">
              Loading recent operations…
            </p>
          )}
          {runs.state === 'error' && (
            <p role="alert" className="settings-error diagnostics-placeholder">
              {storage === 'unavailable'
                ? 'Diagnostics storage unavailable. '
                : ''}
              {runs.message} Try Refresh.
            </p>
          )}
          {runs.state === 'ready' && loadedRuns.length === 0 && (
            <p
              className="diagnostics-placeholder"
              data-testid="diagnostics-empty"
            >
              No operations have been recorded yet.
            </p>
          )}

          {runs.state === 'ready' && loadedRuns.length > 0 && (
            <>
              <div className="diagnostics-filters">
                <label>
                  <span>Outcome</span>
                  <select
                    data-testid="diagnostics-outcome"
                    value={outcome}
                    onChange={(event) =>
                      setOutcome(event.target.value as 'all' | Outcome)
                    }
                  >
                    <option value="all">All loaded outcomes</option>
                    <option value="success">Success</option>
                    <option value="failure">Failure</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <label>
                  <span>Module</span>
                  <select
                    data-testid="diagnostics-module"
                    value={activeModule}
                    onChange={(event) => setModule(event.target.value)}
                  >
                    <option value="all">All loaded modules</option>
                    {modules.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="diagnostics-search">
                  <span>Search loaded records</span>
                  <span className="diagnostics-search-field">
                    <Search aria-hidden="true" />
                    <input
                      type="search"
                      data-testid="diagnostics-search"
                      placeholder="Operation, module or code"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </span>
                </label>
              </div>

              {visibleRuns.length === 0 ? (
                <div
                  className="diagnostics-placeholder"
                  data-testid="diagnostics-filter-empty"
                >
                  <p>No matches in the loaded records.</p>
                  <button
                    type="button"
                    className="settings-text-action"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
                <div
                  className="diagnostics-table-scroll diagnostics-runs-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Recent operations table"
                >
                  <table
                    className="diagnostics-table"
                    data-testid="diagnostics-runs"
                  >
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">Module</th>
                        <th scope="col">Operation</th>
                        <th scope="col">Outcome</th>
                        <th scope="col" className="diagnostics-number">
                          Duration
                        </th>
                        <th scope="col">
                          <span className="diagnostics-sr-only">Inspect</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRuns.map((item) => {
                        const selected = selectedRun?.id === item.id;
                        return (
                          <tr
                            key={item.id}
                            className={selected ? 'is-selected' : undefined}
                            onClick={() => inspect('run', item.id)}
                          >
                            <td className="diagnostics-when">
                              <Timestamp value={item.startedAt} />
                            </td>
                            <td>
                              <span
                                className="diagnostics-module"
                                title={item.moduleId}
                              >
                                {item.moduleId}
                              </span>
                            </td>
                            <td className="diagnostics-operation">
                              <Breakable text={item.operation} />
                            </td>
                            <td>
                              <OutcomePill outcome={item.outcome} />
                              {item.errorCode && (
                                <span
                                  className="diagnostics-error-code"
                                  title={item.errorCode}
                                >
                                  {item.errorCode}
                                </span>
                              )}
                            </td>
                            <td className="diagnostics-number">
                              {shortDuration(item.durationMs)}
                            </td>
                            <td className="diagnostics-inspect-cell">
                              <InspectButton
                                label={`Inspect ${item.operation} (${item.moduleId})`}
                                selected={selected}
                                testId="diagnostics-inspect-run"
                                onInspect={() => inspect('run', item.id)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>

        <div className="diagnostics-side">
          <section
            className="diagnostics-pane diagnostics-ai-pane"
            aria-labelledby="diagnostics-ai-title"
          >
            <header className="diagnostics-pane-header">
              <h3 id="diagnostics-ai-title">Local AI activity</h3>
              <span className="diagnostics-pane-meta">
                Up to {INFERENCE_LIMIT} recent inference operations
              </span>
            </header>
            {inference.state === 'loading' && (
              <p role="status" className="diagnostics-placeholder">
                Loading Local AI activity…
              </p>
            )}
            {inference.state === 'error' && (
              <p
                role="alert"
                className="settings-error diagnostics-placeholder"
              >
                {inference.message} Try Refresh.
              </p>
            )}
            {inference.state === 'ready' && loadedInference.length === 0 && (
              <p
                className="diagnostics-placeholder"
                data-testid="diagnostics-ai-empty"
              >
                No Local AI operations recorded yet.
              </p>
            )}
            {inference.state === 'ready' && loadedInference.length > 0 && (
              <div
                className="diagnostics-table-scroll diagnostics-ai-scroll"
                tabIndex={0}
                role="region"
                aria-label="Local AI activity table"
              >
                <table
                  className="diagnostics-table"
                  data-testid="diagnostics-inference"
                >
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Operation / model</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="diagnostics-number">
                        Duration
                      </th>
                      <th scope="col">
                        <span className="diagnostics-sr-only">Inspect</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadedInference.map((item) => {
                      const selected = selectedInference?.id === item.id;
                      return (
                        <tr
                          key={item.id}
                          className={selected ? 'is-selected' : undefined}
                          onClick={() => inspect('inference', item.id)}
                        >
                          <td className="diagnostics-when">
                            <Timestamp value={item.startedAt} />
                          </td>
                          <td className="diagnostics-operation">
                            <Breakable text={item.operation} />
                            {item.modelId && (
                              <span
                                className="diagnostics-model"
                                title={item.modelId}
                              >
                                {item.modelId}
                              </span>
                            )}
                          </td>
                          <td>
                            <OutcomePill outcome={item.status} />
                          </td>
                          <td className="diagnostics-number">
                            {shortDuration(item.durationMs)}
                          </td>
                          <td className="diagnostics-inspect-cell">
                            <InspectButton
                              label={`Inspect Local AI ${item.operation}`}
                              selected={selected}
                              testId="diagnostics-inspect-inference"
                              onInspect={() => inspect('inference', item.id)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <DetailsPanel
            ref={detailsRef}
            run={selectedRun}
            inference={selectedInference}
            hiddenByFilters={selectedRunHidden}
            nothingRecorded={nothingRecorded}
          />
        </div>
      </div>

      <Disclosure className="diagnostics-about" label="About these records">
        <p>
          These are bounded recent summaries, not a complete log search or a
          trace timeline. Recent operations lists up to {RUN_LIMIT} records
          across modules; Local AI activity lists up to {INFERENCE_LIMIT}{' '}
          inference operations, which may also appear in the first list. Filters
          apply only to these loaded records, and the summary counts describe
          loaded records before filtering.
        </p>
        <p>
          A failure code identifies an outcome, not its root cause. The storage
          indicator reports only whether local storage is ready; it is not a
          health check of every service. No prompts, replies, documents or file
          paths appear here.
        </p>
      </Disclosure>
    </section>
  );
}
