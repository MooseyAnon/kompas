import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listPackage, extractFile, statFile } from '@electron/asar';
import {
  verifyAppleArtifact,
  verifyInstalledAppleApp,
} from './macos-packaging.ts';

export function distributables(version, root = 'out/make') {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Expected stable release version');
  }
  return [
    path.join(root, 'dmg', 'arm64', `Kompas-${version}-mac-arm64.dmg`),
    path.join(
      root,
      'zip',
      'darwin',
      'arm64',
      `Kompas-${version}-mac-arm64.zip`,
    ),
  ];
}

export function checksumManifest(files) {
  return files
    .map((file) => {
      if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
        throw new Error('Missing or empty distributable');
      }
      const digest = createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex');
      return `${digest}  ${path.basename(file)}\n`;
    })
    .join('');
}

export function verifyManifest(directory, manifest) {
  const entries = manifest.trimEnd().split('\n');
  if (entries.length !== 2) throw new Error('Expected exactly two digests');
  const names = new Set();
  let version;
  for (const line of entries) {
    const match =
      /^([a-f0-9]{64})  (Kompas-[\d.]+-mac-arm64\.(?:dmg|zip))$/.exec(line);
    if (!match || names.has(match[2])) {
      throw new Error('Invalid digest manifest');
    }
    names.add(match[2]);
    const entryVersion = /^Kompas-(.*)-mac-arm64\./.exec(match[2])[1];
    version ??= entryVersion;
    if (entryVersion !== version) throw new Error('Mixed manifest versions');
    const file = path.join(directory, match[2]);
    if (checksumManifest([file]) !== `${line}\n`) {
      throw new Error('Distributable checksum mismatch');
    }
  }
  const expected = distributables(version).map((file) => path.basename(file));
  if (!expected.every((name) => names.has(name))) {
    throw new Error('Expected one DMG and one ZIP');
  }
}

export function auditContent(name, bytes) {
  const forbiddenPath =
    /(^|\/)(\.ignore_fs|\.env(?:\.[^/]*)?|\.git|docs|test|tests|fixtures)(\/|$)|\.(p12|p8|pem|key)$/i;
  if (
    forbiddenPath.test(name) ||
    (name.startsWith('.vite/') && name.endsWith('.map'))
  ) {
    throw new Error(`Forbidden release content: ${name}`);
  }
  // Runtime dependencies can ship their own public source maps; our bundles
  // may not. Scan content as well, including inline maps and unpacked files.
  if (
    /\.ignore_fs[\\/]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      bytes.toString(),
    )
  ) {
    throw new Error(`Private workspace/key marker in ${name}`);
  }
}

function auditTree(root, directory = root) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    auditContent(path.relative(root, file), Buffer.alloc(0));
    if (entry.isDirectory()) auditTree(root, file);
    else if (entry.isFile()) {
      auditContent(path.relative(root, file), fs.readFileSync(file));
    }
  }
}

export function auditBundle(app) {
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const info = JSON.parse(
    execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')],
      { encoding: 'utf8' },
    ),
  );
  if (
    info.CFBundleIdentifier !== 'com.kompas.kompas' ||
    info.CFBundleName !== 'Kompas' ||
    info.CFBundleDisplayName !== 'Kompas' ||
    info.CFBundleVersion !== version ||
    info.CFBundleShortVersionString !== version ||
    info.CFBundleExecutable !== 'Kompas' ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(info.LSMinimumSystemVersion)
  ) {
    throw new Error('Packaged identity/version mismatch');
  }
  const resources = path.join(app, 'Contents', 'Resources');
  if (
    !fs
      .readFileSync(path.join(resources, info.CFBundleIconFile))
      .equals(fs.readFileSync('assets/branding/Kompas.icns'))
  ) {
    throw new Error('Packaged flower icon mismatch');
  }
  const asar = path.join(resources, 'app.asar');
  const entries = listPackage(asar).map((entry) => entry.replace(/^\//, ''));
  if (
    !entries.includes('.vite/renderer/main_window/index.html') ||
    entries.filter((entry) => entry.endsWith('.ttf')).length < 4
  ) {
    throw new Error('Missing renderer or bundled fonts');
  }
  for (const entry of entries) {
    // listPackage also returns directories.
    auditContent(entry, Buffer.alloc(0));
    if (!('files' in statFile(asar, entry))) {
      auditContent(entry, extractFile(asar, entry));
    }
  }
  for (const required of [
    '.vite/build/main.cjs',
    '.vite/build/preload.cjs',
    '.vite/build/inference-worker.cjs',
    'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`Missing runtime: ${required}`);
    }
  }
  const whisper = path.join(resources, 'whisper');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(whisper, 'manifest.json')),
  );
  // Verify model and binary presence independently of the source resource tree.
  for (const file of ['bin/whisper-cli', 'models/ggml-base.bin']) {
    if (fs.statSync(path.join(whisper, file)).size === 0) {
      throw new Error('Missing packaged Whisper resource');
    }
  }
  if (manifest.platform !== 'darwin' || manifest.architecture !== 'arm64') {
    throw new Error('Invalid packaged Whisper manifest');
  }
  const model = fs.readFileSync(path.join(whisper, 'models/ggml-base.bin'));
  if (
    createHash('sha256').update(model).digest('hex') !== manifest.model.sha256
  ) {
    throw new Error('Packaged Whisper model checksum mismatch');
  }
  auditTree(app);
  return info;
}

