import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/main/core/storage';
import {
  finishPendingReset,
  requestStorageReset,
  storageUsage,
  validateResetTargets,
} from '../src/main/core/storage-maintenance';
import { createAppDispatcher } from '../src/main/core/registry';

const roots: string[] = [];
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-reset-test-'));
  roots.push(parent);
  const data = path.join(parent, 'application');
  const external = path.join(parent, 'external-ollama-and-chrome');
  fs.mkdirSync(data);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'personal'), 'keep');
  return { data, external };
}
afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('application-owned storage maintenance', () => {
  it('measures nonoverlapping files, DB sidecars, missing directories, and refreshed sizes', () => {
    const { data } = fixture();
    expect(storageUsage(data).totalBytes).toBe(0);
    fs.writeFileSync(path.join(data, 'app.sqlite'), 'db');
    fs.writeFileSync(path.join(data, 'app.sqlite-wal'), 'wal!');
    fs.writeFileSync(path.join(data, 'app.sqlite-shm'), 'shm');
    for (const [category, folder] of [
      ['documents', 'originals'],
      ['audio', 'originals'],
      ['logs', ''],
      ['Cache', ''],
      ['Session Storage', ''],
    ]) {
      const target = path.join(data, category, folder);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'item'), '12345');
    }
    const usage = storageUsage(data);
    expect(usage.categories.map(({ bytes }) => bytes)).toEqual([
      9, 5, 5, 5, 5, 5,
    ]);
    expect(usage.totalBytes).toBe(34);
    fs.appendFileSync(path.join(data, 'audio', 'originals', 'item'), 'more');
    expect(storageUsage(data).totalBytes).toBe(38);
  });

  it('refuses symlinks and marks unsafe inventory as partial, never traversing external files', () => {
    const { data, external } = fixture();
    fs.symlinkSync(external, path.join(data, 'documents'));
    expect(storageUsage(data).partial).toBe(true);
    expect(storageUsage(data).totalBytes).toBeNull();
    expect(() => validateResetTargets(data)).toThrow();
    expect(() => requestStorageReset(data)).toThrow();
    expect(fs.readFileSync(path.join(external, 'personal'), 'utf8')).toBe(
      'keep',
    );
  });

  it('marks a permission-denied category unknown and refuses reset without removing other data', () => {
    const { data } = fixture();
    const logs = path.join(data, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'app.jsonl'), 'private');
    fs.writeFileSync(path.join(data, 'app.sqlite'), 'untouched');
    fs.chmodSync(logs, 0o000);
    try {
      if (process.getuid?.() !== 0) {
        const usage = storageUsage(data);
        expect(
          usage.categories.find(({ category }) => category === 'logs')?.bytes,
        ).toBeNull();
        expect(usage.totalBytes).toBeNull();
        expect(() => requestStorageReset(data)).toThrow();
        expect(fs.readFileSync(path.join(data, 'app.sqlite'), 'utf8')).toBe(
          'untouched',
        );
      }
    } finally {
      fs.chmodSync(logs, 0o700);
    }
  });

  it('recovers an interrupted reset on next launch, removing only owned data and recreating the current schema', () => {
    const { data, external } = fixture();
    const storage = openStorage(data);
    storage.db
      .prepare("UPDATE profiles SET display_name = 'Before' WHERE id = 'local'")
      .run();
    storage.db
      .prepare(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('sample', '{}', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    fs.writeFileSync(path.join(data, 'documents', 'originals', 'copy'), 'CV');
    fs.writeFileSync(path.join(data, 'audio', 'originals', 'clip'), 'WAV');
    fs.writeFileSync(path.join(data, 'logs', 'app.jsonl'), '{}');
    fs.mkdirSync(path.join(data, 'Cache'));
    fs.writeFileSync(path.join(data, 'Cache', 'cached'), 'x');
    requestStorageReset(data);
    storage.close();
    expect(finishPendingReset(data)).toBe(true);
    expect(finishPendingReset(data)).toBe(false);
    const fresh = openStorage(data);
    expect(
      fresh.db
        .prepare("SELECT display_name FROM profiles WHERE id = 'local'")
        .get(),
    ).toEqual({ display_name: '' });
    expect(
      fresh.db.prepare('SELECT count(*) AS count FROM settings').get(),
    ).toEqual({ count: 0 });
    expect(fresh.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      fs.existsSync(path.join(data, 'documents', 'originals', 'copy')),
    ).toBe(false);
    expect(fs.existsSync(path.join(data, 'Cache', 'cached'))).toBe(false);
    expect(fs.readFileSync(path.join(external, 'personal'), 'utf8')).toBe(
      'keep',
    );
    fresh.close();
  });

  it('keeps the pending marker and existing data on unsafe cleanup, then retries safely', () => {
    const { data, external } = fixture();
    fs.writeFileSync(path.join(data, 'app.sqlite'), 'old data');
    requestStorageReset(data);
    fs.symlinkSync(external, path.join(data, 'audio'));
    expect(() => finishPendingReset(data)).toThrow();
    expect(fs.readFileSync(path.join(data, 'app.sqlite'), 'utf8')).toBe(
      'old data',
    );
    expect(fs.existsSync(path.join(data, '.career-reset-pending'))).toBe(true);
    fs.unlinkSync(path.join(data, 'audio'));
    expect(finishPendingReset(data)).toBe(true);
    expect(fs.existsSync(path.join(data, 'app.sqlite'))).toBe(false);
    expect(fs.readFileSync(path.join(external, 'personal'), 'utf8')).toBe(
      'keep',
    );
  });

  it('requires a narrow validated command and rejects reentrant reset', async () => {
    const { data } = fixture();
    let invoked = 0;
    const dispatcher = createAppDispatcher({
      getAppVersion: () => '1',
      isStorageReady: () => true,
      maintenance: {
        dataDir: data,
        reset: async () => {
          invoked++;
          requestStorageReset(data);
        },
        registerBusy: () => {},
      },
    });
    const send = (payload: unknown, action = 'reset.start') =>
      dispatcher.dispatch({
        requestId: crypto.randomUUID(),
        module: 'storage',
        version: 1,
        action,
        payload,
      });
    expect(
      (
        await send({
          confirmation: 'DELETE ALL APPLICATION DATA',
          path: '/tmp',
        })
      ).ok,
    ).toBe(false);
    expect((await send({ confirmation: 'wrong' })).ok).toBe(false);
    expect((await send({}, 'usage.get')).ok).toBe(true);
    expect(
      (await send({ confirmation: 'DELETE ALL APPLICATION DATA' })).ok,
    ).toBe(true);
    expect(
      (await send({ confirmation: 'DELETE ALL APPLICATION DATA' })).ok,
    ).toBe(false);
    expect(invoked).toBe(2);
  });
});
