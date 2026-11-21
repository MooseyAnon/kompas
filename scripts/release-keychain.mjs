import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.RUNNER_TEMP;
if (!root) throw new Error('Ephemeral GitHub runner required');
const directory = path.join(root, 'kompas-signing');
const keychain = path.join(directory, 'release.keychain-db');
const certificate = path.join(directory, 'certificate.p12');
const previous = path.join(directory, 'search-list.json');
const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });

function cleanup() {
  try {
    if (fs.existsSync(previous)) {
      const searchList = JSON.parse(fs.readFileSync(previous, 'utf8'));
      run('security', ['list-keychains', '-d', 'user', '-s', ...searchList]);
    }
  } finally {
    try {
      if (fs.existsSync(keychain)) {
        run('security', ['delete-keychain', keychain]);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

function validateCredentials() {
  const required = [
    'KOMPAS_CERTIFICATE_P12_BASE64',
    'KOMPAS_CERTIFICATE_PASSWORD',
    'KOMPAS_SIGN_IDENTITY',
    'KOMPAS_APPLE_ID',
    'KOMPAS_APPLE_PASSWORD',
    'KOMPAS_APPLE_TEAM_ID',
  ];
  for (const name of required) {
    if (!process.env[name]?.trim()) throw new Error(`Missing ${name}`);
  }
}

function storeNotarisationCredentials() {
  run('xcrun', [
    'notarytool',
    'store-credentials',
    'kompas-release',
    '--apple-id',
    process.env.KOMPAS_APPLE_ID,
    '--password',
    process.env.KOMPAS_APPLE_PASSWORD,
    '--team-id',
    process.env.KOMPAS_APPLE_TEAM_ID,
    '--keychain',
    keychain,
  ]);
}

function setup() {
  validateCredentials();
  fs.mkdirSync(directory, { mode: 0o700 });
  const searchList = run('security', ['list-keychains', '-d', 'user'])
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  fs.writeFileSync(previous, JSON.stringify(searchList), { mode: 0o600 });
  const password = randomBytes(32).toString('hex');
  console.log(`::add-mask::${password}`);
  fs.writeFileSync(
    certificate,
    Buffer.from(process.env.KOMPAS_CERTIFICATE_P12_BASE64, 'base64'),
    { mode: 0o600 },
  );
  run('security', ['create-keychain', '-p', password, keychain]);
  run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
  run('security', ['unlock-keychain', '-p', password, keychain]);
  run('security', [
    'import',
    certificate,
    '-P',
    process.env.KOMPAS_CERTIFICATE_PASSWORD,
    '-k',
    keychain,
    '-T',
    '/usr/bin/codesign',
    '-T',
    '/usr/bin/security',
  ]);
  fs.unlinkSync(certificate);
  run('security', [
    'list-keychains',
    '-d',
    'user',
    '-s',
    keychain,
    ...searchList,
  ]);
  run('security', [
    'set-key-partition-list',
    '-S',
    'apple-tool:,apple:,codesign:',
    '-s',
    '-k',
    password,
    keychain,
  ]);
  const identities = run('security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
    keychain,
  ]);
  if (
    !process.env.KOMPAS_SIGN_IDENTITY.startsWith('Developer ID Application:') ||
    !identities.includes(`"${process.env.KOMPAS_SIGN_IDENTITY}"`)
  ) {
    throw new Error(
      'Required Developer ID Application identity is unavailable',
    );
  }
  storeNotarisationCredentials();
  fs.appendFileSync(
    process.env.GITHUB_ENV,
    `KOMPAS_SIGN_KEYCHAIN=${keychain}\nKOMPAS_NOTARY_KEYCHAIN=${keychain}\n` +
      'KOMPAS_NOTARY_PROFILE=kompas-release\n',
  );
}

try {
  if (process.argv[2] === 'setup') setup();
  else if (process.argv[2] === 'cleanup') cleanup();
  else throw new Error('Expected setup or cleanup');
} catch {
  // Child process errors include command arguments: never print them.
  console.error(
    'Apple credential setup/cleanup failed; check owner configuration',
  );
  process.exitCode = 1;
}
