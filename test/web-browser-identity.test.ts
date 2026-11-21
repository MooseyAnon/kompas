import { describe, expect, it } from 'vitest';
import {
  buildIdentity,
  normalizeUserAgent,
} from '../src/main/modules/web/adapters/playwright/browser-identity';

const HEADLESS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

describe('browser identity (UA normalization)', () => {
  it('replaces only the HeadlessChrome product token, preserving the rest', () => {
    expect(normalizeUserAgent(HEADLESS_UA)).toBe(CHROME_UA);
    expect(normalizeUserAgent(HEADLESS_UA)).not.toContain('HeadlessChrome');
  });

  it('is a no-op for a UA that already looks like normal Chrome', () => {
    expect(normalizeUserAgent(CHROME_UA)).toBe(CHROME_UA);
  });

  it('builds an identity with the normalized UA', () => {
    expect(buildIdentity(HEADLESS_UA)).toEqual({ userAgent: CHROME_UA });
  });

  it('leaves the browser default (no override) when the UA is empty', () => {
    expect(buildIdentity('')).toEqual({});
  });
});
