// Reproducible provisioning of the offline speech-to-text assets for Stage
// 008.2: the pinned `whisper.cpp` `whisper-cli` executable (macOS Apple
// Silicon, built from source) and the multilingual Whisper `base` GGML model
// (`ggml-base.bin`, ~142 MiB).
//
// What it does (idempotent):
//   1. Shallow-clone whisper.cpp at a PINNED tag/commit into .whisper-build/.
//   2. Build a self-contained, CPU-only, statically-linked `whisper-cli`
//      (no libwhisper/libggml dylibs, no Metal resource discovery, no Homebrew
//      runtime libraries) so packaging and offline launch are robust.
//   3. Download the EXACT multilingual `ggml-base.bin` and verify its SHA-256.
//   4. Copy the binary + model into resources/whisper/{bin,models}/ and write a
//      manifest (resources/whisper/manifest.json) recording real revision,
//      measured bytes, SHA-256 hashes, build flags, architecture and license.
//
// The large binary/weights are NOT committed to Git (see .gitignore); only the
// small manifest is. Run `node scripts/provision-whisper.mjs` on a macOS ARM64
// machine with cmake + a C/C++ toolchain and network access. Pass `--verify` to
// only re-check existing provisioned assets against the manifest.
//
// Usage:
//   node scripts/provision-whisper.mjs           # provision (build + download)
//   node scripts/provision-whisper.mjs --verify  # verify already-provisioned

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// --- Pinned upstream sources ------------------------------------------------

/** whisper.cpp release tag and the exact (peeled) commit it resolves to. */
const WHISPER_REPO = 'https://github.com/ggml-org/whisper.cpp';
const WHISPER_TAG = 'v1.9.5';
const WHISPER_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';

/** Multilingual Whisper base model (ggml). Pinned by SHA-256, not just URL. */
const MODEL_FILE = 'ggml-base.bin';
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_SHA256 =
  '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';

/** CPU-only, static build: a self-contained binary with no bundled dylibs. */
const CMAKE_CONFIGURE_FLAGS = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_METAL=OFF',
  '-DGGML_ACCELERATE=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=OFF',
];

const buildDir = path.join(repoRoot, '.whisper-build');
const srcDir = path.join(buildDir, 'whisper.cpp');
const resourcesDir = path.join(repoRoot, 'resources', 'whisper');
const binDir = path.join(resourcesDir, 'bin');
const modelsDir = path.join(resourcesDir, 'models');
const binPath = path.join(binDir, 'whisper-cli');
const modelPath = path.join(modelsDir, MODEL_FILE);
const manifestPath = path.join(resourcesDir, 'manifest.json');

const log = (msg) => console.log(`[provision] ${msg}`);
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fileBytes(filePath) {
  return fs.statSync(filePath).size;
}

function ensureDirs() {
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
}

function cloneAndBuild() {
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
    log(`cloning ${WHISPER_REPO} @ ${WHISPER_TAG}`);
    run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      WHISPER_TAG,
      WHISPER_REPO,
      srcDir,
    ]);
  }

  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: srcDir,
    encoding: 'utf8',
  }).trim();
  if (actualCommit !== WHISPER_COMMIT) {
    throw new Error(
      `whisper.cpp checkout ${actualCommit} != pinned ${WHISPER_COMMIT}`,
    );
  }

  log('configuring cmake (static, CPU-only)');
  run('cmake', ['-B', 'build', ...CMAKE_CONFIGURE_FLAGS], { cwd: srcDir });
  log('building whisper-cli');
  run(
    'cmake',
    [
      '--build',
      'build',
      '--config',
      'Release',
      '--target',
      'whisper-cli',
      '-j',
    ],
    {
      cwd: srcDir,
    },
  );

  const built = path.join(srcDir, 'build', 'bin', 'whisper-cli');
  if (!fs.existsSync(built)) {
    throw new Error(`expected built binary not found at ${built}`);
  }
  fs.copyFileSync(built, binPath);
  fs.chmodSync(binPath, 0o755);
  log(`installed binary -> ${path.relative(repoRoot, binPath)}`);
}

