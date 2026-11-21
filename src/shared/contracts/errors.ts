import { z } from 'zod';

/**
 * Stable, machine-readable error codes for the IPC boundary.
 * Messages shown to the renderer must be safe and free of stack traces,
 * file paths, SQL or user content.
 */
export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'CONFLICT',
  'VERSION_UNSUPPORTED',
  'PERMISSION_DENIED',
  'IO_ERROR',
  'INTERNAL',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorPayloadSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  correlationId: z.string().min(1),
});

export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

/** Default safe messages keyed by code; never leak internal details. */
export const DEFAULT_ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Please check the entered fields.',
  NOT_FOUND: 'The requested item could not be found.',
  CONFLICT: 'That operation conflicts with the current state.',
  VERSION_UNSUPPORTED: 'This request version is not supported.',
  PERMISSION_DENIED: 'This action is not permitted.',
  IO_ERROR: 'A local storage operation failed.',
  INTERNAL: 'Something went wrong. Please try again.',
};
