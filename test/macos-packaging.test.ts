import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signingConfig, verifyAppleArtifact } from '../scripts/macos-packaging';

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
      'codesign failed for Kompas.app',
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
      'codesign failed for Kompas.app',
    );
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('rejects a signed app without a valid stapled notarisation ticket', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(Buffer.alloc(0))
      .mockReturnValueOnce(Buffer.alloc(0))
      .mockImplementationOnce(() => {
        throw new Error('ticket missing');
      });
    expect(() => verifyAppleArtifact('/tmp/Kompas.app', 'app')).toThrow(
      'xcrun failed for Kompas.app',
    );
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });
});
