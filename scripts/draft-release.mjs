import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardRelease, github } from './release-guard.mjs';
import {
  stageRelease,
  distributables,
  verifyManifest,
} from './release-artifacts.mjs';

export function reusableDraft(releases, tag, commit) {
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length > 1) throw new Error('Conflicting releases for tag');
  const existing = matches[0];
  if (existing && (!existing.draft || existing.target_commitish !== commit)) {
    throw new Error(
      'Refusing to change a published or differently targeted release',
    );
  }
  return existing;
}

function readRelease(tag, repository, fields) {
  return JSON.parse(
    github(['release', 'view', tag, '--repo', repository, '--json', fields]),
  );
}

export function uploadDraft() {
  const { tag, version, repository } = guardRelease();
  // Reverify signatures and archives at the sole upload entry point as well.
  stageRelease();
  const pages = JSON.parse(
    github([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/releases?per_page=100`,
    ]),
  );
  const existing = reusableDraft(
    pages.flat(),
    tag,
    process.env.KOMPAS_RELEASE_COMMIT,
  );
  if (!existing) {
    github([
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--draft',
      '--target',
      process.env.KOMPAS_RELEASE_COMMIT,
      '--title',
      `Kompas ${version}`,
      '--notes-file',
      'out/release/RELEASE_NOTES.md',
    ]);
  }
  // Reruns only replace assets while still a draft. Never edit publication state.
  const current = readRelease(tag, repository, 'isDraft,targetCommitish');
  if (
    !current.isDraft ||
    current.targetCommitish !== process.env.KOMPAS_RELEASE_COMMIT
  ) {
    throw new Error('Draft changed before upload; owner intervention required');
  }
  verifyManifest(
    'out/release',
    fs.readFileSync('out/release/SHA256SUMS.txt', 'utf8'),
  );
  const assets = distributables(version).map((file) =>
    path.join('out/release', path.basename(file)),
  );
  github([
    'release',
    'upload',
    tag,
    '--repo',
    repository,
    '--clobber',
    ...assets,
    'out/release/SHA256SUMS.txt',
  ]);
  const release = readRelease(tag, repository, 'isDraft,assets');
  const expected = assets
    .map((file) => path.basename(file))
    .concat('SHA256SUMS.txt')
    .sort();
  const actual = release.assets.map((asset) => asset.name).sort();
  if (!release.isDraft || JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Release is not the expected complete draft');
  }
  console.log(
    'Signed assets uploaded to draft; owner must review and publish manually',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  uploadDraft();
}
