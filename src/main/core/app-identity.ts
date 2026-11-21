import fs from 'node:fs';
import path from 'node:path';
import type { App } from 'electron';

/** Keep the pre-branding package's productName-derived data identity stable. */
export function preserveStorageIdentity(
  app: Pick<App, 'getPath' | 'setPath'> & {
    commandLine: Pick<App['commandLine'], 'hasSwitch'>;
  },
): void {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    const directory = path.join(app.getPath('appData'), 'Kompas');
    // Electron rejects setPath for a directory that does not exist yet.
    fs.mkdirSync(directory, { recursive: true });
    app.setPath('userData', directory);
  }
}
