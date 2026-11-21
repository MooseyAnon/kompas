import React, { useEffect, useRef, useState } from 'react';
import type { Destination } from '../../app/destinations';
import {
  audioSttProvidersList,
  completeOnboarding,
  getInferenceSettings,
  webListBrowsers,
} from '../../api';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import { MeadowScene } from '../../presentation/meadow/MeadowScene';
import { ProfilePage } from '../profile/ProfilePage';
import { SettingsPage } from '../settings/SettingsPage';
import './Onboarding.css';

const steps = [
  { id: 'welcome', heading: 'Your next chapter starts here' },
  { id: 'readiness', heading: 'Workspace readiness' },
  { id: 'profile-choice', heading: 'Build your profile' },
  { id: 'profile-edit', heading: 'Review your profile' },
  { id: 'targets', heading: 'Where would you like to go next?' },
  { id: 'finish', heading: 'Enter your workspace' },
] as const;

type Step = (typeof steps)[number]['id'];
type ModelStatus = 'Checking…' | 'Ready' | 'Needs setup' | 'Unknown / error';
type Readiness = { label: string; status: string; settings?: boolean };

function hasSelectedLocalModel(
  result: Awaited<ReturnType<typeof getInferenceSettings>>,
): boolean {
  const { settings, resolvedModel } = result;

  return Boolean(
    settings.modelId &&
    resolvedModel?.installed &&
    resolvedModel.locality === 'local' &&
    resolvedModel.id === settings.modelId &&
    resolvedModel.providerId === settings.providerId,
  );
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>(steps[0].id);
  const [path, setPath] = useState<'cv' | 'manual' | null>(null);
  const [settings, setSettings] = useState(false);
  const [readiness, setReadiness] = useState<Readiness[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>('Checking…');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = useRef<HTMLHeadingElement>(null);
  const stepIndex = steps.findIndex((item) => item.id === step);

  useEffect(() => {
    title.current?.focus();
  }, [step, settings]);
  useEffect(() => {
    if (settings || (step !== 'readiness' && step !== 'profile-choice')) return;
    let active = true;

    setModelStatus('Checking…');
    void getInferenceSettings()
      .then((result) => {
        if (active) {
          setModelStatus(
            hasSelectedLocalModel(result) ? 'Ready' : 'Needs setup',
          );
        }
      })
      .catch(() => {
        if (active) setModelStatus('Unknown / error');
      });

    return () => {
      active = false;
    };
  }, [step, settings]);

  useEffect(() => {
    if (step !== 'readiness' || settings) return;
    let active = true;
    const checks: Array<[string, Promise<string>, boolean]> = [
      [
        'Browser',
        webListBrowsers().then((result) =>
          result.browsers.some(
            (browser) => browser.detected && browser.supported,
          )
            ? 'Ready'
            : 'Needs setup',
        ),
        true,
      ],
      [
        'Offline voice (optional)',
        audioSttProvidersList().then((items) =>
          items.some((item) => item.ready && item.offline)
            ? 'Ready'
            : 'Optional',
        ),
        true,
      ],
    ];
    setReadiness(
      checks.map(([label, , link]) => ({
        label,
        status: 'Checking…',
        settings: link,
      })),
    );
    checks.forEach(([label, check, link], index) => {
      void check
        .then((status) => {
          if (active)
            setReadiness((items) =>
              items.map((item, i) =>
                i === index ? { label, status, settings: link } : item,
              ),
            );
        })
        .catch(() => {
          if (active)
            setReadiness((items) =>
              items.map((item, i) =>
                i === index
                  ? { label, status: 'Unknown / error', settings: link }
                  : item,
              ),
            );
        });
    });
    return () => {
      active = false;
    };
  }, [step, settings]);

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await completeOnboarding();
      onComplete();
    } catch {
      setError('Could not save onboarding status. Please retry.');
    } finally {
      setBusy(false);
    }
  }
  function go(next: Step) {
    setError('');
    setSettings(false);
    setStep(next);
  }

  async function beginCv() {
    setModelStatus('Checking…');
    setError('');

    try {
      const ready = hasSelectedLocalModel(await getInferenceSettings());
      setModelStatus(ready ? 'Ready' : 'Needs setup');

      if (!ready) return;

      setPath('cv');
      go('profile-edit');
    } catch {
      setModelStatus('Unknown / error');
      setError('Could not check the selected model. Open Settings to retry.');
    }
  }

  function navigate(destination: Destination) {
    if (destination === 'settings') setSettings(true);
  }

  return (
    <div className="onboarding-shell" data-testid="onboarding">
      <MeadowScene density="full" />
      <div className="onboarding-drag" aria-hidden="true" />
      <main className="onboarding-panel">
        <div className="onboarding-top">
          <span>
            KOMPAS · {stepIndex + 1} / {steps.length}
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => void finish()}>
            Skip onboarding
          </Button>
        </div>
        <h1 ref={title} tabIndex={-1}>
          {settings ? 'Settings' : steps[stepIndex].heading}
        </h1>
        <div className="onboarding-body" key={`${step}-${settings}`}>
          {settings ? (
            <>
              <p>
                Select an installed local model for CV parsing, then return to
                your setup. Browser and voice capabilities are optional.
              </p>
              <div className="onboarding-settings">
                <SettingsPage />
              </div>
            </>
          ) : (
            <>
              {step === 'welcome' && (
                <Card>
                  <p>
                    Set up your career space at your own pace. You can edit your
                    Profile any time.
                  </p>
                  <Button onClick={() => go(steps[stepIndex + 1].id)}>
                    Get started
                  </Button>
                </Card>
              )}
              {step === 'profile-choice' && (
                <Card>
                  <p>
                    Import a CV to review suggestions, or start with your own
                    words. Neither requires a complete profile.
                  </p>
                  <p role="status">
                    {modelStatus === 'Ready'
                      ? 'Your selected local model is ready for CV parsing.'
                      : modelStatus === 'Checking…'
                        ? 'Checking your selected local model…'
                        : 'CV parsing requires a selected, installed local model. Configure Local AI or enter your profile manually.'}
                  </p>
                  <div className="profile-actions">
                    <Button
                      disabled={modelStatus !== 'Ready'}
                      onClick={() => void beginCv()}
                    >
                      Import a CV
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPath('manual');
                        go('profile-edit');
                      }}
                    >
                      Enter manually
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setSettings(true)}
                    >
                      Configure local AI
                    </Button>
                  </div>
                </Card>
              )}
              {step === 'profile-edit' && (
                <>
                  <p>
                    {path === 'cv'
                      ? 'Import or resume a CV draft below. Review each proposal before confirming; you can continue manually if parsing fails.'
                      : 'Add your details, experience, education or skills below. Save each edit before continuing.'}
                  </p>
                  {path === 'cv' && (
                    <Button
                      variant="secondary"
                      onClick={() => setPath('manual')}
                    >
                      Continue manually
                    </Button>
                  )}
                  <ProfilePage
                    key={path}
                    initialTab={path === 'cv' ? 'documents' : 'overview'}
                    onboarding
                    onNavigate={navigate}
                  />
                </>
              )}
              {step === 'targets' && (
                <>
                  <p>
                    Target roles are separate from your current role. Add more
                    than one, or skip for now.
                  </p>
                  <ProfilePage
                    initialTab="targets"
                    onboarding
                    onNavigate={navigate}
                  />
                </>
              )}
              {step === 'readiness' && (
                <>
                  <p>
                    Configure and select a local model before importing your CV.
                    CV parsing requires a selected, installed local model. You
                    can continue without one to enter your profile manually.
                    Browser and voice setup are optional.
                  </p>
                  <Button onClick={() => setSettings(true)}>
                    Configure local AI
                  </Button>
                  <div className="onboarding-tiles">
                    <Card variant="subtle">
                      <h2>Local model</h2>
                      <p role="status">{modelStatus}</p>
                    </Card>
                    {readiness.map((item) => (
                      <Card key={item.label} variant="subtle">
                        <h2>{item.label}</h2>
                        <p>{item.status}</p>
                        {item.settings && (
                          <Button
                            variant="ghost"
                            onClick={() => setSettings(true)}
                          >
                            Open Settings
                          </Button>
                        )}
                      </Card>
                    ))}
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSettings(true);
                    }}
                  >
                    Check Settings
                  </Button>
                </>
              )}
              {step === 'finish' && (
                <Card>
                  <p>
                    Your workspace is ready to explore. You can return to
                    Profile whenever you like.
                  </p>
                  <Button disabled={busy} onClick={() => void finish()}>
                    {busy ? 'Saving…' : 'Open my workspace'}
                  </Button>
                </Card>
              )}
            </>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        <nav className="onboarding-actions" aria-label="Onboarding navigation">
          {settings ? (
            <Button variant="secondary" onClick={() => setSettings(false)}>
              Back to setup
            </Button>
          ) : (
            <>
              {stepIndex > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => go(steps[stepIndex - 1].id)}
                >
                  Back
                </Button>
              )}
              {step === 'targets' && (
                <Button variant="ghost" onClick={() => go('finish')}>
                  Skip for now
                </Button>
              )}
              {(step === 'readiness' ||
                step === 'profile-edit' ||
                step === 'targets') && (
                <Button onClick={() => go(steps[stepIndex + 1].id)}>
                  Continue
                </Button>
              )}
            </>
          )}
        </nav>
      </main>
    </div>
  );
}
