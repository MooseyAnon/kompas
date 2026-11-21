import { isHttpUrl } from '../../../shared/contracts';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Pure URL-safety helpers for the Web domain. These gate which result links the
 * app will hand to the OS browser (explicit user action only) and will be
 * reused by the Stage 009.2 page reader.
 *
 * Note (honest limitation): these checks operate on the URL's literal host only.
 * A public hostname that *resolves* to a private/loopback address via DNS is
 * not caught here — DNS-rebinding defence requires resolution-time checks that
 * belong to the fetching path (009.2), not to link display/opening.
 */

export type UrlSafety =
  | { ok: true; url: string }
  | { ok: false; reason: 'INVALID_URL' | 'NON_HTTP' | 'PRIVATE_HOST' };

/** Accept only absolute http(s) URLs addressed to a public-web host. */
export function classifyExternalUrl(raw: string): UrlSafety {
  const parsed = parseHttpUrl(raw);
  if (!(parsed instanceof URL)) {
    return { ok: false, reason: parsed };
  }

  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: 'PRIVATE_HOST' };
  }
  return { ok: true, url: parsed.toString() };
}

/** Convenience boolean form of {@link classifyExternalUrl}. */
export function isPublicHttpUrl(raw: string): boolean {
  return classifyExternalUrl(raw).ok;
}

/** Minimal DNS resolver seam so tests exercise resolution-time checks offline. */
export type HostLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string }>>;

const defaultLookup: HostLookup = (hostname) =>
  dnsLookup(hostname, { all: true });

export type ReadUrlSafety =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: 'INVALID_URL' | 'NON_HTTP' | 'PRIVATE_HOST' | 'PRIVATE_ADDRESS';
    };

export interface ReadUrlOptions {
  /**
   * Smoke/integration **only**. When true, loopback/private hosts are allowed
   * so a packaged test can read a local fixture server. This must never be set
   * on the ordinary production `readPage` path; a negative test asserts that
   * `127.0.0.1` is rejected by default.
   */
  allowLoopback?: boolean;
  /** Injectable DNS lookup for deterministic tests; defaults to `dns.lookup`. */
  lookup?: HostLookup;
}

/**
 * Validate a URL destined for the passive page reader. In addition to the
 * literal-host checks of {@link classifyExternalUrl}, this performs a
 * best-effort resolution-time check: if the hostname resolves to any
 * private/loopback/link-local address it is rejected. This narrows (but cannot
 * fully eliminate) DNS-rebinding risk, because resolution here and the
 * browser's later resolution are separate events (TOCTOU) — documented honestly.
 */
export async function classifyReadUrl(
  raw: string,
  options: ReadUrlOptions = {},
): Promise<ReadUrlSafety> {
  const parsed = parseHttpUrl(raw);
  if (!(parsed instanceof URL)) {
    return { ok: false, reason: parsed };
  }

  const ok = { ok: true, url: parsed.toString() } as const;
  if (options.allowLoopback === true) {
    return ok;
  }

  const host = normalizeHost(parsed.hostname);
  if (isPrivateHost(host)) {
    return { ok: false, reason: 'PRIVATE_HOST' };
  }

  // Resolution-time check for DNS names (IP literals are already covered above).
  const isDnsName = !host.includes(':') && !isIpv4(host);
  const lookup = options.lookup ?? defaultLookup;
  if (isDnsName && (await resolvesToPrivateAddress(host, lookup))) {
    return { ok: false, reason: 'PRIVATE_ADDRESS' };
  }

  return ok;
}

async function resolvesToPrivateAddress(
  host: string,
  lookup: HostLookup,
): Promise<boolean> {
  try {
    const addresses = await lookup(host);

    return addresses.some(({ address }) => isPrivateHost(address));
  } catch {
    // Resolution failure is left to the browser to surface as a navigation
    // error; it is not itself a safety violation.
    return false;
  }
}

/**
 * Synchronous per-request guard for the browser's network interceptor. Applied
 * to every navigation redirect and subresource URL: only public http(s) is
 * allowed (loopback permitted solely under the bounded smoke exception).
 */
export function isAllowedRequestUrl(
  raw: string,
  options: { allowLoopback?: boolean } = {},
): boolean {
  const parsed = parseHttpUrl(raw);
  if (!(parsed instanceof URL)) {
    return false;
  }

  if (options.allowLoopback === true) {
    return true;
  }

  return !isPrivateHost(parsed.hostname);
}

/** Parse an absolute http(s) URL, or report why it is not one. */
function parseHttpUrl(raw: string): URL | 'INVALID_URL' | 'NON_HTTP' {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'INVALID_URL';
  }

  return isHttpUrl(raw) ? parsed : 'NON_HTTP';
}

/** Lower-case and strip a trailing root dot (`example.com.`). */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * True for hosts that must never be opened/fetched: loopback, link-local
 * (incl. the cloud metadata IP 169.254.169.254), private IPv4 ranges, IPv6
 * ULA/loopback/link-local, IPv4-mapped IPv6, and obvious local names.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host.length === 0) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }

  // IPv6 literal (URL hostname strips the surrounding brackets).
  if (host.includes(':')) {
    return isPrivateIpv6(host);
  }

  if (isIpv4(host)) {
    return isPrivateIpv4(host);
  }

  return false;
}

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata IP
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const addr = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (addr === '::1' || addr === '::') {
    return true;
  }

  // IPv4-mapped in dotted form (::ffff:a.b.c.d).
  const dotted = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (dotted && isIpv4(dotted[1])) {
    return isPrivateIpv4(dotted[1]);
  }

  // IPv4-mapped in normalized hex form (::ffff:c0a8:0101).
  const hex = /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isPrivateIpv4(ipv4);
  }

  const first = addr.split(':').find((group) => group.length > 0) ?? '';
  const group = parseInt(first, 16);
  if (Number.isNaN(group)) {
    return false;
  }

  if ((group & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((group & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}
