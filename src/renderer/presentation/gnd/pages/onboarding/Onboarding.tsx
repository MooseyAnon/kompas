import { motionReduced } from '../../../motion';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  completeOnboarding,
  createSavedSearch,
  createTarget,
  executeDiscoveryRun,
  startCvImport,
  listTargets,
  startDiscoveryRun,
} from '../../../../api';
import type {
  CvImport,
  Document,
  WorkArrangement,
} from '../../../../../shared/contracts';
import { failureNotice } from '../../../../app/Notifications';
import { OnboardingFrame } from './OnboardingFrame';
import { profileCard, searchConfigFor, suggestRoles } from './onboardingPlan';
import { LearningStep } from './steps/LearningStep';
import { applyCvImport, rememberPendingCv } from './pendingCv';
import { LocalAiStep, localAiReady } from './steps/LocalAiStep';
import { PreferencesStep } from './steps/PreferencesStep';
import { ProfileStep } from './steps/ProfileStep';
import { RolesStep } from './steps/RolesStep';
import { UploadStep } from './steps/UploadStep';
import { WelcomeStep } from './steps/WelcomeStep';
import './Onboarding.css';

type Step =
  | 'welcome'
  | 'local-ai'
  | 'upload'
  | 'learning'
  | 'roles'
  | 'preferences'
  | 'profile';

/** How long a step's text takes to animate out (matches gnd-leave). */
const LEAVE_MS = 320;

export type OnboardingExit = { destination: 'home' | 'jobs' };

/**
 * GND first run: local AI → CV → roles → preferences → profile card. The
 * card's "Looks right" is the single write: confirmed CV facts, target roles,
 * and a saved search whose first run starts before Jobs opens. Step state is
 * transient, as before; a restart returns to Welcome without losing saved
 * records. "Skip setup" skips the optional steps but always asks for a role.
 */
