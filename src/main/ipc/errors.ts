import { DEFAULT_ERROR_MESSAGES, type ErrorCode } from '../../shared/contracts';

/**
 * Domain/boundary error carrying a stable machine-readable code and a message
 * that is safe to show the renderer (no stack traces, paths, SQL or user text).
 */
export class AppError extends Error {
  readonly code: ErrorCode;

  readonly safeMessage: string;

  constructor(code: ErrorCode, safeMessage?: string) {
    const message = safeMessage ?? DEFAULT_ERROR_MESSAGES[code];

    super(message);

    this.name = 'AppError';
    this.code = code;
    this.safeMessage = message;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
