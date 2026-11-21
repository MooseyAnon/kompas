import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Ban,
  BookOpen,
  Check,
  CircleCheck,
  Globe2,
  Minus,
  Monitor,
  RefreshCw,
} from 'lucide-react';
import type {
  BrowserInfo,
  WebBrowsersListOutput,
} from '../../../../shared/contracts';
import { webListBrowsers } from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { Disclosure } from '../../../presentation/components/Disclosure';
import chrome from '../../../presentation/icons/brands/chrome.png';
import edge from '../../../presentation/icons/brands/edge.png';
import firefox from '../../../presentation/icons/brands/firefox.png';
import safari from '../../../presentation/icons/brands/safari.png';
import { MeadowCardCorner } from '../../../presentation/meadow/decorations/MeadowCardCorner';
import { errorText } from '../shared';
import './BrowserSettings.css';

const logos: Record<string, string> = {
  chrome,
  msedge: edge,
  edge,
  firefox,
  safari,
};

type Load = {
  state: 'loading' | 'error' | 'ready';
  data?: WebBrowsersListOutput;
  error?: string;
};

type Tone = 'good' | 'warning' | 'muted';

function BrowserFact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: Tone;
}) {
  const Icon = tone === 'good' ? Check : tone === 'warning' ? Ban : Minus;
  return (
    <div>
      <dt className="browser-sr-only">{label}</dt>
      <dd className={`browser-fact browser-fact-${tone}`}>
        <Icon size={14} aria-hidden="true" />
        {value}
      </dd>
    </div>
  );
}

function BrowserTile({
  item,
  selected,
}: {
  item: BrowserInfo;
  selected: boolean;
}) {
  const launch =
    item.launchVerified === true
      ? 'Verified'
      : item.launchVerified === false
        ? 'Failed'
        : 'Not checked';
  return (
    <Card
      variant="subtle"
      padding="compact"
      data-testid={`browser-${item.id}`}
      className={`browser-tile${selected ? ' browser-tile-selected' : ''}`}
    >
      {selected && (
        <span className="browser-selected-label">
          <CircleCheck size={14} aria-hidden="true" /> Selected
          <span className="browser-sr-only"> reader</span>
        </span>
      )}
      <span className="browser-logo-box">
        {logos[item.id] ? (
          <img src={logos[item.id]} alt="" />
        ) : (
          <Globe2 size={48} aria-hidden="true" />
        )}
      </span>
      <strong className="browser-tile-name">{item.displayName}</strong>
      <dl className="browser-facts">
        <BrowserFact
          label="Detected"
          value={item.detected ? 'Installed' : 'Not installed'}
          tone={item.detected ? 'good' : 'muted'}
        />
        <BrowserFact
          label="Reader supported"
          value={item.supported ? 'Supported' : 'Unsupported'}
          tone={item.supported ? (item.detected ? 'good' : 'muted') : 'warning'}
        />
        <BrowserFact
          label="Launch"
          value={`Launch ${launch.toLowerCase()}`}
          tone={
            item.launchVerified === true
              ? 'good'
              : item.launchVerified === false
                ? 'warning'
                : 'muted'
          }
        />
      </dl>
      {item.reason && <p className="browser-tile-reason">{item.reason}</p>}
    </Card>
  );
}

