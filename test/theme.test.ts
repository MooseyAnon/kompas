// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  readTheme,
  switchTheme,
} from '../src/renderer/presentation/theme';

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  delete document.documentElement.dataset.theme;
});

describe('interface theme', () => {
  it('defaults to Meadow, remembers Kompas, and lets ?theme= override', () => {
    expect(readTheme()).toBe('meadow');
    window.localStorage.setItem('kompas.theme', 'kompas');
    expect(readTheme()).toBe('kompas');
    window.localStorage.setItem('kompas.theme', 'gnd');
    expect(readTheme()).toBe('kompas');
    window.history.replaceState(null, '', '/?theme=meadow');
    expect(readTheme()).toBe('meadow');
    window.localStorage.setItem('kompas.theme', 'nonsense');
    window.history.replaceState(null, '', '/');
    expect(readTheme()).toBe('meadow');
  });

  it('marks the document so Kompas tokens apply only to Kompas', () => {
    applyTheme('kompas');
    expect(document.documentElement.dataset.theme).toBe('kompas');
    applyTheme('meadow');
    expect(document.documentElement.dataset.theme).toBe('meadow');
  });

  it('saves the choice when switching', () => {
    try {
      switchTheme('kompas');
    } catch {
      // jsdom does not navigate; the saved choice is what matters.
    }
    expect(window.localStorage.getItem('kompas.theme')).toBe('kompas');
  });
});
