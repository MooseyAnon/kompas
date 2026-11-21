import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import type { InferenceService } from '../src/main/modules/inference/inference.service';
import type { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import type { WebService } from '../src/main/modules/web/web.service';

// Compose the same optional services as the packaged app. Handlers are never
// invoked: only the registered module manifests are inspected.
function catalogue(devActions: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-catalogue-'));
  const storage = openStorage(dir);
  try {
    const dispatcher = createAppDispatcher({
      getAppVersion: () => '1.0.0',
      isStorageReady: () => true,
      telemetry: {} as TelemetryService,
      storage,
      documentsPlatform: {
        pickFile: async () => null,
        openPath: async () => '',
      },
      inference: { service: {} as InferenceService, devActions },
      audioTranscription: { resourcesDir: path.join(dir, 'missing-whisper') },
      web: {} as WebService,
      maintenance: {
        dataDir: dir,
        reset: async () => {},
        registerBusy: () => {},
      },
    });
    return dispatcher
      .listCommands()
      .map(({ module, version, action }) => `${module}@${version}.${action}`)
      .sort();
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('complete registered IPC catalogue', () => {
  it('pins production actions and major versions', () => {
    // Update this reviewed snapshot only when changing a public action/version.
    expect(catalogue(false)).toMatchSnapshot();
  });

  it('keeps smoke-only inference commands out of production', () => {
    const production = catalogue(false);
    const smoke = catalogue(true);
    expect(smoke.filter((command) => !production.includes(command))).toEqual([
      'inference@1.__dev.crashRecover',
      'inference@1.__dev.selfTest',
      'inference@1.__dev.toolSelfTest',
    ]);
    expect(production.filter((command) => !smoke.includes(command))).toEqual(
      [],
    );
  });
});
