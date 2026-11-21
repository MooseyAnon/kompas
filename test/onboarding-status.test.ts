import { describe, expect, it } from 'vitest';
import { openConnection } from '../src/main/core/db/connection';
import { runMigrations } from '../src/main/core/db/migrator';
import { MIGRATIONS } from '../src/main/core/db/migrations';
import { seedLocalProfile } from '../src/main/core/db/database';
import { SystemService } from '../src/main/modules/system/system.service';

function beforeOnboarding() {
  const db = openConnection(':memory:', { wal: false });
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version < 22),
  );
  seedLocalProfile(db);
  return db;
}

describe('onboarding upgrade and completion', () => {
  it('does not count a seeded profile or technical records as use', () => {
    const db = beforeOnboarding();
    try {
      db.prepare(`INSERT INTO operation_runs (id,module_id,operation,outcome,started_at,finished_at,duration_ms)
        VALUES ('one','system','boot','success','now','now',1)`).run();
      runMigrations(db);
      const service = new SystemService({
        getAppVersion: () => '1',
        isStorageReady: () => true,
        db,
      });
      expect(service.onboardingStatus()).toEqual({ completed: false });
      expect(service.onboardingStatus()).toEqual({ completed: false });
      expect(service.completeOnboarding()).toEqual({ completed: true });
      expect(service.completeOnboarding()).toEqual({ completed: true });
      expect(service.onboardingStatus()).toEqual({ completed: true });
    } finally {
      db.close();
    }
  });

  it('classifies a used installation once and never reclassifies on later edits', () => {
    const db = beforeOnboarding();
    try {
      db.prepare(
        "INSERT INTO career_targets (id,profile_id,role_title,created_at,updated_at) VALUES ('t','local','Writer','now','now')",
      ).run();
      runMigrations(db);
      const service = new SystemService({
        getAppVersion: () => '1',
        isStorageReady: () => true,
        db,
      });
      expect(service.onboardingStatus()).toEqual({ completed: true });
      db.prepare("DELETE FROM career_targets WHERE id='t'").run();
      expect(service.onboardingStatus()).toEqual({ completed: true });
      expect(runMigrations(db).appliedVersions).toEqual([]);
    } finally {
      db.close();
    }
  });
});
