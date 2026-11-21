import {
  SYSTEM_API_VERSION,
  type SystemPingOutput,
} from '../../../shared/contracts';
import type { SqliteDatabase } from '../../core/db/connection';
import { AppError } from '../../ipc/errors';

export interface SystemServiceDeps {
  getAppVersion: () => string;
  isStorageReady: () => boolean;
  db?: SqliteDatabase;
}

/**
 * In-process `system` domain service. Same-process callers use this typed
 * interface directly; the IPC layer maps its output to the wire schema.
 */
export class SystemService {
  constructor(private readonly deps: SystemServiceDeps) {}

  ping(): SystemPingOutput {
    return {
      appVersion: this.deps.getAppVersion(),
      apiVersion: SYSTEM_API_VERSION,
      storageReady: this.deps.isStorageReady(),
    };
  }

  onboardingStatus(): { completed: boolean } {
    if (!this.deps.db)
      throw new AppError(
        'IO_ERROR',
        'Local storage is unavailable. Try again.',
      );
    const row = this.deps.db
      .prepare(
        "SELECT value_json FROM settings WHERE key = 'onboarding.completed'",
      )
      .get() as { value_json: string } | undefined;
    if (row && row.value_json !== 'true')
      throw new AppError(
        'IO_ERROR',
        'Onboarding status is unavailable. Try again.',
      );
    return { completed: !!row };
  }

  completeOnboarding(): { completed: boolean } {
    if (!this.deps.db)
      throw new AppError(
        'IO_ERROR',
        'Local storage is unavailable. Try again.',
      );
    this.deps.db
      .prepare(`INSERT INTO settings (key, value_json, updated_at)
      VALUES ('onboarding.completed', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = 'true', updated_at = excluded.updated_at`)
      .run(new Date().toISOString());
    return { completed: true };
  }
}
