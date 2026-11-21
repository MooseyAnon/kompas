// macOS sips + iconutil only; source pixels are never rewritten.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const branding = path.join(root, 'assets/branding');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kompas-icon-'));
const iconset = path.join(temporary, 'Kompas.iconset');
fs.mkdirSync(iconset);

try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const suffix = scale === 2 ? '@2x' : '';
      execFileSync(
        'sips',
        [
          '-z',
          String(pixels),
          String(pixels),
          path.join(branding, 'updated-logo.png'),
          '--out',
          path.join(iconset, `icon_${size}x${size}${suffix}.png`),
        ],
        { stdio: 'ignore' },
      );
    }
  }

  execFileSync('iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    path.join(branding, 'Kompas.icns'),
  ]);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
