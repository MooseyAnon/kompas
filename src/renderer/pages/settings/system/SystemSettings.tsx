import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Cpu,
  Layers,
  MemoryStick,
  Monitor,
  RefreshCw,
  Server,
} from 'lucide-react';
import type { HardwareProfile } from '../../../../shared/contracts';
import { getInferenceHardware, systemPing } from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { Disclosure } from '../../../presentation/components/Disclosure';
import { ThemeSwitch } from '../../../presentation/ThemeSwitch';
import { errorText } from '../shared';
import './SystemSettings.css';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; hardware: HardwareProfile; appVersion: string | null };

function capacity(bytes: number | null): string {
  if (bytes === null) return 'Not reported';
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function SystemSettings({
  onOpenLocalAi,
}: {
  onOpenLocalAi: () => void;
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    setLoad({ state: 'loading' });
    void getInferenceHardware().then(
      (hardware) => {
        if (sequence.current !== current) return;
        setLoad({ state: 'ready', hardware, appVersion: null });
        // App version is optional; a failed ping must not hide valid hardware.
        void systemPing().then(
          (status) => {
            if (sequence.current === current)
              setLoad({
                state: 'ready',
                hardware,
                appVersion: status.appVersion,
              });
          },
          () => {},
        );
      },
      (error) => {
        if (sequence.current === current)
          setLoad({
            state: 'error',
            message: errorText(
              error,
              'System information could not be loaded.',
            ),
          });
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh]);

  const hardware = load.state === 'ready' ? load.hardware : null;
  const appVersion = load.state === 'ready' ? load.appVersion : null;
  const tiles = hardware
    ? [
        {
          label: 'Processor',
          value: `${hardware.cpuLogicalCount} logical CPUs`,
          hint: 'Chip model not reported',
          icon: Cpu,
          tone: 'green',
        },
        {
          label: 'Memory',
          value: capacity(hardware.totalMemoryBytes),
          hint: 'Total system RAM',
          icon: MemoryStick,
          tone: 'lilac',
        },
        {
          label: 'Operating system',
          value: hardware.platform,
          hint: hardware.osRelease
            ? `OS release ${hardware.osRelease}`
            : 'OS release not reported',
          icon: Monitor,
          tone: 'blue',
        },
        {
          label: 'Architecture / Platform',
          value: `${hardware.platform} · ${hardware.architecture}`,
          hint: 'Reported identifiers',
          icon: Layers,
          tone: 'lilac',
        },
        {
          label: 'Acceleration',
          value:
            hardware.acceleration === 'unknown'
              ? 'Unknown'
              : hardware.acceleration === 'cpu'
                ? 'CPU'
                : hardware.acceleration,
          hint: 'Reported compute backend',
          icon: Activity,
          tone: 'green',
        },
        {
          label: 'Available memory',
          value: capacity(hardware.freeMemoryBytes),
          hint: 'Free RAM at this snapshot',
          icon: Server,
          tone: 'peach',
        },
      ]
    : [];

  return (
    <section className="settings-section system-settings" aria-label="System">
      <div className="system-heading">
        <span className="system-heading-icon">
          <Monitor aria-hidden="true" />
        </span>
        <div className="system-heading-copy">
          <h2>System</h2>
          <p>Reported device capacity and operating system.</p>
        </div>
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw aria-hidden="true" />}
          data-testid="system-refresh"
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>
      <ThemeSwitch />
      {load.state === 'loading' && (
        <p role="status">Reading system information…</p>
      )}
      {load.state === 'error' && (
        <p role="alert" className="settings-error">
          {load.message} Try Refresh.
        </p>
      )}
      {hardware && (
        <>
          <div data-testid="system-details" className="system-grid">
            {tiles.map(({ label, value, hint, icon: Icon, tone }) => (
              <Card key={label} padding="compact" className="system-tile">
                <div className="system-tile-top">
                  <span className={`system-tile-icon system-tile-icon-${tone}`}>
                    <Icon size={21} aria-hidden="true" />
                  </span>
                  <h3>{label}</h3>
                </div>
                <strong className="system-tile-value" title={value}>
                  {value}
                </strong>
                <span className="system-tile-hint" title={hint}>
                  {hint}
                </span>
              </Card>
            ))}
          </div>
          <Disclosure
            className="system-more"
            label="More device details & readings"
          >
            <dl className="system-facts">
              <dt>GPU</dt>
              <dd>{hardware.gpuName ?? 'Not reported'}</dd>
              <dt>GPU memory</dt>
              <dd>{capacity(hardware.gpuMemoryBytes)}</dd>
              <dt>Free disk now</dt>
              <dd>{capacity(hardware.freeDiskBytes)}</dd>
              <dt>App version</dt>
              <dd>{appVersion ?? 'Unavailable'}</dd>
            </dl>
            <p>
              Free disk is device capacity, not the size of your database,
              documents or recordings. Binary units: 1 GiB = 1,024 MiB.
            </p>
            {hardware.notes.map((note, index) => (
              <p key={index}>{note}</p>
            ))}
            <p>
              Local-model fit is advisory: total memory, current load, GPU/CPU
              capabilities and model quantisation all matter. Choose and test a
              model in{' '}
              <button
                type="button"
                className="settings-text-action"
                onClick={onOpenLocalAi}
              >
                Local AI
              </button>
              .
            </p>
          </Disclosure>
        </>
      )}
    </section>
  );
}
