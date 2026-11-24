import { useEffect } from 'react';
import {
  applyProfileImport,
  getCvImport,
  listConfirmedSkills,
  replaceConfirmedSkills,
} from '../../../../api';
import type { CvImport } from '../../../../../shared/contracts';
import { useNotify } from '../../../../app/Notifications';
import { profileImportFrom, skillsFrom } from './onboardingPlan';

/**
 * A CV still being read when onboarding finished. Reading carries on in the
 * main process; the app applies the result to the profile when it's ready.
 */
const KEY = 'kompas.pendingCvImport';
const POLL_MS = 5000;

export function rememberPendingCv(id: string) {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // Without storage the result is simply not applied automatically.
  }
}

function pendingCv(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function forgetPendingCv() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}

/** Save what a read CV found: profile details and skills. */
export async function applyCvImport(cvImport: CvImport) {
  if (!cvImport.draft || cvImport.status === 'failed') return;
  const input = profileImportFrom(cvImport.id, cvImport.draft);
  if (input) await applyProfileImport(input);
  const skills = skillsFrom(cvImport.draft);
  if (skills.length) {
    const current = await listConfirmedSkills();
    await replaceConfirmedSkills([...new Set([...current, ...skills])]);
  }
}

/** Finishes a CV read that outlived onboarding, then says so. */
export function usePendingCvImport(onApplied?: () => void) {
  const notify = useNotify();
  useEffect(() => {
    const id = pendingCv();
    if (!id) return;
    let live = true;
    let timer = 0;
    const check = async () => {
      const current = await getCvImport(id).catch(() => null);
      if (!live) return;
      if (!current) return forgetPendingCv();
      if (current.status === 'processing') {
        timer = window.setTimeout(() => void check(), POLL_MS);
        return;
      }
      forgetPendingCv();
      if (current.status === 'ready' || current.status === 'partial') {
        try {
          await applyCvImport(current);
          notify({
            kind: 'info',
            message: 'Your CV is read. Your profile and skills are updated.',
          });
          onApplied?.();
        } catch {
          notify({
            kind: 'error',
            message: 'Your CV was read, but saving it to your profile failed.',
          });
        }
      } else if (current.status === 'failed') {
        notify({
          kind: 'error',
          message:
            'Your CV couldn’t be read. You can upload it again from Profile.',
        });
      }
    };
    void check();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
