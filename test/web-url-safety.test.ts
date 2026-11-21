import { describe, expect, it } from 'vitest';
import {
  classifyExternalUrl,
  classifyReadUrl,
  isAllowedRequestUrl,
  isPrivateHost,
  isPublicHttpUrl,
} from '../src/main/modules/web/url-safety';

describe('web url-safety', () => {
  it('accepts public absolute http(s) URLs', () => {
    for (const url of [
      'https://example.com/path?q=1#frag',
      'http://news.example.org',
      'https://sub.domain.example.co.uk/a/b',
    ]) {
      const result = classifyExternalUrl(url);
      expect(result.ok).toBe(true);
      expect(isPublicHttpUrl(url)).toBe(true);
    }
  });

  it('rejects non-http schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com/file',
      'mailto:a@b.com',
    ]) {
      const result = classifyExternalUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['NON_HTTP', 'INVALID_URL']).toContain(result.reason);
      }
    }
  });

  it('rejects relative / malformed URLs', () => {
    for (const url of ['/relative/path', 'not a url', 'example.com', '']) {
      expect(classifyExternalUrl(url).ok).toBe(false);
    }
  });

  it('blocks loopback, private, link-local and metadata hosts', () => {
    for (const host of [
      'localhost',
      'foo.localhost',
      'printer.local',
      'service.internal',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.9.9',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '[::1]',
      '[fe80::1]',
      '[fc00::1]',
      '[::ffff:192.168.1.1]',
    ]) {
      expect(isPrivateHost(host.replace(/^\[|\]$/g, ''))).toBe(true);
      expect(classifyExternalUrl(`https://${host}/x`).ok).toBe(false);
    }
  });

  it('treats a public IPv4 / IPv6 literal as allowed', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(classifyExternalUrl('https://8.8.8.8/').ok).toBe(true);
    expect(isPrivateHost('2001:4860:4860::8888')).toBe(false);
  });

  it('does not misclassify 172.x outside the private /12 block', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });
});

describe('classifyReadUrl (page reader)', () => {
  const noLookup = async () => [];

  it('accepts a public URL whose DNS resolution is public', async () => {
    const result = await classifyReadUrl('https://example.org/docs', {
      lookup: async () => [{ address: '93.184.216.34' }],
    });
    expect(result).toEqual({ ok: true, url: 'https://example.org/docs' });
  });

  it('rejects non-http, loopback and private literals without resolving', async () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://[::1]/x',
      'http://10.0.0.5/x',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      const result = await classifyReadUrl(url, { lookup: noLookup });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a public hostname that resolves to a private address (DNS-rebinding guard)', async () => {
    const result = await classifyReadUrl('https://sneaky.example/', {
      lookup: async () => [{ address: '192.168.1.10' }],
    });
    expect(result).toEqual({ ok: false, reason: 'PRIVATE_ADDRESS' });
  });

  it('permits loopback ONLY under the explicit smoke exception', async () => {
    const blocked = await classifyReadUrl('http://127.0.0.1:8080/fixture', {
      lookup: noLookup,
    });
    expect(blocked.ok).toBe(false);

    const allowed = await classifyReadUrl('http://127.0.0.1:8080/fixture', {
      allowLoopback: true,
      lookup: noLookup,
    });
    expect(allowed).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8080/fixture',
    });
  });
});

describe('isAllowedRequestUrl (per-request subresource/redirect guard)', () => {
  it('allows public http(s) and blocks private/loopback/non-http subrequests', () => {
    expect(isAllowedRequestUrl('https://cdn.example.org/app.js')).toBe(true);
    expect(isAllowedRequestUrl('http://127.0.0.1/secret')).toBe(false);
    expect(isAllowedRequestUrl('http://169.254.169.254/meta')).toBe(false);
    expect(isAllowedRequestUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRequestUrl('data:text/html,hi')).toBe(false);
  });

  it('permits loopback only under the explicit exception', () => {
    expect(isAllowedRequestUrl('http://127.0.0.1/fixture')).toBe(false);
    expect(
      isAllowedRequestUrl('http://127.0.0.1/fixture', { allowLoopback: true }),
    ).toBe(true);
  });
});