// Unsigned inspection is explicit and never stages or uploads a release.
export function inspectDistributables({ signed = true } = {}) {
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const [dmg, zip] = distributables(version);
  // Both delivery formats are independently checked, including the app inside.
  checksumManifest([dmg, zip]);
  execFileSync('unzip', ['-tqq', zip], { stdio: 'pipe' });
  execFileSync('hdiutil', ['verify', dmg], { stdio: 'pipe' });

  if (signed) verifyAppleArtifact(dmg, 'dmg', 'DMG container');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kompas-artifacts-'));
  const mount = path.join(temporary, 'mount');
  let mounted = false;
  let minimumOS;
  try {
    execFileSync('ditto', ['-x', '-k', zip, path.join(temporary, 'zip')]);
    const zipRoot = path.join(temporary, 'zip');
    if (fs.readdirSync(zipRoot).join() !== 'Kompas.app') {
      throw new Error('ZIP must contain only Kompas.app');
    }

    if (signed) {
      verifyAppleArtifact(
        path.join(zipRoot, 'Kompas.app'),
        'app',
        'ZIP Kompas.app',
      );
    }

    minimumOS = auditBundle(
      path.join(zipRoot, 'Kompas.app'),
    ).LSMinimumSystemVersion;
    fs.mkdirSync(mount);
    execFileSync('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      dmg,
    ]);
    mounted = true;
    auditTree(mount);

    if (signed) {
      verifyInstalledAppleApp(
        path.join(mount, 'Kompas.app'),
        path.join(temporary, 'installed', 'Kompas.app'),
      );
    }

    auditBundle(path.join(mount, 'Kompas.app'));
    if (fs.readlinkSync(path.join(mount, 'Applications')) !== '/Applications') {
      throw new Error('Missing DMG Applications link');
    }
  } finally {
    if (mounted) execFileSync('hdiutil', ['detach', mount]);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { dmg, zip, minimumOS };
}

export function stageRelease() {
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const { dmg, zip, minimumOS } = inspectDistributables();
  const staging = 'out/release';
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging);
  for (const file of [dmg, zip]) {
    fs.copyFileSync(file, path.join(staging, path.basename(file)));
  }
  const manifest = checksumManifest([dmg, zip]);
  fs.writeFileSync(path.join(staging, 'SHA256SUMS.txt'), manifest);
  verifyManifest(staging, manifest);
  fs.writeFileSync(
    path.join(staging, 'RELEASE_NOTES.md'),
    `# Kompas ${version}\n\n` +
      'Local-first career workspace: Profile and CV review, job discovery, ' +
      'application tracking and interview practice.\n\n' +
      '## Installation requirements\n\n' +
      `- macOS ${minimumOS} or newer, Apple Silicon (ARM64) only.\n` +
      '- Install from the DMG by dragging Kompas to Applications.\n' +
      '- Local AI features require a separately installed Ollama and a suitable ' +
      'local model. Manual workflows remain available without Ollama.\n' +
      '- Offline Whisper resources are bundled; microphone and supported browser ' +
      'permissions are requested when those features are used.\n\n' +
      'The ZIP is the macOS update-service artifact. SHA256SUMS.txt covers both ' +
      'distributables. This draft awaits owner download, Gatekeeper, runtime and ' +
      'release-note review before manual publication.\n',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  stageRelease();
}
