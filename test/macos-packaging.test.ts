import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  signingConfig,
  verifyAppleArtifact,
  verifyInstalledAppleApp,
} from '../scripts/macos-packaging';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockReturnValue(Buffer.alloc(0));
});

describe('macOS release signing gate', () => {
  it('leaves ordinary developer packaging unsigned even with credentials present', () => {
    expect(
      signingConfig({
        KOMPAS_SIGN_IDENTITY: 'Developer ID Application: test',
        KOMPAS_NOTARY_PROFILE: 'test',
      }),
    ).toEqual({});
  });

  it('rejects missing signing or notarisation credentials before building', () => {
    expect(() => signingConfig({ KOMPAS_RELEASE: '1' })).toThrow(
      'requires KOMPAS_SIGN_IDENTITY',
    );
    expect(() =>
      signingConfig({
        KOMPAS_RELEASE: '1',
        KOMPAS_SIGN_IDENTITY: 'Developer ID Application: test',
      }),
    ).toThrow('requires KOMPAS_NOTARY_PROFILE');
  });

  it('rejects ad-hoc signing and invalid mode values', () => {
    expect(() =>
      signingConfig({
        KOMPAS_RELEASE: '1',
        KOMPAS_SIGN_IDENTITY: '-',
        KOMPAS_NOTARY_PROFILE: 'test',
      }),
    ).toThrow('Developer ID Application');
    expect(() => signingConfig({ KOMPAS_RELEASE: 'true' })).toThrow(
      'must be 0 or 1',
    );
  });

  it('requires strict hardened runtime signing and keychain notarisation', () => {
    const config = signingConfig({
      KOMPAS_RELEASE: '1',
      KOMPAS_SIGN_IDENTITY: 'Developer ID Application: test',
      KOMPAS_NOTARY_PROFILE: 'test-profile',
    });
    expect(config.osxSign).toMatchObject({ strictVerify: true });
    expect(config.osxNotarize).toEqual({
      keychainProfile: 'test-profile',
      keychain: undefined,
    });
    if (typeof config.osxSign !== 'object') throw new Error('Expected signing');
    expect(
      config.osxSign.optionsForFile?.('native.node', { platform: 'darwin' }),
    ).toMatchObject({ hardenedRuntime: true });
  });
});

describe('Apple artifact verification gate', () => {
  it('rejects an invalid signature without exposing certificate diagnostics', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('private certificate metadata');
    });
    expect(() => verifyAppleArtifact('/tmp/Kompas.app', 'app')).toThrow(
      'codesign --verify failed for Kompas.app',
    );
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid ad-hoc signature before notarisation checks', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(Buffer.alloc(0))
      .mockImplementationOnce(() => {
        throw new Error('not Developer ID');
      });
    expect(() => verifyAppleArtifact('/tmp/Kompas.app', 'app')).toThrow(
      'codesign --verify failed for Kompas.app',
    );
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFileSync).mock.calls[1]?.[1]).toEqual([
      '--verify',
      '-R',
      '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
      '/tmp/Kompas.app',
    ]);
  });

  it('rejects a signed app without a valid stapled notarisation ticket', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(Buffer.alloc(0))
      .mockReturnValueOnce(Buffer.alloc(0))
      .mockImplementationOnce(() => {
        throw new Error('ticket missing');
      });
    expect(() => verifyAppleArtifact('/tmp/Kompas.app', 'app')).toThrow(
      'xcrun stapler validate failed for Kompas.app',
    );
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('reports stapler errors without leaking private diagnostics', () => {
    vi.mocked(execFileSync).mockImplementation((command) => {
      if (command === 'xcrun') {
        throw Object.assign(new Error('private certificate owner'), {
          status: 65,
          stdout:
            '/private/keychain/path: owner@example.com\n' +
            'The validate action failed! Error 65.\n',
          stderr: Buffer.from('private certificate metadata'),
        });
      }

      return '';
    });

    expect(() =>
      verifyAppleArtifact('/tmp/Kompas.app', 'app', 'ZIP Kompas.app'),
    ).toThrow(
      new Error(
        'xcrun stapler validate failed for ZIP Kompas.app ' +
          '(exit 65; The validate action failed! Error 65.)',
      ),
    );
  });

  it('verifies a metadata-preserving copy of the DMG app', () => {
    const source = '/Volumes/Kompas/Kompas.app';
    const installed = '/tmp/installed/Kompas.app';

    verifyInstalledAppleApp(source, installed);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual([
      'ditto',
      ['--rsrc', '--extattr', '--acl', source, installed],
      { stdio: 'pipe' },
    ]);
    expect(
      calls.slice(1).map(([command, args]) => [command, args?.at(-1)]),
    ).toEqual([
      ['codesign', installed],
      ['codesign', installed],
      ['xcrun', installed],
      ['spctl', installed],
    ]);
    expect(calls[3]?.[1]).toEqual(['stapler', 'validate', installed]);
    expect(calls[4]?.[1]).toEqual(['--assess', '--type', 'execute', installed]);
  });

  it('rejects a DMG copy with a missing ticket rather than repairing it', () => {
    vi.mocked(execFileSync).mockImplementation((command) => {
      if (command === 'xcrun') throw Object.assign(new Error(), { status: 65 });

      return '';
    });

    expect(() =>
      verifyInstalledAppleApp('/Volumes/Kompas/Kompas.app', '/tmp/Kompas.app'),
    ).toThrow('DMG-installed Kompas.app (exit 65)');
    expect(execFileSync).toHaveBeenCalledTimes(4);
  });

  it.each(['codesign', 'spctl'])('rejects a DMG app failing %s', (command) => {
    vi.mocked(execFileSync).mockImplementation((calledCommand) => {
      if (calledCommand === command) {
        throw Object.assign(new Error('private diagnostics'), { status: 1 });
      }

      return '';
    });

    expect(() =>
      verifyInstalledAppleApp('/Volumes/Kompas/Kompas.app', '/tmp/Kompas.app'),
    ).toThrow('failed for DMG-installed Kompas.app (exit 1)');
  });

  it('stops verification if copying the DMG app fails', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('copy failed');
    });

    expect(() =>
      verifyInstalledAppleApp('/Volumes/Kompas/Kompas.app', '/tmp/Kompas.app'),
    ).toThrow('copy failed');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
