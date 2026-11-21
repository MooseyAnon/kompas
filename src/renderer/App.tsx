import React, { useEffect, useState } from 'react';
import { getOnboardingStatus } from './api';
import { Button } from './presentation/components/Button';
import { Onboarding } from './pages/onboarding/Onboarding';
import { ErrorBoundary } from './app/ErrorBoundary';
import { Notifications } from './app/Notifications';
import { Shell } from './presentation/Shell';

export function App() {
  const [status, setStatus] = useState<
    'loading' | 'error' | 'incomplete' | 'complete'
  >('loading');
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
          <Onboarding onComplete={() => setStatus('complete')} />
        )}
        {status === 'complete' && <Shell />}
      </Notifications>
    </ErrorBoundary>
  );
}
