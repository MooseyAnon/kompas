/** Internal helpers shared by the identity service and repository. */

/** True when `key` is explicitly present on a patch (even if undefined). */
export function has<T extends object>(obj: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Patch-merge one column: the patched value when the key is present,
 * otherwise the existing column value.
 */
export function pick<T extends object, K extends keyof T, V>(
  changes: T,
  key: K,
  patched: (value: T[K]) => V,
  existing: V,
): V {
  return has(changes, key) ? patched(changes[key]) : existing;
}

/** A trimmed-but-empty optional/nullable text value clears the column. */
export function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value.length === 0 ? null : value;
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}
