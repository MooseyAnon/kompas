/**
 * Kompas animations: "on" (the default) plays them whatever the computer's
 * Reduce Motion setting says; "system" follows it. Kept per computer and
 * applied as <html data-motion> so CSS can tell.
 */
export type MotionPreference = 'on' | 'system';
const KEY = 'kompas.motion';

export function readMotion(): MotionPreference {
  try {
    return window.localStorage.getItem(KEY) === 'system' ? 'system' : 'on';
  } catch {
    return 'on';
  }
}

export function applyMotion(preference: MotionPreference = readMotion()) {
  document.documentElement.dataset.motion =
    preference === 'on' ? 'full' : 'system';
}

export function saveMotion(preference: MotionPreference) {
  try {
    window.localStorage.setItem(KEY, preference);
  } catch {
    // Storage can be unavailable; the choice then lasts this session.
  }
  applyMotion(preference);
}

/** Whether to skip motion right now. */
export function motionReduced(): boolean {
  if (document.documentElement.dataset.motion === 'full') return false;
  return (
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
