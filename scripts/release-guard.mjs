import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateReleaseSource(env, version, head, tagCommit, onMaster) {
  const tag = env.GITHUB_REF?.replace(/^refs\/tags\//, '');
  if (
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REF !== `refs/tags/${tag}` ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
  ) {
    throw new Error('Release requires a stable vMAJOR.MINOR.PATCH tag push');
  }
  if (tag !== `v${version}`) throw new Error('Tag/package version mismatch');
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('Release requires a valid GitHub repository');
  }
  if (
    !/^[a-f0-9]{40}$/.test(tagCommit ?? '') ||
    tagCommit !== head ||
    !onMaster
  ) {
    throw new Error('Checkout must match the tagged commit on master');
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
  let onMaster = false;
  try {
    git('merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/master');
    onMaster = true;
  } catch {
    // Match Public CI's protected branch; a missing ref is also a closed gate.
  }
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const commit = git('rev-parse', `${env.GITHUB_REF}^{commit}`);
  const tag = validateReleaseSource(
    env,
    version,
    git('rev-parse', 'HEAD'),
    commit,
    onMaster,
  );
  const repo = JSON.parse(github(['api', `repos/${env.GITHUB_REPOSITORY}`]));
  if (repo.private !== false || repo.visibility !== 'public') {
    throw new Error('Public release blocked: repository is not public');
  }
  return { tag, version, repository: env.GITHUB_REPOSITORY, commit };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  guardRelease();
  console.log('Release source and public repository gates passed');
}