export function Onboarding({
  onComplete,
  startWithCv,
  onClose,
}: {
  onComplete: (exit: OnboardingExit) => void;
  /** Open at "Upload your CV" (from Profile), setting up Ollama first if needed. */
  startWithCv?: boolean;
  /** Opened from inside the app: Close replaces Skip setup and saves nothing. */
  onClose?: () => void;
}) {
  const [step, setShownStep] = useState<Step>(
    startWithCv ? 'upload' : 'welcome',
  );
  const [leaving, setLeaving] = useState(false);
  const pending = useRef<number | null>(null);
  // Arc-style: the current text animates out, then the next step comes in.
  const setStep = (next: Step) => {
    if (pending.current) window.clearTimeout(pending.current);
    // No motion when it's turned off (or can't be checked, as in tests).
    if (motionReduced()) return setShownStep(next);
    setLeaving(true);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      setLeaving(false);
      setShownStep(next);
    }, LEAVE_MS);
  };
  useEffect(
    () => () => {
      if (pending.current) window.clearTimeout(pending.current);
    },
    [],
  );
  const [checking, setChecking] = useState(false);
  const [cvImport, setCvImport] = useState<CvImport | null>(null);
  // The chosen CV; it's read after the job search starts.
  const [cvFile, setCvFile] = useState<Document | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [arrangement, setArrangement] = useState<WorkArrangement>('any');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Retries must not create a second saved search or run.
  const savedSearchId = useRef<string | null>(null);
  const runStarted = useRef(false);
  const cvStarted = useRef(false);

  const draft = cvImport?.draft ?? null;
  const suggested = useMemo(() => suggestRoles(draft), [draft]);
  const card = profileCard(draft, roles, location, arrangement);

  useEffect(() => {
    if (!startWithCv) return;
    void localAiReady().then((ready) => !ready && setShownStep('local-ai'));
  }, [startWithCv]);

  async function begin() {
    setChecking(true);
    const ready = await localAiReady();
    setChecking(false);
    setStep(ready ? 'upload' : 'local-ai');
  }

  /** Finished reading while waiting on the last step: show the profile. */
  function cvRead(settled: CvImport) {
    setCvImport(settled);
    setStep('profile');
  }

  function withoutCv() {
    setCvImport(null);
    setRoles([]);
    setStep('roles');
  }

  /**
   * Skipping only skips the optional parts: everyone is asked for the role
   * they want, so Jobs always has roles. Before roles, Skip goes to the role
   * question; after it, Skip saves the search with the defaults.
   */
  function skip() {
    if (onClose) return onClose();
    if (step === 'preferences' || step === 'profile') return void confirm();
    withoutCv();
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      // A CV read earlier (from Profile) is saved now.
      if (cvImport && cvImport.status !== 'processing')
        await applyCvImport(cvImport);

      const existing = new Set(
        (await listTargets()).map((target) => target.roleTitle.toLowerCase()),
      );
      for (const roleTitle of roles) {
        if (existing.has(roleTitle.toLowerCase())) continue;
        await createTarget({
          roleTitle,
          location: location.trim() || null,
          active: true,
        });
        existing.add(roleTitle.toLowerCase());
      }

      if (!savedSearchId.current) {
        const search = await createSavedSearch(
          searchConfigFor(roles, location, arrangement),
        );
        savedSearchId.current = search.id;
      }
      if (!runStarted.current) {
        const run = await startDiscoveryRun(savedSearchId.current);
        runStarted.current = true;
        // Acknowledged immediately; the search continues in the background
        // and Jobs → Discover shows its progress.
        await executeDiscoveryRun(run.id);
      }

      // The CV is read after the search has started, so job listings get local
      // AI first; the app saves the result to the profile when it's done.
      if (cvFile && !cvStarted.current) {
        const started = await startCvImport(cvFile.id).catch(() => null);
        cvStarted.current = true;
        if (started) rememberPendingCv(started.id);
      }

      await completeOnboarding();
      onComplete({ destination: 'home' });
    } catch (e) {
      setError(
        failureNotice(e, 'Something went wrong setting up. Please try again.')
          .message,
      );
      setBusy(false);
    }
  }

  const frame = (
    key: Step,
    align: 'center' | 'top',
    content: React.ReactNode,
  ) => (
    <OnboardingFrame
      stepKey={key}
      align={align}
      onSkip={key === 'roles' && !onClose ? undefined : skip}
      skipDisabled={busy}
      skipLabel={onClose ? 'Close' : undefined}
      leaving={leaving}
      music={!onClose}
    >
      {content}
    </OnboardingFrame>
  );

  switch (step) {
    case 'welcome':
      return frame(
        'welcome',
        'center',
        <WelcomeStep onBegin={() => void begin()} busy={checking} />,
      );
    case 'local-ai':
      return frame(
        'local-ai',
        'center',
        <LocalAiStep onReady={() => setStep('upload')} onSkip={withoutCv} />,
      );
    case 'upload':
      return frame(
        'upload',
        'center',
        <UploadStep
          onChosen={(file) => {
            setCvFile(file);
            setStep('roles');
          }}
          onSkip={withoutCv}
        />,
      );
    case 'learning':
      return frame(
        'learning',
        'center',
        <LearningStep
          cvImport={cvImport!}
          onRead={cvRead}
          onRetry={() => setStep('upload')}
          onSetupAi={() => setStep('local-ai')}
          onSkip={() => {
            setCvImport(null);
            setStep('profile');
          }}
        />,
      );
    case 'roles':
      return frame(
        'roles',
        'center',
        <>
          <RolesStep
            suggested={suggested}
            roles={roles}
            onChange={setRoles}
            onNext={() => setStep('preferences')}
          />
        </>,
      );
    case 'preferences':
      return frame(
        'preferences',
        'center',
        <>
          <PreferencesStep
            location={location}
            arrangement={arrangement}
            onLocation={setLocation}
            onArrangement={setArrangement}
            onNext={() => void confirm()}
            busy={busy}
            error={error}
          />
        </>,
      );
    case 'profile':
      return frame(
        'profile',
        'center',
        <ProfileStep
          card={card}
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onBack={() => setStep('preferences')}
        />,
      );
  }
}
