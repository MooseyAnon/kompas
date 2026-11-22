import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';

const STAPLER_RESULT_PATTERN =
  /^The validate action (?:worked!|failed! Error \d+\.)\r?$/m;

function staplerResult(error: Error): string | undefined {
  const stdout = 'stdout' in error ? error.stdout : undefined;
  const stderr = 'stderr' in error ? error.stderr : undefined;

  // Apple output can include certificate owners and keychain paths. Only
  // expose stapler's fixed result line, never the surrounding diagnostics.
  for (const output of [stdout, stderr]) {
    if (typeof output !== 'string' && !Buffer.isBuffer(output)) continue;

    const result = output.toString().match(STAPLER_RESULT_PATTERN);
    if (result) return result[0].trim();
  }

  return undefined;
}

function verificationFailure(
  error: unknown,
  operation: string,
  source: string,
): Error {
  const details: string[] = [];

  if (error instanceof Error) {
    if ('status' in error && typeof error.status === 'number') {
      details.push(`exit ${error.status}`);
    }

    if ('signal' in error && typeof error.signal === 'string') {
      details.push(`signal ${error.signal}`);
    }

    if (operation === 'xcrun stapler validate') {
      const result = staplerResult(error);
      if (result) details.push(result);
    }
  }

  const summary = `${operation} failed for ${source}`;
  const suffix = details.length ? ` (${details.join('; ')})` : '';

  return new Error(summary + suffix);
}

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
export function verifyAppleArtifact(
  file: string,
  kind: 'app' | 'dmg',
  source = path.basename(file),
): void {
  const run = (operation: string, command: string, args: string[]): void => {
    try {
      execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      throw verificationFailure(error, operation, source);
    }
  };

  run('codesign --verify', 'codesign', [
    '--verify',
    '--deep',
    '--strict',
    file,
  ]);
  run('codesign --verify', 'codesign', [
    '--verify',
    '-R',
    // codesign treats a requirement without '=' as a filename.
    '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    file,
  ]);
  run('xcrun stapler validate', 'xcrun', ['stapler', 'validate', file]);

  const assessment =
    kind === 'app'
      ? ['--assess', '--type', 'execute', file]
      : [
          '--assess',
          '--type',
          'open',
          '--context',
          'context:primary-signature',
          file,
        ];

  run('spctl --assess', 'spctl', assessment);
}

/** Verify the app as installed from a read-only DMG, without repairing it. */
export function verifyInstalledAppleApp(
  source: string,
  destination: string,
): void {
  // Explicitly preserve the stapled ticket and other bundle metadata. Never
  // staple this copy: a missing ticket in the distributable must still fail.
  execFileSync('ditto', ['--rsrc', '--extattr', '--acl', source, destination], {
    stdio: 'pipe',
  });

  verifyAppleArtifact(destination, 'app', 'DMG-installed Kompas.app');
}
