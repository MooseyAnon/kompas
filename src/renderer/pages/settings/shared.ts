import { ApiError } from '../../api';

export function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? `${error.message} (${error.code})`
    : fallback;
}

export function sizeText(bytes: number | null | undefined): string {
  if (bytes == null) return 'Unknown';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