function downloadModel() {
  if (fs.existsSync(modelPath) && sha256File(modelPath) === MODEL_SHA256) {
    log('model already present and hash-verified');
    return;
  }
  log(`downloading ${MODEL_FILE} (~142 MiB)`);
  run('curl', ['-L', '--fail', '--retry', '3', '-o', modelPath, MODEL_URL]);
  const actual = sha256File(modelPath);
  if (actual !== MODEL_SHA256) {
    throw new Error(
      `model SHA-256 mismatch: expected ${MODEL_SHA256}, got ${actual}`,
    );
  }
  log('model downloaded and hash-verified');
}

/** The dynamic libraries the built binary links against (for the manifest). */
function dylibDependencies() {
  try {
    const out = execFileSync('otool', ['-L', binPath], { encoding: 'utf8' });
    return out
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(' ')[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function machoArch() {
  try {
    const out = execFileSync('file', [binPath], { encoding: 'utf8' });
    return out.includes('arm64') ? 'arm64' : out.trim();
  } catch {
    return 'unknown';
  }
}

function writeManifest() {
  const dylibs = dylibDependencies();
  const homebrewDeps = dylibs.filter(
    (d) => d.includes('/opt/homebrew/') || d.includes('/usr/local/'),
  );
  if (homebrewDeps.length > 0) {
    throw new Error(
      `binary links Homebrew/local runtime libraries: ${homebrewDeps.join(', ')}`,
    );
  }

  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    platform: 'darwin',
    architecture: machoArch(),
    engine: {
      id: 'whisper.cpp',
      repository: WHISPER_REPO,
      tag: WHISPER_TAG,
      commit: WHISPER_COMMIT,
      executable: 'bin/whisper-cli',
      executableSha256: sha256File(binPath),
      executableBytes: fileBytes(binPath),
      buildFlags: CMAKE_CONFIGURE_FLAGS,
      runtime: 'cpu',
      dynamicLibraries: dylibs,
      license: 'MIT',
      licenseNotice:
        'whisper.cpp is distributed under the MIT License (c) 2023-2024 The ggml authors.',
    },
    model: {
      id: 'whisper-base-multilingual',
      file: `models/${MODEL_FILE}`,
      variant: 'base',
      multilingual: true,
      source: MODEL_URL,
      sha256: MODEL_SHA256,
      bytes: fileBytes(modelPath),
      license: 'MIT',
      licenseNotice:
        'Whisper models are released by OpenAI under the MIT License; ggml conversions by the whisper.cpp authors.',
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote manifest -> ${path.relative(repoRoot, manifestPath)}`);
  return manifest;
}

function verify() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest missing; run provisioning first');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const checks = [
    [
      'executable',
      binPath,
      manifest.engine.executableSha256,
      manifest.engine.executableBytes,
    ],
    ['model', modelPath, manifest.model.sha256, manifest.model.bytes],
  ];
  for (const [name, filePath, expectedHash, expectedBytes] of checks) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`${name} missing at ${filePath}`);
    }
    const actualHash = sha256File(filePath);
    if (actualHash !== expectedHash) {
      throw new Error(
        `${name} hash mismatch: ${actualHash} != ${expectedHash}`,
      );
    }
    const actualBytes = fileBytes(filePath);
    if (actualBytes !== expectedBytes) {
      throw new Error(
        `${name} byte count mismatch: ${actualBytes} != ${expectedBytes}`,
      );
    }
    log(`${name} OK (${actualBytes} bytes, ${actualHash.slice(0, 12)}…)`);
  }
  log('verification passed');
}

function main() {
  if (process.argv.includes('--verify')) {
    verify();
    return;
  }
  ensureDirs();
  cloneAndBuild();
  downloadModel();
  const manifest = writeManifest();
  verify();
  log('provisioning complete:');
  log(
    `  engine  ${manifest.engine.tag} (${manifest.engine.executableBytes} bytes)`,
  );
  log(`  model   ${manifest.model.file} (${manifest.model.bytes} bytes)`);
}

main();
