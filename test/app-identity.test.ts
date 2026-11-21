import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preserveStorageIdentity } from '../src/main/core/app-identity';
import { resolveDataDir } from '../src/main/core/paths';
import { openStorage } from '../src/main/core/storage';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('branding storage compatibility', () => {
  it('creates the pinned directory before Electron sets a fresh-install path', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'kompas-fresh-'));
    temporary.push(appData);
    preserveStorageIdentity({
      commandLine: { hasSwitch: () => false },
      getPath: () => appData,
      setPath: (key, directory) => {
        expect(key).toBe('userData');
        expect(directory).toBe(path.join(appData, 'Kompas'));
        expect(fs.statSync(directory).isDirectory()).toBe(true);
      },
    });
    const storage = openStorage(path.join(appData, 'Kompas'));
    try {
      expect(
        storage.db
          .prepare(
            "SELECT value_json FROM settings WHERE key = 'onboarding.completed'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      storage.db.close();
    }
  });

  it('reopens the prior productName profile and managed files without a new profile', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'kompas-identity-'));
    temporary.push(appData);
    // Baseline package metadata already used productName=Kompas even though
    // the old Forge executable was named Career Workspace.
    const oldDirectory = path.join(appData, 'Kompas');
    const original = openStorage(oldDirectory);
    original.db
      .prepare("UPDATE profiles SET display_name = 'Sample' WHERE id = 'local'")
      .run();
    const managed = path.join(
      original.layout.documentsOriginalsDir,
      'sample.pdf',
    );
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, 'sample managed file');
    original.db.close();

    let selected = path.join(appData, 'Future Display Name');
    preserveStorageIdentity({
      commandLine: { hasSwitch: () => false },
      getPath: () => appData,
      setPath: (_key, value) => {
        selected = value;
      },
    });
    const reopened = openStorage(resolveDataDir(selected, true));
    try {
      expect(
        reopened.db.prepare('SELECT display_name FROM profiles').get(),
      ).toEqual({ display_name: 'Sample' });
      expect(fs.readFileSync(managed, 'utf8')).toBe('sample managed file');
      expect(fs.readdirSync(appData)).toEqual(['Kompas']);
      expect(resolveDataDir(selected, false)).toBe(`${oldDirectory} (dev)`);
    } finally {
      reopened.db.close();
    }
  });

  it('preserves an explicitly selected disposable profile', () => {
    const setPath = vi.fn();
    preserveStorageIdentity({
      commandLine: { hasSwitch: () => true },
      getPath: vi.fn(),
      setPath,
    });
    expect(setPath).not.toHaveBeenCalled();
  });
});
