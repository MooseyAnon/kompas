import React, { useEffect, useRef, useState } from 'react';
import type { Destination } from '../../app/destinations';
import {
  audioSttProvidersList,
  completeOnboarding,
  getInferenceSettings,
  getProfile,
  listConfirmedSkills,
  listTargets,
  webListBrowsers,
} from '../../api';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import { MeadowScene } from '../../presentation/meadow/MeadowScene';
import { ProfilePage } from '../profile/ProfilePage';
import { SettingsPage } from '../settings/SettingsPage';
import './Onboarding.css';

const headings = [
  'Your next chapter starts here',
  'Build your profile',
  'Review your profile',
  'Where would you like to go next?',
  'Workspace readiness',
  'Enter your workspace',
];
type Readiness = { label: string; status: string; settings?: boolean };

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<'cv' | 'manual' | null>(null);
  const [settings, setSettings] = useState(false);
  const [readiness, setReadiness] = useState<Readiness[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, [step, settings]);
  useEffect(() => {
    if (step !== 4 || settings) return;
    let active = true;
    const checks: Array<[string, Promise<string>, boolean]> = [
      [
        'Profile',
        Promise.all([getProfile(), listConfirmedSkills(), listTargets()]).then(
          ([p, skills, targets]) =>
            p.displayName || p.currentRole || skills.length || targets.length
              ? 'Ready'
              : 'Needs setup',
        ),
        false,
      ],
      [
        'Local model',
        getInferenceSettings().then((result) =>
          result.resolvedModel?.installed &&
          result.resolvedModel.locality === 'local'
            ? 'Ready'
            : 'Needs setup',
        ),
        true,
      ],
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
  function go(next: number) {
    setError('');
    setSettings(false);
    setStep(next);
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
          <span>CAREER WORKSPACE · {step + 1} / 6</span>
          <Button variant="ghost" disabled={busy} onClick={() => void finish()}>
            Skip onboarding
          </Button>
        </div>
        <h1 ref={title} tabIndex={-1}>
          {settings ? 'Settings' : headings[step]}
        </h1>
        <div className="onboarding-body" key={`${step}-${settings}`}>
          {settings ? (
            <>
              <p>Configure optional capabilities, then return to your setup.</p>
              <div className="onboarding-settings">
                <SettingsPage />
              </div>
            </>
          ) : (
            <>
              {step === 0 && (
                <Card>
                  <p>
                    Set up your career space at your own pace. You can edit your
                    Profile any time.
                  </p>
                  <Button onClick={() => go(1)}>Get started</Button>
                </Card>
              )}
              {step === 1 && (
                <Card>
                  <p>
                    Import a CV to review suggestions, or start with your own
                    words. Neither requires a complete profile.
                  </p>
                  <div className="profile-actions">
                    <Button
                      onClick={() => {
                        setPath('cv');
                        go(2);
                      }}
                    >
                      Import a CV
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPath('manual');
                        go(2);
                      }}
                    >
                      Enter manually
                    </Button>
                  </div>
                </Card>
              )}
              {step === 2 && (
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
              {step === 3 && (
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
              {step === 4 && (
                <>
                  <p>
                    These checks are optional. You can use your workspace
                    without a model, browser or microphone.
                  </p>
                  <div className="onboarding-tiles">
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
              {step === 5 && (
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
              {step > 0 && (
                <Button variant="secondary" onClick={() => go(step - 1)}>
                  Back
                </Button>
              )}
              {step === 3 && (
                <Button variant="ghost" onClick={() => go(4)}>
                  Skip for now
                </Button>
              )}
              {step > 1 && step < 5 && (
                <Button onClick={() => go(step + 1)}>Continue</Button>
              )}
            </>
          )}
        </nav>
      </main>
    </div>
  );
}
