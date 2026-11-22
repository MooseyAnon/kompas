import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  checksumManifest,
  inspectDistributables,
  verifyManifest,
} from './release-artifacts.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--unsigned') {
  throw new Error('Usage: node scripts/release-acceptance.mjs --unsigned');
}

// Inspect the current tracked tree, never print matching content or secrets.
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
for (const file of tracked) {
  if (
    /(^|\/)(\.ignore_fs|\.agent|specs|prompts|handoffs|\.env(?:\.[^/]*)?)(\/|$)|\.(p12|p8|pem|key|log)$/i.test(
      file,
    )
  ) {
    throw new Error(`Private tracked path: ${file}`);
  }
  const bytes = fs.readFileSync(file);
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{32,}/.test(
      bytes.toString(),
    )
  ) {
    throw new Error(`Private key marker in tracked file: ${file}`);
  }
}
execFileSync('git', ['check-ignore', '-q', '.ignore_fs/acceptance-probe']);
console.log(
  `PASS: ${tracked.length} tracked paths/key-marker checks (not history)`,
);

const { dmg, zip, minimumOS } = inspectDistributables({ signed: false });
const directory = 'out/acceptance-unsigned';
fs.mkdirSync(directory, { recursive: true });
const files = [dmg, zip].map((file) => {
  const destination = path.join(directory, path.basename(file));
  fs.copyFileSync(file, destination);
  return destination;
});
const manifest = checksumManifest(files);
fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), manifest);
verifyManifest(directory, manifest);
console.log(manifest.trimEnd());
console.log(
  `PASS: unsigned archives, runtime audit, identity/icon; macOS ${minimumOS}+`,
);
console.log(
  'Apple signing/notarisation/Gatekeeper: NOT RUN. Not for publication.',
);
