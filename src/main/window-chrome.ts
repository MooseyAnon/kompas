import type { BrowserWindowConstructorOptions } from 'electron';

/** Only the window decoration varies by OS; security preferences stay in main.ts. */
export function windowChromeFor(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' };
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#f7f8f8', symbolColor: '#24302e', height: 52 },
    };
  }
  return {}; // Keep the native frame on Linux and other platforms.
}
