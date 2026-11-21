import { describe, expect, it } from 'vitest';
import { windowChromeFor } from '../src/main/window-chrome';
import { shellPlatform } from '../src/renderer/app/platform';

describe('window chrome', () => {
  it('keeps native traffic lights in a content-height macOS title bar', () => {
    expect(windowChromeFor('darwin')).toEqual({ titleBarStyle: 'hiddenInset' });
    expect(shellPlatform('MacIntel')).toBe('mac');
  });

  it('reserves native caption controls on Windows', () => {
    expect(windowChromeFor('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#f7f8f8', symbolColor: '#24302e', height: 52 },
    });
    expect(shellPlatform('Win32')).toBe('windows');
  });

  it('keeps native Linux decorations instead of applying Windows chrome', () => {
    expect(windowChromeFor('linux')).toEqual({});
    expect(shellPlatform('Linux x86_64')).toBe('other');
  });
});
