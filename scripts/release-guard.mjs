import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateReleaseSource(env, version, head, tagCommit, onMain) {
  const tag = env.GITHUB_REF?.replace(/^refs\/tags\//, '');
  if (
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REF !== `refs/tags/${tag}` ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
  ) {
    throw new Error('Release requires a stable vMAJOR.MINOR.PATCH tag push');
  }
  if (tag !== `v${version}`) throw new Error('Tag/package version mismatch');
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(env.KOMPAS_RELEASE_REPOSITORY ?? '') ||
    env.KOMPAS_RELEASE_REPOSITORY !== env.GITHUB_REPOSITORY
  ) {
    throw new Error('Owner must configure the exact release repository');
  }
  if (
    !/^[a-f0-9]{40}$/.test(env.KOMPAS_RELEASE_COMMIT ?? '') ||
    head !== env.KOMPAS_RELEASE_COMMIT ||
    tagCommit !== head ||
    !onMain
  ) {
    throw new Error('Tag must point to the owner-authorised commit on main');
  }
  return tag;
}

export function github(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

export function guardRelease(env = process.env) {
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  // Validate the ref shape before passing any ref to git.
  if (!/^refs\/tags\/v\d+\.\d+\.\d+$/.test(env.GITHUB_REF ?? '')) {
    throw new Error('Invalid release git ref');
  }
  let onMain = false;
  try {
    git('merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main');
    onMain = true;
  } catch {
    // A missing main ref is also a closed gate.
  }
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const tag = validateReleaseSource(
    env,
    version,
    git('rev-parse', 'HEAD'),
    git('rev-parse', `${env.GITHUB_REF}^{commit}`),
    onMain,
  );
  const repo = JSON.parse(github(['api', `repos/${env.GITHUB_REPOSITORY}`]));
  if (repo.private !== false || repo.visibility !== 'public') {
    throw new Error('Public release blocked: repository is not public');
  }
  return { tag, version, repository: env.GITHUB_REPOSITORY };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  guardRelease();
  console.log('Release source and public repository gates passed');
}
