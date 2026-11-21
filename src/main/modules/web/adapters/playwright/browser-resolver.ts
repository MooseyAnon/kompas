import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WebBrowserId } from '../../../../../shared/contracts';

/**
 * Playwright launch channel for a supported browser. Only Chromium-family
 * branded browsers (Chrome / Edge) are drivable without a bundled engine.
 */
export type LaunchChannel = 'chrome' | 'msedge';

/**
 * A browser discovered on this machine. `channel`/`appPath` are internal detail
 * used only by the engine to launch; they are **never** surfaced to the Web
 * service, IPC or renderer (no executable paths leave the main process).
 */
export interface InstalledBrowser {
  id: WebBrowserId;
  displayName: string;
  detected: boolean;
  /** True only for browsers the no-bundle Playwright reader can actually drive. */
  supported: boolean;
  /** Launch channel for supported browsers. */
  channel?: LaunchChannel;
  /** Discovered application path — internal only. */
  appPath?: string;
}

/**
 * OS resolver seam. Each platform resolver reports the browsers it can find.
 * macOS is implemented for Stage 009.2; Windows/Linux resolvers plug in later
 * without changing the adapter. There is deliberately no dummy success path for
 * unimplemented platforms.
 */
export interface PlatformBrowserResolver {
  readonly platform: NodeJS.Platform;
  discover(): InstalledBrowser[];
}

/**
 * Central, adapter-owned priority of **supported** browsers. Chrome is
 * preferred over Edge. Ordering here determines which browser the reader
 * selects when several are installed.
 */
export const SUPPORTED_BROWSER_PRIORITY: ReadonlyArray<{
  id: Extract<WebBrowserId, 'chrome' | 'msedge'>;
  displayName: string;
  channel: LaunchChannel;
}> = [
  { id: 'chrome', displayName: 'Google Chrome', channel: 'chrome' },
  { id: 'msedge', displayName: 'Microsoft Edge', channel: 'msedge' },
];

/** macOS application bundle names for the supported browsers. */
const MAC_APP_BUNDLES: Record<LaunchChannel, string> = {
  chrome: 'Google Chrome.app',
  msedge: 'Microsoft Edge.app',
};

/** Browsers reported when installed but never driven by the reader. */
const MAC_UNSUPPORTED_BROWSERS: ReadonlyArray<{
  id: Extract<WebBrowserId, 'safari' | 'firefox'>;
  displayName: string;
  bundle: string;
}> = [
  { id: 'safari', displayName: 'Safari', bundle: 'Safari.app' },
  { id: 'firefox', displayName: 'Firefox', bundle: 'Firefox.app' },
];

export interface MacResolverDeps {
  /** Injectable existence check for deterministic tests. */
  exists?: (path: string) => boolean;
  /** Injectable home directory for deterministic tests. */
  home?: string;
}

/**
 * Real macOS resolver. Discovers branded Chrome/Edge in the standard system and
 * per-user `/Applications` locations (verifying actual bundle presence rather
 * than assuming a PATH or `/usr/bin`). Safari and Firefox are reported when
 * present but marked **unsupported**, because Playwright cannot drive standard
 * Safari/Firefox without its own patched builds, which we do not ship.
 */
export function createMacBrowserResolver(
  deps: MacResolverDeps = {},
): PlatformBrowserResolver {
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();

  const appDirs = ['/Applications', join(home, 'Applications')];
  const firstExisting = (bundle: string): string | undefined => {
    for (const dir of appDirs) {
      const path = join(dir, bundle);
      if (exists(path)) {
        return path;
      }
    }
    return undefined;
  };

  return {
    platform: 'darwin',
    discover(): InstalledBrowser[] {
      // Supported browsers are always reported, detected or not.
      const supported = SUPPORTED_BROWSER_PRIORITY.map(
        ({ id, displayName, channel }): InstalledBrowser => {
          const appPath = firstExisting(MAC_APP_BUNDLES[id]);

          return {
            id,
            displayName,
            detected: Boolean(appPath),
            supported: true,
            channel,
            appPath,
          };
        },
      );

      // Unsupported but worth showing honestly when installed.
      const unsupported = MAC_UNSUPPORTED_BROWSERS.filter(({ bundle }) =>
        firstExisting(bundle),
      ).map(
        ({ id, displayName }): InstalledBrowser => ({
          id,
          displayName,
          detected: true,
          supported: false,
        }),
      );

      return [...supported, ...unsupported];
    },
  };
}

/**
 * Resolver for platforms without a real implementation yet. It discovers
 * nothing — an honest "no supported browser" rather than a fake success.
 */
export function createUnsupportedPlatformResolver(
  platform: NodeJS.Platform,
): PlatformBrowserResolver {
  return {
    platform,
    discover: () => [],
  };
}

/** Select the platform resolver. Only macOS is implemented in Stage 009.2. */
export function createBrowserResolver(
  platform: NodeJS.Platform = process.platform,
  deps: MacResolverDeps = {},
): PlatformBrowserResolver {
  if (platform === 'darwin') {
    return createMacBrowserResolver(deps);
  }
  return createUnsupportedPlatformResolver(platform);
}

/**
 * Choose the supported, detected browser the reader should use (Chrome before
 * Edge). Returns `undefined` when no supported browser is installed.
 */
export function selectLaunchableBrowser(
  installed: InstalledBrowser[],
): InstalledBrowser | undefined {
  for (const { id } of SUPPORTED_BROWSER_PRIORITY) {
    const match = installed.find(
      (browser) => browser.id === id && browser.detected && browser.supported,
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}
