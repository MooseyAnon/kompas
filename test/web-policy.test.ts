import { describe, expect, it } from 'vitest';
import {
  allowedUrlPrefixes,
  contentSecurityPolicy,
  isAllowedAppUrl,
  navigationDecision,
  resolveWindowOpen,
  windowOpenDecision,
} from '../src/main/security/web-policy';

const DEV_URL = 'http://localhost:5173';

describe('allowed app origin', () => {
  it('always trusts the local file:// origin', () => {
    expect(allowedUrlPrefixes()).toEqual(['file://']);
  });

  it('additionally trusts the dev server origin only when provided', () => {
    expect(allowedUrlPrefixes(DEV_URL)).toEqual(['file://', DEV_URL]);
  });

  it('accepts app-origin URLs and rejects foreign ones', () => {
    const prefixes = allowedUrlPrefixes(DEV_URL);
    expect(isAllowedAppUrl('file:///app/index.html', prefixes)).toBe(true);
    expect(isAllowedAppUrl(`${DEV_URL}/index.html`, prefixes)).toBe(true);
    expect(isAllowedAppUrl('https://evil.example/phish', prefixes)).toBe(false);
    expect(isAllowedAppUrl('http://127.0.0.1:9/', prefixes)).toBe(false);
    expect(isAllowedAppUrl('javascript:alert(1)', prefixes)).toBe(false);
  });
});

describe('navigation policy', () => {
  const prefixes = allowedUrlPrefixes();

  it('allows navigation within the app origin', () => {
    expect(navigationDecision('file:///app/profile.html', prefixes)).toBe(
      'allow',
    );
  });

  it('blocks navigation to any external origin', () => {
    expect(navigationDecision('https://attacker.test/', prefixes)).toBe(
      'block',
    );
    expect(navigationDecision('http://example.com', prefixes)).toBe('block');
    expect(navigationDecision('about:blank', prefixes)).toBe('block');
  });
});

describe('window open policy', () => {
  it('denies all programmatic window/webview creation', () => {
    expect(windowOpenDecision()).toEqual({ action: 'deny' });
  });

  it('denies in-app windows but surfaces a safe public link for the OS browser', () => {
    const decision = resolveWindowOpen('https://example.com/careers');
    expect(decision.action).toBe('deny');
    expect(decision.externalUrl).toBe('https://example.com/careers');
  });

  it('never surfaces an external open for unsafe schemes or private hosts', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'http://localhost:9/admin',
      'http://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/internal',
    ]) {
      const decision = resolveWindowOpen(url);
      expect(decision.action).toBe('deny');
      expect(decision.externalUrl).toBeUndefined();
    }
  });
});

describe('content security policy', () => {
  it('production CSP forbids eval, remote and inline scripts', () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('http://localhost');
  });

  it('allows local and in-memory blob audio playback but no remote media', () => {
    for (const csp of [
      contentSecurityPolicy(false),
      contentSecurityPolicy(true),
    ]) {
      expect(csp).toContain("media-src 'self' blob:");
      expect(csp).not.toContain('media-src https:');
      expect(csp).not.toContain('media-src *');
    }
  });

  it('development CSP relaxes only script/connect for Vite HMR', () => {
    const csp = contentSecurityPolicy(true);
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('ws:');
    expect(csp).not.toContain('unsafe-eval');
  });
});
