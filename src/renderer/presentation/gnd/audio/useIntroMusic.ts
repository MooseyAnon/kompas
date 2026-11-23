import { useEffect, useRef, useState } from 'react';
import track from './intro-music.ogg';

const MUTED_KEY = 'gnd.introMusic.muted';
const VOLUME = 0.35;

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Background music for the first-run intro: fades in, loops (the file's ends
 * are crossfaded so the seam is silent), and fades out when the intro ends.
 * Muting is remembered. If the browser holds playback until a click, it
 * starts on the first click or key press.
 */
export function useIntroMusic(enabled: boolean) {
  const [muted, setMuted] = useState(readMuted);
  const audio = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<number | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const ramp = (to: number, ms: number, then?: () => void) => {
    const el = audio.current;
    if (!el) return;
    if (timer.current) window.clearInterval(timer.current);
    const from = el.volume;
    const started = performance.now();
    timer.current = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - started) / ms);
      el.volume = from + (to - from) * t;
      if (t >= 1) {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        then?.();
      }
    }, 40);
  };

  const start = () => {
    const el = audio.current;
    if (!el || mutedRef.current) return;
    try {
      const playing = el.play() as Promise<void> | undefined;
      if (playing && typeof playing.then === 'function')
        void playing.then(() => ramp(VOLUME, 4000)).catch(() => undefined);
    } catch {
      // No audio output; the intro carries on silently.
    }
  };

  useEffect(() => {
    if (!enabled || typeof Audio === 'undefined') return;
    const el = new Audio(track);
    el.loop = true;
    el.volume = 0;
    el.preload = 'auto';
    audio.current = el;
    start();
    const unlock = () => {
      if (el.paused) start();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      ramp(0, 1200, () => {
        el.pause();
        el.removeAttribute('src');
        el.load();
      });
    };
  }, [enabled]);

  function toggle() {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    try {
      window.localStorage.setItem(MUTED_KEY, next ? '1' : '0');
    } catch {
      // Not remembered this time.
    }
    const el = audio.current;
    if (!el) return;
    if (next) ramp(0, 600, () => el.pause());
    else if (el.paused) start();
    else ramp(VOLUME, 600);
  }

  return { muted, toggle };
}
