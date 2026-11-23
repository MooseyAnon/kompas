/**
 * Two interfaces share one back end: Kompas (the default) and Meadow.
 * Kompas lives in presentation/gnd (first designed under the working name
 * GND). The choice is per computer, kept in local storage, and applied before the first render so the page never flashes the other theme.
 */
export const THEMES = [
  { id: 'kompas', label: 'Kompas' },
  { id: 'meadow', label: 'Meadow' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

const KEY = 'kompas.theme';
export const DEFAULT_THEME: ThemeId = 'kompas';
const isTheme = (value: unknown): value is ThemeId =>
  THEMES.some((theme) => theme.id === value);

/** `?theme=gnd` in the URL wins (handy for previews), then the saved choice. */
export function readTheme(): ThemeId {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('theme');
    if (isTheme(fromUrl)) return fromUrl;
    if (fromUrl === 'gnd') return 'kompas';
    const saved = window.localStorage.getItem(KEY);
    if (isTheme(saved)) return saved;
    if (saved === 'gnd') return 'kompas'; // its earlier name
  } catch {
    // Storage unavailable: use the default.
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}

/** Save the choice and reload, so the whole app swaps interface cleanly. */
export function switchTheme(theme: ThemeId): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Not saved; the reload below still shows the current choice.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete('theme');
  window.location.replace(url.toString());
}
