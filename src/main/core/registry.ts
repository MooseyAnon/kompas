import {
  createDispatcher,
  type Dispatcher,
  type FailureLogger,
  type ModuleManifest,
} from '../ipc/dispatcher';
import type { SqliteDatabase } from './db/connection';
import type { FileStore } from './files/file-store';
import { createSystemModule } from '../modules/system/system.module';
import { SystemService } from '../modules/system/system.service';
import { createTelemetryModule } from '../modules/telemetry/telemetry.module';
import type { TelemetryService } from '../modules/telemetry/telemetry.service';
import { IdentityRepository } from '../modules/identity/identity.repository';
import { IdentityService } from '../modules/identity/identity.service';
import { createIdentityModule } from '../modules/identity/identity.module';
import { DocumentsRepository } from '../modules/documents/documents.repository';
import {
  DocumentsService,
  type FilePicker,
  type PathOpener,
} from '../modules/documents/documents.service';
import { createDocumentsModule } from '../modules/documents/documents.module';
import { ApplicationsRepository } from '../modules/applications/applications.repository';
import { ApplicationsService } from '../modules/applications/applications.service';
import { createApplicationsModule } from '../modules/applications/applications.module';
import { ImportPreviewService } from '../modules/applications/import-preview.service';
import { SavedSearchesRepository } from '../modules/job-discovery/saved-searches.repository';
import { SavedSearchesService } from '../modules/job-discovery/saved-searches.service';
import { createJobDiscoveryModule } from '../modules/job-discovery/job-discovery.module';
import { DiscoveryRunsRepository } from '../modules/job-discovery/runs.repository';
import { DiscoveryRunsService } from '../modules/job-discovery/runs.service';
import { OpportunitiesRepository } from '../modules/job-discovery/opportunities.repository';
import { OpportunitiesService } from '../modules/job-discovery/opportunities.service';
import { DiscoveryIdentityService } from '../modules/job-discovery/identity.service';
import { createCvImportsModule } from '../modules/cv-imports/cv-imports.module';
import { CvImportsService } from '../modules/cv-imports/cv-imports.service';
import { CvImportsRepository } from '../modules/cv-imports/cv-imports.repository';
import { InterviewsRepository } from '../modules/interviews/interviews.repository';
import { InterviewsService } from '../modules/interviews/interviews.service';
import { InterviewQuestionService } from '../modules/interviews/interviews.question.service';
import { InterviewReviewService } from '../modules/interviews/interviews.review.service';
import { InterviewSessionService } from '../modules/interviews/interviews.session.service';
import { InterviewVoiceService } from '../modules/interviews/interviews.voice.service';
import { InterviewAudioCoordinator } from '../modules/interviews/interviews.audio';
import { createInterviewsModule } from '../modules/interviews/interviews.module';
import { InterviewInsightsRepository } from '../modules/interviews/interviews.insights.repository';
import { InterviewInsightsService } from '../modules/interviews/interviews.insights.service';
import { createInferenceModule } from '../modules/inference/inference.module';
import type { InferenceService } from '../modules/inference/inference.service';
import { AudioRepository } from '../modules/audio/audio.repository';
import { RecordingService } from '../modules/audio/audio.service';
import { createAudioModule } from '../modules/audio/audio.module';
import { createWebModule } from '../modules/web/web.module';
import type { WebService } from '../modules/web/web.service';
import { discoverySmokeWeb } from '../modules/job-discovery/smoke-web';
import { TranscriptionRepository } from '../modules/audio/stt/transcription.repository';
import { TranscriptionService } from '../modules/audio/stt/transcription.service';
import {
  WhisperCppAdapter,
  WHISPER_PROVIDER_ID,
} from '../modules/audio/stt/whisper-adapter';
import { resolveWhisperAssets } from '../modules/audio/stt/whisper-assets';
import { createStorageModule } from '../modules/storage/storage.module';

/** Storage handles required to register the identity and documents modules. */
export interface StorageHandles {
  db: SqliteDatabase;

  fileStore: FileStore;

  /** Managed store + private staging directory for the shared audio module. */
  audioFileStore?: FileStore;

  audioStagingDir?: string;
}

/** Platform operations the documents module needs (injected, Electron-free here). */
export interface DocumentsPlatform {
  pickFile: FilePicker;

  openPath: PathOpener;
}

export interface AppServices {
  getAppVersion: () => string;

