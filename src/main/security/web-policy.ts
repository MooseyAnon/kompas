/**
 * Pure, Electron-free web-security policy helpers for the privileged renderer.
 *
 * These encode the navigation, new-window and Content-Security-Policy decisions
 * enforced in the main process, extracted so each trust-boundary rule can be
 * unit-tested directly (see `test/web-policy.test.ts`). `main.ts` is the only
 * place these are wired to real Electron events.
 */

import { classifyExternalUrl } from '../modules/web/url-safety';

/** URL prefixes that identify our own application origin. */
export function allowedUrlPrefixes(devServerUrl?: string): string[] {
  const prefixes = ['file://'];
  if (devServerUrl) {
    prefixes.push(devServerUrl);
  }
  return prefixes;
}

/** True only when a target URL belongs to an allowed app-origin prefix. */
export function isAllowedAppUrl(
  targetUrl: string,
  prefixes: string[],
): boolean {
  return prefixes.some((prefix) => targetUrl.startsWith(prefix));
}

/** Navigation is allowed only within the app origin; everything else is blocked. */
export function navigationDecision(
  targetUrl: string,
  prefixes: string[],
): 'allow' | 'block' {
  return isAllowedAppUrl(targetUrl, prefixes) ? 'allow' : 'block';
}

/** All programmatic window/webview creation is denied; links are never auto-opened. */
export function windowOpenDecision(): { action: 'deny' } {
  return { action: 'deny' };
}

/** Result of a user-initiated window-open attempt (e.g. clicking a result link). */
export interface WindowOpenResult {
  /** In-app windows/webviews are always denied to keep the renderer sandboxed. */
  action: 'deny';
  /**
   * When set, the URL is a safe public http(s) address that the caller should
   * hand to the OS default browser via `shell.openExternal`. This happens only
   * on an explicit user action (a link click), never automatically.
   */
  externalUrl?: string;
}

/**
 * Decide what to do with a window-open request carrying a target URL. In-app
 * window/webview creation is always denied; a safe public http(s) URL is
 * surfaced for opening in the OS browser. Unsafe schemes/hosts are denied with
 * no external open.
 */
export function resolveWindowOpen(targetUrl: string): WindowOpenResult {
  const safety = classifyExternalUrl(targetUrl);
  if (safety.ok) {
    return { action: 'deny', externalUrl: safety.url };
  }
  return { action: 'deny' };
}

/**
 * Content Security Policy. Production is strict; development relaxes script and
 * connect sources only as far as Vite HMR / React Fast Refresh require.
 */
export function contentSecurityPolicy(isDev: boolean): string {
  if (isDev) {
    return [
      "default-src 'self'",
      // Dev-only: Vite HMR and React Fast Refresh inject inline scripts.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      // Audio playback assembles recordings into in-memory blob: URLs.
      "media-src 'self' blob:",
      "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // Audio playback assembles recordings into in-memory blob: URLs.
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}
