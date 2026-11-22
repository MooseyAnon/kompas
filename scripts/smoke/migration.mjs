import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { call, REPO_ROOT } from './harness.mjs';

const V9_MIGRATIONS = [
  '001_init',
  '005_interviews',
  '007_interview_coaching',
  '008_audio',
  '009_transcription',
  '010_interview_voice',
  '011_cv_imports',
  '012_profile_import_apply',
  '012_applications',
];

function seedOlderDatabase(file) {
  const db = new Database(file);
  const ids = {
    application: crypto.randomUUID(),
    stage: crypto.randomUUID(),
    interview: crypto.randomUUID(),
  };

  try {
    db.pragma('foreign_keys = ON');
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );

    for (const [index, name] of V9_MIGRATIONS.entries()) {
      db.exec(
        fs.readFileSync(
          path.join(REPO_ROOT, 'migrations', `${name}.sql`),
          'utf8',
        ),
      );
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(
        index + 1,
        new Date().toISOString(),
      );
    }

    const at = new Date().toISOString();
    db.prepare(
      "INSERT INTO profiles (id,display_name,created_at,updated_at) VALUES ('local','Upgrade fixture',?,?)",
    ).run(at, at);
    db.prepare(
      "INSERT INTO job_applications (id,profile_id,company_name,role_title,created_at,updated_at) VALUES (?,'local','Fixture company','Fixture role',?,?)",
    ).run(ids.application, at, at);
    db.prepare(
      "INSERT INTO application_stage_events (id,application_id,stage_label,stage_kind,occurred_at,recorded_at,source) VALUES (?,?,'Saved','saved',?,?,'user')",
    ).run(ids.stage, ids.application, at, at);
    db.prepare(
      'UPDATE job_applications SET current_stage_event_id=? WHERE id=?',
    ).run(ids.stage, ids.application);
    db.prepare(
      "INSERT INTO interview_sessions (id,profile_id,method,subject,status,created_at,updated_at) VALUES (?,'local','deep_loop','Upgrade fixture','draft',?,?)",
    ).run(ids.interview, at, at);
  } finally {
    db.close();
  }

  return ids;
}

export async function migrationSmoke(harness) {
  const backup = harness.temporaryDirectory('upgrade-backup');
  const backupFile = path.join(backup, 'app.sqlite');
  const ids = seedOlderDatabase(backupFile);
  fs.mkdirSync(path.join(backup, 'documents', 'originals'), {
    recursive: true,
  });
  const document = path.join('documents', 'originals', 'preserved.pdf');
  fs.writeFileSync(path.join(backup, document), 'synthetic migration sentinel');
  const originalDigest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(backupFile))
    .digest('hex');
  const profile = harness.temporaryDirectory('upgrade');
  // Upgrade a full copy; the quit-state pre-migration backup stays unchanged.
  fs.cpSync(backup, profile, { recursive: true });
  const file = path.join(profile, 'app.sqlite');
  let session = await harness.launch({ profile, onboarding: true });
  await session.page.getByTestId('page-home').waitFor();
  const { item } = await call(session.page, 'applications', 'get', {
    id: ids.application,
  });
  assert.equal(item.application.companyName, 'Fixture company');
  assert.equal(item.application.currentStage.stageKind, 'saved');
  const { session: interview } = await call(
    session.page,
    'interviews',
    'sessions.get',
    { id: ids.interview },
  );
  assert.equal(interview.subject, 'Upgrade fixture');
  assert.equal(interview.status, 'draft');
  assert.equal(interview.additionalGuidance, null);
  assert.equal(
    (await call(session.page, 'identity', 'profile.get')).profile.displayName,
    'Upgrade fixture',
  );
  await call(session.page, 'jobDiscovery', 'savedSearches.list');
  await harness.stop(session);
  session = await harness.launch({ profile, onboarding: true });
  await session.page.getByTestId('page-home').waitFor();
  assert.equal(
    (await call(session.page, 'applications', 'get', { id: ids.application }))
      .item.application.companyName,
    'Fixture company',
  );
  await harness.stop(session);
  assert.equal(
    fs.readFileSync(path.join(profile, document), 'utf8'),
    'synthetic migration sentinel',
  );
  assert.equal(
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(backupFile))
      .digest('hex'),
    originalDigest,
    'Pre-upgrade backup was modified',
  );
  const upgraded = new Database(file, { readonly: true });

  try {
    assert.ok(
      upgraded.prepare('SELECT max(version) AS v FROM schema_migrations').get()
        .v > V9_MIGRATIONS.length,
    );
    assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
    assert.equal(upgraded.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    upgraded.close();
  }
}
