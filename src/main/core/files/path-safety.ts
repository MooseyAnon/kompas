import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../ipc/errors';

/**
 * Normalise a caller-supplied relative path, rejecting absolute paths and any
 * parent-directory (`..`) traversal. Returns a clean relative path or throws.
 */
export function normaliseRelativePath(relative: string): string {
  if (typeof relative !== 'string' || relative.trim().length === 0) {
    throw new AppError('INVALID_INPUT', 'A managed file path is required.');
  }

  if (relative.includes('\0')) {
    throw new AppError('INVALID_INPUT', 'Invalid managed file path.');
  }

  if (path.isAbsolute(relative)) {
    throw new AppError('INVALID_INPUT', 'Absolute paths are not permitted.');
  }

  const normalised = path.normalize(relative);
  const segments = normalised.split(/[\\/]/);

  if (segments.some((segment) => segment === '..')) {
    throw new AppError('INVALID_INPUT', 'Path traversal is not permitted.');
  }

  return normalised;
}

/**
 * Resolve a relative path inside `root`, guaranteeing the result stays within
 * the root boundary (lexical containment). Throws on any escape.
 */
export function resolveWithinRoot(root: string, relative: string): string {
  const safeRelative = normaliseRelativePath(relative);
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, safeRelative);

  if (
    resolved !== rootResolved &&
    !resolved.startsWith(rootResolved + path.sep)
  ) {
    throw new AppError(
      'INVALID_INPUT',
      'Resolved path escapes the managed directory.',
    );
  }

  return resolved;
}

/**
 * Guard against symlink escapes: resolve the real path of the deepest existing
 * ancestor of `target` and confirm it is still contained within `root`. This
 * catches a symlinked directory or file that would otherwise redirect reads or
 * writes outside the managed store.
 */
export function assertNoSymlinkEscape(root: string, target: string): void {
  const rootReal = fs.realpathSync(root);
  let current = path.resolve(target);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  const currentReal = fs.realpathSync(current);

  if (
    currentReal !== rootReal &&
    !currentReal.startsWith(rootReal + path.sep)
  ) {
    throw new AppError(
      'INVALID_INPUT',
      'Resolved path escapes the managed directory via a symbolic link.',
    );
  }
}
