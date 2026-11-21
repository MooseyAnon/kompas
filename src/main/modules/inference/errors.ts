import type { ErrorCode } from '../../../shared/contracts';
import type { InferenceErrorCode } from '../../../shared/contracts';

/**
 * Map a detailed internal inference error code to the narrow public IPC error
 * vocabulary. Detailed codes stay inside trusted service interfaces; only safe
 * codes/messages ever cross the renderer boundary.
 */
export function toPublicErrorCode(code: InferenceErrorCode): ErrorCode {
  switch (code) {
    case 'MODEL_NOT_FOUND':
      return 'NOT_FOUND';
    case 'INVALID_RESPONSE':
    case 'INVALID_SCHEMA':
    case 'TOOL_INVALID_ARGUMENTS':
      return 'INVALID_INPUT';
    case 'PROVIDER_UNAVAILABLE':
    case 'WORKER_EXITED':
    case 'WORKER_UNAVAILABLE':
    case 'TIMEOUT':
    case 'TOOL_TIMEOUT':
      return 'IO_ERROR';
    case 'CAPABILITY_UNSUPPORTED':
    case 'OVER_CAPACITY':
    case 'RETRIES_EXHAUSTED':
    case 'CANCELLED':
    case 'LIMIT_EXCEEDED':
    case 'TOOL_FAILED':
      return 'CONFLICT';
    case 'TOOL_NOT_ALLOWED':
      return 'PERMISSION_DENIED';
    case 'INTERNAL':
    default:
      return 'INTERNAL';
  }
}
