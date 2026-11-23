// Design preview back end: the real main-process modules and SQLite, run in
// plain Node with a throwaway data directory. Development tooling only; no
// production code may import from here.
import './node-shim';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStorage } from '../../src/main/core/storage';
import { createAppDispatcher } from '../../src/main/core/registry';
import { JsonlLogger } from '../../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../../src/main/modules/telemetry/telemetry.service';
import { ProviderManager } from '../../src/main/modules/inference/provider-manager';
import { WorkerSupervisor } from '../../src/main/modules/inference/worker-supervisor';
import { InMemoryTransport } from '../../src/main/modules/inference/transport';
import { InferenceService } from '../../src/main/modules/inference/inference.service';
import { InferenceSettingsRepository } from '../../src/main/modules/inference/settings.repository';
import { createDefaultWebService } from '../../src/main/modules/web/composition';
import type { ResponseEnvelope } from '../../src/shared/contracts';
import { newJobDiscoveryConfiguration } from '../../src/shared/contracts';
import { seedPreviewData } from './seed';
import { writeSampleCv } from './sample-cv';

export interface PreviewBackend {
  dispatch(raw: unknown): Promise<ResponseEnvelope>;
  dataDir: string;
  close(): Promise<void>;
}

export type PreviewScenario = 'populated' | 'empty' | 'onboarding';

export async function createPreviewBackend(
  scenario: PreviewScenario,
): Promise<PreviewBackend> {
  // Offline fixture job boards and the deterministic mock model, exactly as
  // the packaged smoke harness uses them. Nothing reaches the real web.
  process.env.CAREER_SMOKE = '1';
  process.env.CW_DISCOVERY_FIXTURE = '1';
  process.env.CW_DISCOVERY_FIXTURE_JOBS = '1';

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-design-preview-'));
  const storage = openStorage(dataDir);
  const sampleCv = await writeSampleCv(
    path.join(dataDir, 'Alex Morgan CV.pdf'),
  );
  const telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(storage.layout.appLogFile),
  });

  const providers = new ProviderManager();
  providers.register({
    providerId: 'mock',
    kind: 'mock',
    configured: true,
    dev: true,
  });
  const supervisor = new WorkerSupervisor({
    createTransport: () => new InMemoryTransport(),
    providerConfigs: providers.workerConfigs(),
    telemetry,
  });
  const inference = new InferenceService({
    supervisor,
    providers,
    hardwareProbeDir: dataDir,
    settingsRepository: new InferenceSettingsRepository(storage.db),
    diagnostics: telemetry,
    telemetry,
  });
  await inference.start();

  const web = createDefaultWebService({ telemetry });
  const dispatcher = createAppDispatcher({
    getAppVersion: () => '1.0.0-preview',
    isStorageReady: () => true,
    telemetry,
    storage: {
      db: storage.db,
      fileStore: storage.fileStore,
      audioFileStore: storage.audioFileStore,
      audioStagingDir: storage.audioStagingDir,
    },
    documentsPlatform: {
      // "Choose file" picks a generated sample CV, so first-run flows can be
      // exercised end to end without a native dialog.
      pickFile: async () => sampleCv,
      openPath: async () => '',
    },
    inference: { service: inference, devActions: true },
    audioTranscription: {
      resourcesDir: path.join(dataDir, 'no-whisper-in-preview'),
    },
    web,
    maintenance: {
      dataDir,
      reset: async () => {},
      registerBusy: () => {},
    },
  });

  // Use the deterministic mock CV model so CV reading works offline;
  // PREVIEW_LOCAL_AI=none shows the "Set up Ollama" path instead.
  if (process.env.PREVIEW_LOCAL_AI !== 'none') {
    await dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'inference',
      version: 1,
      action: 'settings.update',
      payload: { patch: { providerId: 'mock', modelId: 'mock-cv' } },
    });
  }

  if (scenario !== 'onboarding') {
    const send = (module: string, action: string, payload: unknown = {}) =>
      dispatcher.dispatch({
        requestId: crypto.randomUUID(),
        module,
        version: 1,
        action,
        payload,
      });
    await send('system', 'onboarding.complete');
    if (scenario === 'populated') {
      await seedPreviewData(send, newJobDiscoveryConfiguration());
    }
  }

  return {
    dispatch: (raw) => dispatcher.dispatch(raw),
    dataDir,
    async close() {
      await inference.stop();
      storage.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