  isStorageReady: () => boolean;

  /** When provided, the telemetry module is registered and IPC failures are recorded. */
  telemetry?: TelemetryService;

  /** When provided, the identity and documents domain modules are registered. */
  storage?: StorageHandles;

  /** Native picker/opener for the documents module; required alongside `storage`. */
  documentsPlatform?: DocumentsPlatform;

  /** When provided, the inference domain module is registered. */
  inference?: { service: InferenceService; devActions?: boolean };

  /**
   * Bundled offline speech-to-text engine resources (Stage 008.2). When
   * provided alongside storage, the Whisper transcription provider/service is
   * registered. `resourcesDir` is the trusted, app-controlled root of the
   * packaged `whisper` resources (binary + model + manifest).
   */
  audioTranscription?: { resourcesDir: string; tmpDir?: string };

  /**
   * Shared Web domain service (Stage 009.1). When provided, the `web` module is
   * registered. It needs no durable storage, so it is independent of `storage`.
   */
  web?: WebService;

  maintenance?: {
    dataDir: string;

    reset: () => Promise<void>;

    registerBusy: (check: () => boolean) => void;
  };
}

interface AudioServices {
  recordings?: RecordingService;

  transcription?: TranscriptionService;
}

function createAudioServices(
  services: AppServices,
  storage: StorageHandles,
): AudioServices {
  if (!storage.audioFileStore || !storage.audioStagingDir) {
    return {};
  }

  const recordings = new RecordingService({
    repository: new AudioRepository(storage.db),
    fileStore: storage.audioFileStore,
    stagingDir: storage.audioStagingDir,
    telemetry: services.telemetry,
  });

  // Reconcile interrupted uploads before capture or interview services can use them.
  recordings.reconcile();

  if (!services.audioTranscription) {
    return { recordings };
  }

  const assets = resolveWhisperAssets(services.audioTranscription.resourcesDir);
  const whisper = new WhisperCppAdapter({
    assets,
    tmpDir: services.audioTranscription.tmpDir,
  });
  const transcription = new TranscriptionService({
    repository: new TranscriptionRepository(storage.db),
    recordings,
    providers: [whisper],
    defaultProviderId: WHISPER_PROVIDER_ID,
    telemetry: services.telemetry,
  });

  // Jobs interrupted by an unclean exit become retryable during startup.
  transcription.reconcile();

  return { recordings, transcription };
}

function createInterviewAudioCoordinator({
  recordings,
  transcription,
}: AudioServices): InterviewAudioCoordinator | undefined {
  if (recordings === undefined) {
    return undefined;
  }

  // Keep the Audio → Interviews seam limited to committed IDs, never paths or text.
  return new InterviewAudioCoordinator({
    getReadyRecordingId: (id) => {
      try {
        return recordings.get(id).id;
      } catch {
        return null;
      }
    },
    ...(transcription
      ? {
          getTranscriptRecordingId: (id: string) => {
            try {
              return transcription.getTranscript(id).recordingId;
            } catch {
              return null;
            }
          },
        }
      : {}),
  });
}

function registerInterviewModules(
  modules: ModuleManifest[],
  services: AppServices,
  storage: StorageHandles,
  identity: IdentityService,
  audio: AudioServices,
): void {
  const audioCoordinator = createInterviewAudioCoordinator(audio);
  const repository = new InterviewsRepository(storage.db);
  const shared = {
    repository,
    identity,
    inference: services.inference?.service,
    telemetry: services.telemetry,
  };
  const interviews = new InterviewsService({
    repository,
    targets: identity,
    telemetry: services.telemetry,
  });
  const questions = new InterviewQuestionService(shared);
  const reviews = new InterviewReviewService({
    ...shared,
    audio: audioCoordinator,
  });
  const sessions = new InterviewSessionService({ ...shared, reviews });
  const voice = new InterviewVoiceService({
    repository,
    audio: audioCoordinator,
    telemetry: services.telemetry,
  });

  services.maintenance?.registerBusy(
    () =>
      questions.isActive() ||
      reviews.isActive() ||
      sessions.isActive() ||
      !!audio.recordings?.hasOpenHandles() ||
      !!audio.transcription?.isActive(),
  );
  modules.push(
    createInterviewsModule(
      interviews,
      questions,
      reviews,
      sessions,
      voice,
      new InterviewInsightsService(
        new InterviewInsightsRepository(storage.db),
        repository,
        reviews,
      ),
    ),
  );

  if (audio.recordings) {
    modules.push(createAudioModule(audio.recordings, audio.transcription));
  }
}

