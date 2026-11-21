import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Database,
  FileText,
  HardDrive,
  PanelTop,
  RefreshCw,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';
import type { StorageUsage } from '../../../../shared/contracts';
import { ApiError, getStorageUsage, startStorageReset } from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { Disclosure } from '../../../presentation/components/Disclosure';
import './StorageSettings.css';

const categories = {
  database: { label: 'SQLite data', icon: Database, tone: 'lilac' },
  documents: { label: 'Documents', icon: FileText, tone: 'green' },
  audio: { label: 'Audio samples', icon: AudioLines, tone: 'peach' },
  logs: { label: 'Logs', icon: ScrollText, tone: 'lilac' },
  cache: { label: 'App cache', icon: HardDrive, tone: 'blue' },
  session: { label: 'App browser sessions', icon: PanelTop, tone: 'lilac' },
};
const categoryOrder = Object.keys(categories) as Array<keyof typeof categories>;
const phrase = 'DELETE ALL APPLICATION DATA';
function size(bytes: number | null): string {
  if (bytes === null) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 'KiB' : bytes < 1024 ** 3 ? 'MiB' : 'GiB';
  const divisor =
    unit === 'KiB' ? 1024 : unit === 'MiB' ? 1024 ** 2 : 1024 ** 3;
  return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

export function StorageSettings() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const returnFocus = useRef<HTMLButtonElement>(null);
  const cancelFocus = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setUsage(await getStorageUsage());
    } catch {
      setError(
        'Could not measure application storage. Check storage access and try again. If a previous reset was interrupted, restart the app to retry cleanup.',
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (confirming) cancelFocus.current?.focus();
  }, [confirming]);

  function close() {
    setConfirming(false);
    setTyped('');
    returnFocus.current?.focus();
  }
  async function reset() {
    if (typed !== phrase || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      await startStorageReset();
      setRestarting(true);
      setConfirming(false);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? `Reset was refused: ${failure.message}`
          : 'Reset was refused. Finish active work, check storage permissions and try again.',
      );
      close();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section
      className="settings-section storage-settings"
      data-testid="storage-settings"
    >
      <div className="storage-heading">
        <span className="storage-heading-icon">
          <Database size={23} aria-hidden="true" />
        </span>
        <div className="storage-heading-copy">
          <h2>Data &amp; Storage</h2>
          <p>
            See what the app stores locally and reset carefully when needed.
          </p>
        </div>
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw aria-hidden="true" />}
          data-testid="storage-refresh"
          disabled={loading || restarting}
          onClick={() => void refresh()}
        >
          Refresh usage
        </Button>
      </div>
      <Card padding="compact" className="storage-summary">
        <div className="storage-summary-reading" data-testid="storage-total">
          <span>Total app storage</span>
          <strong>
            {loading && !usage
              ? 'Measuring…'
              : !usage
                ? 'Unknown'
                : usage.partial
                  ? 'Partial'
                  : size(usage.totalBytes)}
          </strong>
        </div>
        <p>
          {loading
            ? 'Measuring app-owned files on this device…'
            : !usage
              ? 'Storage could not be measured. Try refreshing.'
              : usage.partial || usage.totalBytes === null
                ? 'Some locations could not be measured; no complete total is available.'
                : 'Known app-owned data on this device, not free disk space. Sizes may change.'}
        </p>
      </Card>
      {usage && !loading && (
        <div
          className="storage-grid"
          aria-label="Application storage categories"
        >
          {[...usage.categories]
            .sort(
              (a, b) =>
                categoryOrder.indexOf(a.category) -
                categoryOrder.indexOf(b.category),
            )
            .map(({ category, bytes }) => {
              const { label, icon: Icon, tone } = categories[category];
              return (
                <Card
                  key={category}
                  padding="compact"
                  className="storage-tile"
                  data-testid={`storage-category-${category}`}
                >
                  <span
                    className={`storage-tile-icon storage-tile-icon-${tone}`}
                  >
                    <Icon size={19} aria-hidden="true" />
                  </span>
                  <span className="storage-tile-copy">
                    <strong>{label}</strong>
                    <span className={bytes === null ? 'storage-unknown' : ''}>
                      {size(bytes)}
                    </span>
                  </span>
                </Card>
              );
            })}
        </div>
      )}
      {error && (
        <p role="alert" className="settings-error storage-error">
          {error} {usage && 'Previous measurements may be out of date.'}
        </p>
      )}
      <Card padding="compact" className="storage-danger">
        <span className="storage-danger-icon">
          <TriangleAlert size={22} aria-hidden="true" />
        </span>
        <div className="storage-danger-content">
          <h3>Reset workspace data</h3>
          <p>
            Delete locally stored app data and restart fresh. This cannot be
            undone.
          </p>
          <div className="storage-danger-actions">
            <button
              ref={returnFocus}
              type="button"
              className="storage-delete"
              data-testid="storage-open-reset"
              disabled={restarting}
              onClick={() => setConfirming(true)}
            >
              Reset data…
            </button>
            <Disclosure label="What will be cleared?" className="storage-scope">
              <p>
                Delete the local profile, all SQLite records (including
                interviews, applications, searches, settings and transcripts),
                managed document copies, recordings, logs and app-owned
                cache/session data.
              </p>
              <p>
                External Ollama models and settings, installed browsers and
                personal browser profiles, original imported files and bundled
                Whisper resources are not deleted.
              </p>
            </Disclosure>
          </div>
        </div>
      </Card>
      {restarting && (
        <p role="status" data-testid="storage-restarting">
          Reset requested. Restarting to verify a fresh store…
        </p>
      )}
      {confirming && (
        <div
          className="storage-dialog-backdrop"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !submitting) close();
            if (event.key === 'Tab') {
              const elements = [
                cancelFocus.current,
                document.getElementById('storage-confirm'),
                document.querySelector<HTMLButtonElement>(
                  '[data-testid="storage-confirm-reset"]',
                ),
              ].filter(
                (element): element is HTMLElement =>
                  element instanceof HTMLElement &&
                  !('disabled' in element && element.disabled),
              );
              const current = elements.indexOf(
                document.activeElement as HTMLElement,
              );
              if (
                (event.shiftKey && current === 0) ||
                (!event.shiftKey && current === elements.length - 1)
              ) {
                event.preventDefault();
                elements[event.shiftKey ? elements.length - 1 : 0]?.focus();
              }
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="storage-dialog-title"
            className="storage-dialog"
            data-testid="storage-reset-dialog"
          >
            <h3 id="storage-dialog-title">
              Permanently delete local application data?
            </h3>
            <p>
              This removes the profile, database, managed CV/document copies,
              recordings, logs and application-owned cache/session data. It does
              not remove original source files, external Ollama models,
              installed browsers or personal browser profiles.
            </p>
            <label htmlFor="storage-confirm">
              Type <strong>{phrase}</strong> to continue
            </label>
            <input
              id="storage-confirm"
              data-testid="storage-confirm-input"
              autoComplete="off"
              value={typed}
              disabled={submitting}
              onChange={(event) => setTyped(event.target.value)}
            />
            <div className="settings-row">
              <button
                ref={cancelFocus}
                type="button"
                className="settings-action secondary"
                disabled={submitting}
                onClick={close}
              >
                Cancel
              </button>
              <button
                type="button"
                className="storage-delete"
                data-testid="storage-confirm-reset"
                disabled={submitting || typed !== phrase}
                onClick={() => void reset()}
              >
                {submitting ? 'Preparing reset…' : 'Delete and restart'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
