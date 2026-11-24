import React, { useEffect, useState } from 'react';
import { getOnboardingStatus } from '../../api';
import { Button } from '../components/Button';
import { Onboarding, type OnboardingExit } from './pages/onboarding/Onboarding';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { Notifications } from '../../app/Notifications';
import { GndShell } from './GndShell';
import './gnd.css';

/** The GND interface: its own onboarding, top bar and pages. */
export function GndApp() {
  const [status, setStatus] = useState<
    'loading' | 'error' | 'incomplete' | 'complete'
  >('loading');
  const [exit, setExit] = useState<OnboardingExit | null>(null);
  async function load() {
    setStatus('loading');
    try {
      setStatus(
        (await getOnboardingStatus()).completed ? 'complete' : 'incomplete',
      );
    } catch {
      setStatus('error');
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <ErrorBoundary>
      <Notifications>
        {status === 'loading' && <div role="status">Loading workspace…</div>}
        {status === 'error' && (
          <div role="alert">
            Unable to read onboarding status.{' '}
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        )}
        {status === 'incomplete' && (
          <Onboarding
            onComplete={(next) => {
              setExit(next);
              setStatus('complete');
            }}
          />
        )}
        {status === 'complete' && (
          <GndShell initialDestination={exit?.destination ?? 'home'} />
        )}
      </Notifications>
    </ErrorBoundary>
  );
}
