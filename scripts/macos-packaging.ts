import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';

/** Release mode fails closed before building; default packaging is unsigned. */
export function signingConfig(
  env: NodeJS.ProcessEnv = process.env,
): Pick<NonNullable<ForgeConfig['packagerConfig']>, 'osxSign' | 'osxNotarize'> {
  if (env.KOMPAS_RELEASE === undefined || env.KOMPAS_RELEASE === '0') {
    return {};
  }
  if (env.KOMPAS_RELEASE !== '1') {
    throw new Error('KOMPAS_RELEASE must be 0 or 1');
  }
  for (const key of ['KOMPAS_SIGN_IDENTITY', 'KOMPAS_NOTARY_PROFILE']) {
    if (!env[key]?.trim()) throw new Error(`Signed release requires ${key}`);
  }
  if (!env.KOMPAS_SIGN_IDENTITY?.startsWith('Developer ID Application:')) {
    throw new Error(
      'Signed release requires a Developer ID Application identity',
    );
  }

  return {
    osxSign: {
      identity: env.KOMPAS_SIGN_IDENTITY,
      keychain: env.KOMPAS_SIGN_KEYCHAIN,
      strictVerify: true,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: path.resolve('assets/branding/entitlements.plist'),
      }),
    },
    osxNotarize: {
      keychainProfile: env.KOMPAS_NOTARY_PROFILE!,
      keychain: env.KOMPAS_NOTARY_KEYCHAIN,
    },
  };
}

/** Verify the actual artifact, including Developer ID (reject ad-hoc signing). */
export function verifyAppleArtifact(file: string, kind: 'app' | 'dmg'): void {
  const run = (command: string, args: string[]): string => {
    try {
      return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      // Apple diagnostics can contain certificate owner/keychain metadata.
      throw new Error(`${command} failed for ${path.basename(file)}`);
    }
  };

  run('codesign', ['--verify', '--deep', '--strict', file]);
  run('codesign', [
    '--verify',
    '-R',
    'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    file,
  ]);
  run('xcrun', ['stapler', 'validate', file]);
  run(
    'spctl',
    kind === 'app'
      ? ['--assess', '--type', 'execute', file]
      : [
          '--assess',
          '--type',
          'open',
          '--context',
          'context:primary-signature',
          file,
        ],
  );
}
