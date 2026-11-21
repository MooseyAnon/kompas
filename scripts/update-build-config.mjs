import { guardRelease } from './release-guard.mjs';
import { signingConfig } from './macos-packaging.ts';

// Only the same public-source and signing gates used for draft releases may
// bake an update source into the application. Runtime environment cannot opt in.
export function updateBuildRepository(
  env = process.env,
  verify = guardRelease,
) {
  if (env.KOMPAS_RELEASE !== '1') return null;

  signingConfig(env);
  return verify(env).repository;
}
