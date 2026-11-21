import {
  INFERENCE_SETTINGS_KEY,
  inferenceSettingsSchema,
  type InferenceSettings,
} from '../../../shared/contracts';
import type { SqliteDatabase } from '../../core/db/connection';

interface SettingsRow {
  value_json: string;
}

/**
 * Domain-owned persistence for the single local-only inference preference blob.
 * Owns all SQL for its `inference.preferences` key in the shared `settings`
 * table; no raw database handle leaves this module. Values are JSON text and
 * contain only non-secret, validated primitives. A malformed stored value is
 * treated as "no saved preference" rather than crashing or being silently
 * rewritten.
 */
export class InferenceSettingsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** Read and validate the stored settings, or null when none/invalid. */
  read(): InferenceSettings | null {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(INFERENCE_SETTINGS_KEY) as SettingsRow | undefined;
    if (!row) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      return null;
    }

    const result = inferenceSettingsSchema.safeParse(parsed);

    return result.success ? result.data : null;
  }

  /** Validate and upsert the settings blob. */
  write(settings: InferenceSettings): void {
    const value = inferenceSettingsSchema.parse(settings);

    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (@key, @valueJson, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        key: INFERENCE_SETTINGS_KEY,
        valueJson: JSON.stringify(value),
        updatedAt: value.updatedAt,
      });
  }
}
