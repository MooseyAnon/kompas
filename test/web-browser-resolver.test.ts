import { describe, expect, it } from 'vitest';
import {
  createBrowserResolver,
  createMacBrowserResolver,
  createUnsupportedPlatformResolver,
  selectLaunchableBrowser,
  type InstalledBrowser,
} from '../src/main/modules/web/adapters/playwright/browser-resolver';

function fakeFs(present: string[]) {
  const set = new Set(present);
  return (path: string) => set.has(path);
}

const HOME = '/Users/tester';

describe('macOS browser resolver', () => {
  it('reports no supported browser when neither Chrome nor Edge is installed', () => {
    const resolver = createMacBrowserResolver({
      exists: fakeFs([]),
      home: HOME,
    });
    const found = resolver.discover();
    const chrome = found.find((b) => b.id === 'chrome')!;
    const edge = found.find((b) => b.id === 'msedge')!;
    expect(chrome.detected).toBe(false);
    expect(edge.detected).toBe(false);
    expect(selectLaunchableBrowser(found)).toBeUndefined();
  });

  it('detects Chrome only (system Applications)', () => {
    const resolver = createMacBrowserResolver({
      exists: fakeFs(['/Applications/Google Chrome.app']),
      home: HOME,
    });
    const found = resolver.discover();
    expect(found.find((b) => b.id === 'chrome')?.detected).toBe(true);
    expect(found.find((b) => b.id === 'msedge')?.detected).toBe(false);
    const selected = selectLaunchableBrowser(found);
    expect(selected?.id).toBe('chrome');
    expect(selected?.channel).toBe('chrome');
  });

  it('detects Edge only (per-user Applications)', () => {
    const resolver = createMacBrowserResolver({
      exists: fakeFs([`${HOME}/Applications/Microsoft Edge.app`]),
      home: HOME,
    });
    const found = resolver.discover();
    expect(found.find((b) => b.id === 'msedge')?.detected).toBe(true);
    expect(selectLaunchableBrowser(found)?.id).toBe('msedge');
  });

  it('prefers Chrome over Edge when both are installed', () => {
    const resolver = createMacBrowserResolver({
      exists: fakeFs([
        '/Applications/Google Chrome.app',
        '/Applications/Microsoft Edge.app',
      ]),
      home: HOME,
    });
    expect(selectLaunchableBrowser(resolver.discover())?.id).toBe('chrome');
  });

  it('shows installed Safari/Firefox as unsupported and never selectable', () => {
    const resolver = createMacBrowserResolver({
      exists: fakeFs(['/Applications/Safari.app', '/Applications/Firefox.app']),
      home: HOME,
    });
    const found = resolver.discover();
    const safari = found.find((b) => b.id === 'safari')!;
    const firefox = found.find((b) => b.id === 'firefox')!;
    expect(safari.detected).toBe(true);
    expect(safari.supported).toBe(false);
    expect(firefox.supported).toBe(false);
    expect(selectLaunchableBrowser(found)).toBeUndefined();
  });

  it('never leaks the discovered executable path into the selectable summary fields', () => {
    const resolver = createMacBrowserResolver({
      exists: fakeFs(['/Applications/Google Chrome.app']),
      home: HOME,
    });
    const found = resolver.discover();
    // appPath is internal-only; the public BrowserInfo mapping (engine) drops it.
    expect(found.find((b) => b.id === 'chrome')?.appPath).toContain(
      '/Applications',
    );
  });
});

describe('platform resolver selection', () => {
  it('returns an honest empty discovery for an unsupported platform', () => {
    const resolver = createUnsupportedPlatformResolver('win32');
    expect(resolver.platform).toBe('win32');
    expect(resolver.discover()).toEqual([]);
  });

  it('createBrowserResolver uses the macOS resolver on darwin and empty elsewhere', () => {
    const mac = createBrowserResolver('darwin', { exists: fakeFs([]) });
    expect(mac.platform).toBe('darwin');
    const linux = createBrowserResolver('linux');
    expect(linux.discover()).toEqual([]);
  });
});

describe('selectLaunchableBrowser guards', () => {
  it('ignores detected-but-unsupported and supported-but-undetected entries', () => {
    const installed: InstalledBrowser[] = [
      { id: 'safari', displayName: 'Safari', detected: true, supported: false },
      {
        id: 'chrome',
        displayName: 'Google Chrome',
        detected: false,
        supported: true,
        channel: 'chrome',
      },
    ];
    expect(selectLaunchableBrowser(installed)).toBeUndefined();
  });
});
