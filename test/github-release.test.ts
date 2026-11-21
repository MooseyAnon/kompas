import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateReleaseSource } from '../scripts/release-guard.mjs';
import {
  auditContent,
  checksumManifest,
  distributables,
  verifyManifest,
} from '../scripts/release-artifacts.mjs';
import { reusableDraft } from '../scripts/draft-release.mjs';

const commit = 'a'.repeat(40);
const environment = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/tags/v0.1.0',
  GITHUB_REPOSITORY: 'example/kompas',
  KOMPAS_RELEASE_REPOSITORY: 'example/kompas',
  KOMPAS_RELEASE_COMMIT: commit,
};
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('release source authority', () => {
  it('accepts the matching owner-authorised stable release', () => {
    expect(
      validateReleaseSource(environment, '0.1.0', commit, commit, true),
    ).toBe('v0.1.0');
  });

  it.each(['v01.1.0', 'v0.1.0-beta.1', '0.1.0', 'v0.1.0;touch x', 'v1.0'])(
    'rejects malformed or unstable tag %s',
    (tag) => {
      expect(() =>
        validateReleaseSource(
          { ...environment, GITHUB_REF: `refs/tags/${tag}` },
          '0.1.0',
          commit,
          commit,
          true,
        ),
      ).toThrow();
    },
  );

  it('rejects version mismatch, dispatch, fork, unapproved or off-main source', () => {
    expect(() =>
      validateReleaseSource(environment, '0.1.1', commit, commit, true),
    ).toThrow('mismatch');
    for (const override of [
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
      { GITHUB_REPOSITORY: 'fork/kompas' },
      { KOMPAS_RELEASE_REPOSITORY: '' },
      { KOMPAS_RELEASE_COMMIT: 'b'.repeat(40) },
    ]) {
      expect(() =>
        validateReleaseSource(
          { ...environment, ...override },
          '0.1.0',
          commit,
          commit,
          true,
        ),
      ).toThrow();
    }
    expect(() =>
      validateReleaseSource(environment, '0.1.0', commit, 'b'.repeat(40), true),
    ).toThrow('authorised');
    expect(() =>
      validateReleaseSource(environment, '0.1.0', commit, commit, false),
    ).toThrow('authorised');
  });
});

describe('distributable integrity', () => {
  it('matches Forge 8 outputs and public update-service naming', () => {
    expect(distributables('0.1.0')).toEqual([
      'out/make/dmg/arm64/Kompas-0.1.0-mac-arm64.dmg',
      'out/make/zip/darwin/arm64/Kompas-0.1.0-mac-arm64.zip',
    ]);
    expect(() => distributables('../x')).toThrow();
  });

  it('hashes only the DMG/ZIP and detects tampering, missing and empty files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
    temporary.push(directory);
    const files = distributables('0.1.0').map((file) =>
      path.join(directory, path.basename(file)),
    );
    expect(() => checksumManifest(files)).toThrow();
    fs.writeFileSync(files[0], 'dmg');
    fs.writeFileSync(files[1], 'zip');
    const manifest = checksumManifest(files);
    expect(manifest).not.toContain('SHA256SUMS');
    expect(() => verifyManifest(directory, manifest)).not.toThrow();
    expect(() =>
      verifyManifest(directory, manifest.split('\n')[0] + '\n'),
    ).toThrow();
    fs.writeFileSync(files[1], 'tampered');
    expect(() => verifyManifest(directory, manifest)).toThrow('mismatch');
    fs.writeFileSync(files[1], '');
    expect(() => checksumManifest(files)).toThrow('empty');
  });

  it('rejects private packs, credentials, repository docs and own source maps', () => {
    for (const name of [
      '.ignore_fs/x',
      'docs/SDD.md',
      '.env',
      'key.p12',
      '.vite/build/main.cjs.map',
    ]) {
      expect(() => auditContent(name, Buffer.alloc(0))).toThrow();
    }
    expect(() =>
      auditContent('main.cjs', Buffer.from('-----BEGIN PRIVATE KEY-----')),
    ).toThrow();
    expect(() =>
      auditContent('main.cjs', Buffer.from('/private/.ignore_fs/prompts/')),
    ).toThrow();
    expect(() =>
      auditContent('.vite/build/main.cjs', Buffer.from('public code')),
    ).not.toThrow();
  });
});

describe('draft-only reruns', () => {
  const draft = { tag_name: 'v0.1.0', draft: true, target_commitish: commit };
  it('reuses only the existing matching tag draft', () => {
    expect(reusableDraft([], 'v0.1.0', commit)).toBeUndefined();
    expect(reusableDraft([draft], 'v0.1.0', commit)).toEqual(draft);
    expect(() => reusableDraft([draft, draft], 'v0.1.0', commit)).toThrow();
    expect(() =>
      reusableDraft([{ ...draft, draft: false }], 'v0.1.0', commit),
    ).toThrow('published');
    expect(() => reusableDraft([draft], 'v0.1.0', 'b'.repeat(40))).toThrow(
      'differently targeted',
    );
  });
});

it('redacts credential command failures and cleans up even if restore fails', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-test-'));
  temporary.push(directory);
  const trace = path.join(directory, 'trace');
  const security = path.join(directory, 'security');
  fs.writeFileSync(
    security,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, args[0] + '\\n');
if (args[0] === 'list-keychains' && !args.includes('-s')) {
  console.log('"/test/login.keychain-db"');
}
if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'fake');
if (args[0] === 'import') {
  console.error('private-certificate-password');
  process.exit(1);
}
if (args[0] === 'list-keychains' && args.includes('-s')) process.exit(1);
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: directory,
    KOMPAS_CERTIFICATE_P12_BASE64: Buffer.from('fake-p12').toString('base64'),
    KOMPAS_CERTIFICATE_PASSWORD: 'private-certificate-password',
    KOMPAS_SIGN_IDENTITY: 'Developer ID Application: fixture',
    KOMPAS_APPLE_ID: 'fixture',
    KOMPAS_APPLE_PASSWORD: 'fixture',
    KOMPAS_APPLE_TEAM_ID: 'fixture',
  };
  const script = path.resolve('scripts/release-keychain.mjs');
  const setup = spawnSync(process.execPath, [script, 'setup'], {
    env,
    encoding: 'utf8',
  });
  expect(setup.status).toBe(1);
  expect(setup.stderr).toContain('credential setup/cleanup failed');
  expect(setup.stderr).not.toContain('private-certificate-password');
  const cleanup = spawnSync(process.execPath, [script, 'cleanup'], {
    env,
    encoding: 'utf8',
  });
  expect(cleanup.status).toBe(1); // restoration failure is still reported
  expect(fs.readFileSync(trace, 'utf8')).toContain('delete-keychain');
  expect(fs.existsSync(path.join(directory, 'kompas-signing'))).toBe(false);
});