export function BrowserSettings() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const active = useRef(false);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++seq.current;
    setLoad({ state: 'loading' });
    try {
      const data = await webListBrowsers();
      if (active.current && current === seq.current)
        setLoad({ state: 'ready', data });
    } catch (error) {
      if (active.current && current === seq.current)
        setLoad({
          state: 'error',
          error: errorText(error, 'Browser detection failed.'),
        });
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      seq.current++;
    };
  }, [refresh]);

  const selected = load.data?.browsers.find(
    (item) => item.id === load.data?.selectedId,
  );
  const supported = load.data?.browsers.some(
    (item) => item.detected && item.supported,
  );
  const readerReady =
    selected?.detected &&
    selected.supported &&
    selected.launchVerified === true;
  return (
    <section
      className="settings-section browser-settings"
      aria-label="Browsers"
    >
      <div className="browser-heading">
        <span className="browser-heading-icon">
          <Globe2 aria-hidden="true" />
        </span>
        <div>
          <h2>Browsers</h2>
          <p>See the chosen reader and which browsers are available.</p>
        </div>
        <MeadowCardCorner variant="floral" />
      </div>
      <Card
        className="browser-panel"
        header={
          <h3>
            <Monitor size={19} aria-hidden="true" /> Installed browsers
          </h3>
        }
      >
        <p className="browser-panel-intro">
          Browsers reported on this device and their reader support.
        </p>
        {load.state === 'loading' && <p role="status">Checking browsers…</p>}
        {load.state === 'error' && (
          <p role="alert" className="settings-error">
            {load.error} Try Check again.
          </p>
        )}
        {load.data &&
          (load.data.browsers.length === 0 ? (
            <p>No browser entries were reported.</p>
          ) : (
            <ul className="browser-grid">
              {load.data.browsers.map((item) => (
                <li key={item.id}>
                  <BrowserTile
                    item={item}
                    selected={item.id === load.data?.selectedId}
                  />
                </li>
              ))}
            </ul>
          ))}
      </Card>
      <Card
        className="browser-panel browser-support"
        header={
          <h3>
            <BookOpen size={19} aria-hidden="true" /> Reader support
          </h3>
        }
      >
        <div className="browser-support-content">
          <div className="browser-support-summary">
            <p>
              Chrome and Edge can read pages when installed and launch-verified.
              Your default browser is unchanged.
            </p>
            {load.data && (
              <p
                data-testid="browser-selected"
                className="browser-reader-summary"
              >
                {selected
                  ? `Reader selection: ${selected.displayName}`
                  : 'No browser selected for reading.'}
              </p>
            )}
          </div>
          {load.data && (
            <div className="browser-support-checks" aria-label="Reader checks">
              <span
                className={
                  supported ? 'browser-check-good' : 'browser-check-warning'
                }
              >
                {supported ? (
                  <CircleCheck size={16} aria-hidden="true" />
                ) : (
                  <AlertCircle size={16} aria-hidden="true" />
                )}
                {supported
                  ? 'Supported reader detected'
                  : 'No supported reader detected'}
              </span>
              <span
                className={
                  readerReady ? 'browser-check-good' : 'browser-check-warning'
                }
              >
                {readerReady ? (
                  <CircleCheck size={16} aria-hidden="true" />
                ) : (
                  <AlertCircle size={16} aria-hidden="true" />
                )}
                {readerReady
                  ? 'Selected reader launch verified'
                  : selected?.launchVerified === false
                    ? 'Selected reader launch failed'
                    : 'Selected reader launch not verified'}
              </span>
            </div>
          )}
          <Button
            variant="secondary"
            leadingIcon={<RefreshCw aria-hidden="true" />}
            data-testid="browser-refresh"
            onClick={() => void refresh()}
            disabled={load.state === 'loading'}
          >
            Check again
          </Button>
          <MeadowCardCorner variant="subtle" />
        </div>
        {load.data && !supported && (
          <p className="browser-guidance-note">
            No supported Chrome or Edge detected. Install one to enable page
            reading.
          </p>
        )}
        {selected?.launchVerified === false && (
          <p className="browser-guidance-note">
            The selected reader failed its launch check. Check again after
            checking its installation.
          </p>
        )}
        <Disclosure
          label="Browser setup and reader details"
          className="browser-guidance"
        >
          <p>
            The reader is chosen automatically from installed Chrome or Edge. A
            detected browser may still fail its launch check. Firefox and Safari
            cannot be used for page reading here.
          </p>
          <p>
            Install{' '}
            <a
              href="https://www.google.com/chrome/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Chrome from its official site
            </a>{' '}
            or{' '}
            <a
              href="https://www.microsoft.com/edge"
              target="_blank"
              rel="noopener noreferrer"
            >
              Edge from its official site
            </a>
            , then Check again. No download starts from this screen.
          </p>
        </Disclosure>
      </Card>
    </section>
  );
}