function registerDocumentModules(
  modules: ModuleManifest[],
  services: AppServices,
  storage: StorageHandles,
): ApplicationsService | undefined {
  const { documentsPlatform, telemetry, inference } = services;

  if (!documentsPlatform) {
    return undefined;
  }

  const documents = new DocumentsService({
    repository: new DocumentsRepository(storage.db),
    fileStore: storage.fileStore,
    pickFile: documentsPlatform.pickFile,
    openPath: documentsPlatform.openPath,
    telemetry,
  });
  modules.push(createDocumentsModule(documents));

  const applications = new ApplicationsService(
    new ApplicationsRepository(storage.db),
    documents,
  );
  modules.push(
    createApplicationsModule(
      applications,
      services.web
        ? new ImportPreviewService(services.web, inference?.service)
        : undefined,
    ),
  );

  const cvImports = new CvImportsService(
    new CvImportsRepository(storage.db),
    documents,
    inference?.service,
    telemetry,
  );
  modules.push(createCvImportsModule(cvImports));
  services.maintenance?.registerBusy(() => cvImports.isActive());

  return applications;
}

function registerDiscoveryModule(
  modules: ModuleManifest[],
  services: AppServices,
  storage: StorageHandles,
  searches: SavedSearchesService,
  identity: IdentityService,
  applications: ApplicationsService | undefined,
): void {
  const runs = new DiscoveryRunsRepository(storage.db);
  const useSmokeFixture =
    process.env.CAREER_SMOKE === '1' &&
    process.env.CW_DISCOVERY_FIXTURE === '1';
  const discoveryRuns = new DiscoveryRunsService(
    runs,
    searches,
    undefined,
    useSmokeFixture
      ? discoverySmokeWeb(process.env.CW_DISCOVERY_FIXTURE_JOBS === '1')
      : services.web,
    new DiscoveryIdentityService(runs, applications),
    services.inference?.service,
    identity,
    applications,
  );
  services.maintenance?.registerBusy(() => discoveryRuns.isActive());
  modules.push(
    createJobDiscoveryModule(
      searches,
      discoveryRuns,
      new OpportunitiesService(new OpportunitiesRepository(storage.db)),
    ),
  );
}

function registerStorageModules(
  modules: ModuleManifest[],
  services: AppServices,
  storage: StorageHandles,
): void {
  const searches = new SavedSearchesService(
    new SavedSearchesRepository(storage.db),
  );
  const importRepository = new CvImportsRepository(storage.db);
  const identity = new IdentityService(
    new IdentityRepository(storage.db),
    (id) => importRepository.get(id),
  );
  modules.push(createIdentityModule(identity, services.inference?.service));

  const audio = createAudioServices(services, storage);
  registerInterviewModules(modules, services, storage, identity, audio);

  const applications = registerDocumentModules(modules, services, storage);
  registerDiscoveryModule(
    modules,
    services,
    storage,
    searches,
    identity,
    applications,
  );
}

/**
 * Statically compile the module registry and return a ready dispatcher.
 * Domain modules that need durable storage are registered only when a live
 * storage handle is supplied.
 */
export function createAppDispatcher(
  services: AppServices,
  options: { logFailure?: FailureLogger } = {},
): Dispatcher {
  const systemService = new SystemService({
    ...services,
    db: services.storage?.db,
  });
  const modules = [createSystemModule(systemService)];

  if (services.maintenance) {
    modules.push(
      createStorageModule(
        services.maintenance.dataDir,
        services.maintenance.reset,
      ),
    );
  }

  const { telemetry, storage, inference } = services;

  if (telemetry) {
    modules.push(createTelemetryModule(telemetry));
  }

  if (inference) {
    modules.push(
      createInferenceModule(inference.service, {
        devActions: inference.devActions,
      }),
    );
  }

  if (services.web) {
    modules.push(createWebModule(services.web));
  }

  if (storage) {
    registerStorageModules(modules, services, storage);
  }

  const logFailure: FailureLogger | undefined =
    options.logFailure ??
    (telemetry ? (info) => telemetry.recordIpcFailure(info) : undefined);

  return createDispatcher(modules, { logFailure });
}
