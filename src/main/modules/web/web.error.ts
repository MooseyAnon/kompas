import type { ErrorCode } from '../../../shared/contracts';
import {
  DEFAULT_ERROR_MESSAGES,
  type SearchAttempt,
  type WebErrorCode,
} from '../../../shared/contracts';

/**
 * Error raised inside the trusted Web service/adapter layer. It carries a
 * detailed {@link WebErrorCode} for telemetry and a renderer-safe message.
 * Detailed codes stay in-process; only the narrow public {@link ErrorCode}
 * crosses the IPC boundary (see {@link toPublicErrorCode}).
 */
export class WebError extends Error {
  readonly code: WebErrorCode;
  readonly safeMessage: string;
  /** True when the resolver may fall back to the next capable adapter. */
  readonly retryable: boolean;
  /** Safe, content-free provenance of attempts made before failing. */
  attempts?: SearchAttempt[];

  constructor(
    code: WebErrorCode,
    options: { safeMessage?: string; retryable?: boolean } = {},
  ) {
    const message = options.safeMessage ?? defaultWebMessage(code);
    super(message);
    this.name = 'WebError';
    this.code = code;
    this.safeMessage = message;
    this.retryable = options.retryable ?? isRetryableByDefault(code);
  }
}

/** Type guard for errors raised inside the Web service/adapter layer. */
export function isWebError(value: unknown): value is WebError {
  return value instanceof WebError;
}

/**
 * Fallback is allowed only on provider availability problems and explicitly
 * retryable operational failures — never on invalid input, cancellation,
 * unsafe URLs, content limits or a valid empty result.
 */
export function isRetryableByDefault(code: WebErrorCode): boolean {
  switch (code) {
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_FAILURE':
    case 'RATE_LIMITED':
    // No supported browser is installed: let the resolver fall back to the next
    // capable search adapter (e.g. duck-duck-scrape). For a single-adapter
    // capability like `readPage` the resolver still surfaces this exact code as
    // the last retryable error, so the "no browser" message is preserved.
    case 'BROWSER_UNAVAILABLE':
      return true;
    default:
      // BROWSER_LAUNCH_FAILED / NAVIGATION_FAILED are definite failures of the
      // chosen engine; we never retry the same engine.
      return false;
  }
}

/** Map a detailed web error code to the narrow public IPC error vocabulary. */
export function toPublicErrorCode(code: WebErrorCode): ErrorCode {
  switch (code) {
    case 'INVALID_INPUT':
    case 'UNSAFE_URL':
      return 'INVALID_INPUT';
    case 'NO_CAPABLE_PROVIDER':
      return 'NOT_FOUND';
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_FAILURE':
    case 'RATE_LIMITED':
    case 'TIMEOUT':
    case 'QUEUE_FULL':
    case 'BROWSER_UNAVAILABLE':
    case 'BROWSER_LAUNCH_FAILED':
    case 'NAVIGATION_FAILED':
      return 'IO_ERROR';
    case 'CANCELLED':
    case 'CONTENT_LIMIT':
      return 'CONFLICT';
    case 'INTERNAL_ERROR':
    default:
      return 'INTERNAL';
  }
}

function defaultWebMessage(code: WebErrorCode): string {
  switch (code) {
    case 'INVALID_INPUT':
      return 'Please check the search query.';
    case 'UNSAFE_URL':
      return 'That address is not allowed.';
    case 'NO_CAPABLE_PROVIDER':
      return 'No search provider is available.';
    case 'PROVIDER_UNAVAILABLE':
      return 'The search provider is currently unavailable.';
    case 'PROVIDER_FAILURE':
      return 'The search provider could not complete the request.';
    case 'RATE_LIMITED':
      return 'The search provider is rate limiting requests. Please try again.';
    case 'TIMEOUT':
      return 'The search timed out. Please try again.';
    case 'QUEUE_FULL':
      return 'The search queue is full. Please try again later.';
    case 'CANCELLED':
      return 'The search was cancelled.';
    case 'CONTENT_LIMIT':
      return 'The response was too large to process.';
    case 'BROWSER_UNAVAILABLE':
      return (
        'No supported browser (Chrome or Edge) was found on this ' + 'computer.'
      );
    case 'BROWSER_LAUNCH_FAILED':
      return 'The installed browser could not be started to read the page.';
    case 'NAVIGATION_FAILED':
      return (
        'The page could not be loaded. It may be unavailable or blocking ' +
        'automated access.'
      );
    case 'INTERNAL_ERROR':
    default:
      return DEFAULT_ERROR_MESSAGES.INTERNAL;
  }
}
