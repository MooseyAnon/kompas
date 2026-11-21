import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNoSymlinkEscape,
  normaliseRelativePath,
  resolveWithinRoot,
} from '../src/main/core/files/path-safety';
import { FileStore } from '../src/main/core/files/file-store';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-files-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('normaliseRelativePath', () => {
  it('accepts a plain nested relative path', () => {
    expect(normaliseRelativePath('a/b/c.pdf')).toBe(
      path.normalize('a/b/c.pdf'),
    );
  });

  it('rejects parent-directory traversal', () => {
    expect(() => normaliseRelativePath('../escape.txt')).toThrow();
    expect(() => normaliseRelativePath('a/../../escape.txt')).toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => normaliseRelativePath('/etc/passwd')).toThrow();
  });

  it('rejects empty and null-byte paths', () => {
    expect(() => normaliseRelativePath('')).toThrow();
    expect(() => normaliseRelativePath('a\0b')).toThrow();
  });
});

describe('resolveWithinRoot', () => {
  it('resolves inside the root', () => {
    const root = path.join(workDir, 'store');
    expect(resolveWithinRoot(root, 'docs/a.pdf')).toBe(
      path.join(root, 'docs/a.pdf'),
    );
  });

  it('rejects escapes even when they normalise outside the root', () => {
    const root = path.join(workDir, 'store');
    expect(() => resolveWithinRoot(root, '../outside.txt')).toThrow();
  });
});

describe('assertNoSymlinkEscape', () => {
  it('allows a normal path inside the root', () => {
    const root = path.join(workDir, 'store');
    fs.mkdirSync(root, { recursive: true });
    expect(() =>
      assertNoSymlinkEscape(root, path.join(root, 'file.txt')),
    ).not.toThrow();
  });

  it('rejects a symlinked directory that escapes the root', () => {
    const root = path.join(workDir, 'store');
    const outside = path.join(workDir, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'link'));

    expect(() =>
      assertNoSymlinkEscape(root, path.join(root, 'link', 'evil.txt')),
    ).toThrow();
  });
});

describe('FileStore', () => {
  function makeStore(): FileStore {
    const root = path.join(workDir, 'originals');
    const temp = path.join(workDir, 'tmp');
    return new FileStore(root, temp);
  }

  it('resolve rejects traversal', () => {
    const store = makeStore();
    expect(() => store.resolve('../../etc/passwd')).toThrow();
  });

  it('imports a file, computing sha256 and size, and stores the content', async () => {
    const store = makeStore();
    const source = path.join(workDir, 'source.txt');
    fs.writeFileSync(source, 'hello world');

    const relative = store.newRelativePath('txt');
    const result = await store.importFromPath(source, relative);

    expect(result.sizeBytes).toBe(Buffer.byteLength('hello world'));
    // sha256("hello world")
    expect(result.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(store.exists(relative)).toBe(true);
    const stored = fs.readFileSync(store.resolve(relative), 'utf8');
    expect(stored).toBe('hello world');
  });

  it('importFromPath rejects a traversal destination and leaves no temp files', async () => {
    const store = makeStore();
    const source = path.join(workDir, 'source.txt');
    fs.writeFileSync(source, 'data');

    await expect(
      store.importFromPath(source, '../escape.txt'),
    ).rejects.toThrow();

    const tempEntries = fs.readdirSync(path.join(workDir, 'tmp'));
    expect(tempEntries).toHaveLength(0);
  });

  it('remove treats a missing file as already removed', () => {
    const store = makeStore();
    const relative = store.newRelativePath('txt');
    expect(() => store.remove(relative)).not.toThrow();
  });

  it('cleanupTempFiles removes stale staged files', () => {
    const store = makeStore();
    const tempDir = path.join(workDir, 'tmp');
    const stale = path.join(tempDir, 'stale.part');
    fs.writeFileSync(stale, 'x');
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, oldTime, oldTime);

    const removed = store.cleanupTempFiles();
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
