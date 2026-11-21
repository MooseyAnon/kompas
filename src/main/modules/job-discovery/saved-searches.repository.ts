import type { SqliteDatabase } from '../../core/db/connection';
import {
  savedSearchSchema,
  type JobDiscoveryConfigurationV1,
  type SavedSearch,
  type SavedSearchPage,
} from '../../../shared/contracts';

interface Row {
  id: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): SavedSearch {
  return savedSearchSchema.parse({
    id: row.id,
    config: JSON.parse(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class SavedSearchesRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): SavedSearch | null {
    const row = this.db
      .prepare(
        `SELECT * FROM job_saved_searches WHERE id = ? AND profile_id = 'local'`,
      )
      .get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(limit: number, cursor?: string): SavedSearchPage {
    const previous = cursor ? this.get(cursor) : null;
    if (cursor && !previous) return { items: [], nextCursor: null };

    const rows = this.db
      .prepare(
        'SELECT * FROM job_saved_searches\n' +
          "      WHERE profile_id = 'local' AND (? IS NULL OR created_at < ?" +
          ' OR (created_at = ? AND id < ?))\n' +
          '      ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(
        previous?.createdAt ?? null,
        previous?.createdAt ?? null,
        previous?.createdAt ?? null,
        cursor ?? null,
        limit + 1,
      ) as Row[];
    const items = rows.slice(0, limit).map(fromRow);

    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  insert(id: string, config: JobDiscoveryConfigurationV1, now: string): void {
    this.db
      .prepare(
        'INSERT INTO job_saved_searches' +
          ' (id, profile_id, config_json, created_at, updated_at)\n' +
          "      VALUES (?, 'local', ?, ?, ?)",
      )
      .run(id, JSON.stringify(config), now, now);
  }

  replace(id: string, config: JobDiscoveryConfigurationV1, now: string): void {
    this.db
      .prepare(`UPDATE job_saved_searches SET config_json = ?, updated_at = ?
      WHERE id = ? AND profile_id = 'local'`)
      .run(JSON.stringify(config), now, id);
  }
}
