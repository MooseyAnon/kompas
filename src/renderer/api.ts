import type {
  JobDiscoveryConfigurationV1,
  SavedSearch,
  SavedSearchPage,
  SavedSearchListInput,
  DiscoveryRun,
  DiscoveryWorkflowState,
  ResolutionDiagnostics,
  DiscoverySearchProgress,
  DiscoveryRunPage,
  DiscoveryCandidate,
  DiscoveryCapture,
  JdExtraction,
  DiscoveryMatch,
  DiscoveryReview,
  OpportunitySummary,
  OpportunityDetail,
  OpportunityApplyPreview,
  Application,
  ApplicationDetail,
  ImportPreview,
  ApplicationDocument,
  ApplicationNote,
  CreateApplicationInput,
  JobSnapshot,
  ListApplicationsInput,
  StageEvent,
  TransitionInput,
  UpdateApplicationInput,
  ApplyImportInput,
  ApplyImportOutput,
  AudioCaptureAppendOutput,
  AudioCaptureBeginOutput,
  AudioPlaybackOpenOutput,
  AudioPlaybackReadOutput,
  AudioRecording,
  AudioSttJobsListOutput,
  AudioSttProvidersListOutput,
  AudioSttProvidersVerifyOutput,
  Document,
  CvImport,
  DocumentCategory,
  DocumentsImportOutput,
  Experience,
  ExperiencePatch,
  ExperiencesCreateInput,
  HardwareProfile,
  InferenceDiagnosticsListOutput,
  InferenceOperationSummary,
  InferenceSettingsGetOutput,
  InferenceSettingsPatch,
  InferenceSettingsUpdateOutput,
  InferenceStatusGetOutput,
  InferenceTestGetOutput,
  InferenceTestRunOutput,
  InferenceTestSnapshot,
  InterviewSession,
  InsightsSession,
  InsightsQuestion,
  InsightsDetail,
  InsightsProgress,
  InterviewMethod,
  InterviewStatus,
  InterviewSessionPatch,
  InterviewSessionSummary,
  InterviewSessionsCreateInput,
  InterviewQuestionsGenerateOutput,
  InterviewQuestionsPreviewGetOutput,
  InterviewAnswersSubmitOutput,
  InterviewAnswerAudioLink,
  InterviewAnswersSubmitInput,
  InterviewAnswersAudioGetOutput,
  InterviewAnswersDraftGetOutput,
  InterviewAnswersDraftSaveOutput,
  InterviewReviewsGetOutput,
  InterviewReviewsRunOutput,
  InterviewCoachingRunOutput,
  InterviewReassessmentGenerateOutput,
  InterviewSessionsStartOutput,
  InterviewSessionsProgressOutput,
  InterviewSessionsAdvanceOutput,
  InterviewSessionsFinishOutput,
  InterviewSessionsTranscriptOutput,
  InterviewWorkflowContinueInput,
  InterviewWorkflowState,
  ModelDescriptor,
  ModelRecommendations,
  OperationRun,
  Profile,
  ProfilePatch,
  ProviderStatus,
  RequestInput,
  ResponseEnvelope,
  SttJob,
  SttProvider,
  SttTranscript,
  SystemPingOutput,
  Target,
  TargetPatch,
  TargetsCreateInput,
  TelemetryRunsListOutput,
  PageReadResult,
  WebBrowsersListOutput,
  WebSearchOutput,
  StorageUsage,
} from '../shared/contracts';
import {
  JOB_DISCOVERY_MODULE_ID,
  JOB_DISCOVERY_API_VERSION,
  APPLICATIONS_API_VERSION,
  APPLICATIONS_MODULE_ID,
  AUDIO_API_VERSION,
  AUDIO_MODULE_ID,
  DOCUMENTS_API_VERSION,
  DOCUMENTS_MODULE_ID,
  CV_IMPORTS_MODULE_ID,
  CV_IMPORTS_API_VERSION,
  IDENTITY_API_VERSION,
  IDENTITY_MODULE_ID,
  INFERENCE_API_VERSION,
  INFERENCE_MODULE_ID,
  INTERVIEWS_API_VERSION,
  INTERVIEWS_MODULE_ID,
  SYSTEM_API_VERSION,
  SYSTEM_MODULE_ID,
  TELEMETRY_API_VERSION,
  TELEMETRY_MODULE_ID,
  WEB_API_VERSION,
  WEB_MODULE_ID,
  STORAGE_API_VERSION,
  STORAGE_MODULE_ID,
} from '../shared/contracts';

function jobDiscovery<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: JOB_DISCOVERY_MODULE_ID,
    version: JOB_DISCOVERY_API_VERSION,
    action,
    payload,
  });
}
export function listSavedSearches(
  input: SavedSearchListInput = {},
): Promise<SavedSearchPage> {
  return jobDiscovery('savedSearches.list', input);
}
export async function getSavedSearch(id: string): Promise<SavedSearch> {
  return (
    await jobDiscovery<{ item: SavedSearch }>('savedSearches.get', { id })
  ).item;
}
export async function createSavedSearch(
  config: JobDiscoveryConfigurationV1,
): Promise<SavedSearch> {
  return (
    await jobDiscovery<{ item: SavedSearch }>('savedSearches.create', {
      config,
    })
  ).item;
}
export async function updateSavedSearch(
  id: string,
  config: JobDiscoveryConfigurationV1,
): Promise<SavedSearch> {
  return (
    await jobDiscovery<{ item: SavedSearch }>('savedSearches.update', {
      id,
      config,
    })
  ).item;
}
export async function setSavedSearchActive(
  id: string,
  active: boolean,
): Promise<SavedSearch> {
  return (
    await jobDiscovery<{ item: SavedSearch }>('savedSearches.setActive', {
      id,
      active,
    })
  ).item;
}

export async function previewDiscoveryRun(
  savedSearchId: string,
): Promise<string[]> {
  return (
    await jobDiscovery<{ queries: string[] }>('runs.preview', { savedSearchId })
  ).queries;
}
export async function startDiscoveryRun(
  savedSearchId: string,
): Promise<DiscoveryRun> {
  return (
    await jobDiscovery<{ item: DiscoveryRun }>('runs.start', { savedSearchId })
  ).item;
}
export async function cancelDiscoveryRun(id: string): Promise<DiscoveryRun> {
  return (await jobDiscovery<{ item: DiscoveryRun }>('runs.cancel', { id }))
    .item;
}
export function listDiscoveryRuns(
  input: SavedSearchListInput = {},
): Promise<DiscoveryRunPage> {
  return jobDiscovery('runs.list', input);
}
export async function getDiscoveryRun(id: string): Promise<DiscoveryRun> {
  return (await jobDiscovery<{ item: DiscoveryRun }>('runs.get', { id })).item;
}
export async function executeDiscoveryWorkflow(id: string): Promise<void> {
  await jobDiscovery<{ accepted: true }>('runs.workflow.execute', { id });
}
/** Passive, run-scoped read; never advances the workflow. */
export async function getDiscoveryWorkflowState(
  id: string,
): Promise<DiscoveryWorkflowState> {
  return (
    await jobDiscovery<{ state: DiscoveryWorkflowState }>(
      'runs.workflow.state.get',
      { id },
    )
  ).state;
}
export function getResolutionDiagnostics(
  id: string,
  sourceId: string,
): Promise<ResolutionDiagnostics> {
  return jobDiscovery('runs.resolutionDiagnostics', { id, sourceId });
}
export async function executeDiscoveryRun(id: string): Promise<DiscoveryRun> {
  return (await jobDiscovery<{ item: DiscoveryRun }>('runs.execute', { id }))
    .item;
}
export async function getDiscoverySearchProgress(
  id: string,
): Promise<DiscoverySearchProgress> {
  return (
    await jobDiscovery<{ progress: DiscoverySearchProgress }>(
      'runs.searchProgress',
      { id },
    )
  ).progress;
}
export async function listDiscoveryCandidates(
  id: string,
): Promise<DiscoveryCandidate[]> {
  return (
    await jobDiscovery<{ items: DiscoveryCandidate[] }>('runs.candidates', {
      id,
    })
  ).items;
}
export async function resolveDiscoveryRun(
  id: string,
): Promise<DiscoveryCandidate[]> {
  return (
    await jobDiscovery<{ items: DiscoveryCandidate[] }>('runs.resolve', { id })
  ).items;
}
export async function retryCandidateResolution(
  id: string,
  sourceId: string,
): Promise<DiscoveryCandidate> {
  return (
    await jobDiscovery<{ item: DiscoveryCandidate }>('runs.retryResolution', {
      id,
      sourceId,
    })
  ).item;
}
export async function listCandidateCaptures(
  id: string,
  sourceId: string,
): Promise<DiscoveryCapture[]> {
  return (
    await jobDiscovery<{ items: DiscoveryCapture[] }>('runs.captures', {
      id,
      sourceId,
    })
  ).items;
}
export async function listCandidateExtractions(
  id: string,
  sourceId: string,
): Promise<JdExtraction[]> {
  return (
    await jobDiscovery<{ items: JdExtraction[] }>('runs.extractions', {
      id,
      sourceId,
    })
  ).items;
}
export async function extractDiscoveryRun(id: string): Promise<JdExtraction[]> {
  return (await jobDiscovery<{ items: JdExtraction[] }>('runs.extract', { id }))
    .items;
}
export async function retryCandidateExtraction(
  id: string,
  sourceId: string,
): Promise<JdExtraction[]> {
  return (
    await jobDiscovery<{ items: JdExtraction[] }>('runs.retryExtraction', {
      id,
      sourceId,
    })
  ).items;
}

export async function listDiscoveryMatches(
  id: string,
): Promise<DiscoveryMatch[]> {
  return (
    await jobDiscovery<{ items: DiscoveryMatch[] }>('runs.matches', { id })
  ).items;
}
export async function refreshDiscoveryMatches(
  id: string,
): Promise<DiscoveryMatch[]> {
  return (
    await jobDiscovery<{ items: DiscoveryMatch[] }>('runs.refreshMatches', {
      id,
    })
  ).items;
}

export async function listDiscoveryReviews(
  id: string,
): Promise<DiscoveryReview[]> {
  return (
    await jobDiscovery<{ items: DiscoveryReview[] }>('runs.reviews', { id })
  ).items;
}
export async function decideDiscoveryCandidate(
  id: string,
  sourceId: string,
  decision: 'saved' | 'dismissed' | 'new',
): Promise<DiscoveryReview> {
  return (
    await jobDiscovery<{ item: DiscoveryReview }>('runs.decide', {
      id,
      sourceId,
      decision,
    })
  ).item;
}
export async function trackDiscoveryCandidate(
  id: string,
  sourceId: string,
  confirmUnverified: boolean,
  withoutSnapshot: boolean,
): Promise<DiscoveryReview> {
  return (
    await jobDiscovery<{ item: DiscoveryReview }>('runs.track', {
      id,
      sourceId,
      confirmUnverified,
      withoutSnapshot,
    })
  ).item;
}

export function listReviewOpportunities(input: {
  decision: 'new' | 'saved' | 'dismissed' | 'all';
  limit: number;
  cursor?: string;
}): Promise<{ items: OpportunitySummary[]; nextCursor: string | null }> {
  return jobDiscovery('opportunities.list', input);
}

export async function getReviewOpportunity(
  opportunityId: string,
): Promise<OpportunityDetail> {
  return (
    await jobDiscovery<{ item: OpportunityDetail }>('opportunities.get', {
      opportunityId,
    })
  ).item;
}

export async function decideReviewOpportunity(
  opportunityId: string,
  decision: 'new' | 'saved' | 'dismissed',
): Promise<OpportunitySummary> {
  return (
    await jobDiscovery<{ item: OpportunitySummary }>('opportunities.decide', {
      opportunityId,
      decision,
    })
  ).item;
}

export function previewReviewApply(
  opportunityId: string,
): Promise<OpportunityApplyPreview> {
  return jobDiscovery('opportunities.apply.preview', { opportunityId });
}

export async function applyReviewOpportunity(
  opportunityId: string,
  confirmations: {
    confirmUnverified: boolean;
    withoutSnapshot: boolean;
    allowDuplicate: boolean;
  },
): Promise<string> {
  return (
    await jobDiscovery<{ applicationId: string }>('opportunities.apply', {
      opportunityId,
      ...confirmations,
    })
  ).applicationId;
}

function applications<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: APPLICATIONS_MODULE_ID,
    version: APPLICATIONS_API_VERSION,
    action,
    payload,
  });
}
export async function createApplication(
  input: CreateApplicationInput,
): Promise<ApplicationDetail> {
  return (await applications<{ item: ApplicationDetail }>('create', input))
    .item;
}
export function previewApplicationUrl(url: string): Promise<ImportPreview> {
  return applications('imports.preview', { url });
}
export async function listApplications(
  input: Partial<ListApplicationsInput> = {},
): Promise<{ items: Application[]; nextCursor: string | null }> {
  return applications('list', input);
}
export async function getApplication(id: string): Promise<ApplicationDetail> {
  return (await applications<{ item: ApplicationDetail }>('get', { id })).item;
}
export async function updateApplication(
  input: UpdateApplicationInput,
): Promise<Application> {
  return (await applications<{ item: Application }>('update', input)).item;
}
export async function setApplicationArchived(
  id: string,
  archived: boolean,
): Promise<Application> {
  return (
    await applications<{ item: Application }>(
      archived ? 'archive' : 'restore',
      { id },
    )
  ).item;
}
export async function captureApplicationSnapshot(
  id: string,
  snapshot: JobSnapshot,
): Promise<JobSnapshot> {
  return (
    await applications<{ snapshot: JobSnapshot }>('snapshot.capture', {
      id,
      snapshot,
    })
  ).snapshot;
}
export async function recordApplicationStage(
  input: TransitionInput,
  correction = false,
): Promise<StageEvent> {
  return (
    await applications<{ item: StageEvent }>(
      correction ? 'stages.correct' : 'stages.record',
      input,
    )
  ).item;
}
export async function createApplicationNote(input: {
  applicationId: string;
  body: string;
  source: ApplicationNote['source'];
  stageEventId?: string | null;
  observedAt?: string | null;
}): Promise<ApplicationNote> {
  return (await applications<{ item: ApplicationNote }>('notes.create', input))
    .item;
}
export async function updateApplicationNote(
  applicationId: string,
  id: string,
  patch: {
    body?: string;
    source?: ApplicationNote['source'];
    stageEventId?: string | null;
    observedAt?: string | null;
  },
): Promise<ApplicationNote> {
  return (
    await applications<{ item: ApplicationNote }>('notes.update', {
      applicationId,
      id,
      patch,
    })
  ).item;
}
export async function removeApplicationNote(
  applicationId: string,
  id: string,
): Promise<void> {
  await applications('notes.remove', { applicationId, id });
}
export async function linkApplicationDocument(
  applicationId: string,
  documentId: string,
  purpose: ApplicationDocument['purpose'],
  submittedAt?: string,
): Promise<ApplicationDocument> {
  return (
    await applications<{ item: ApplicationDocument }>('documents.link', {
      applicationId,
      documentId,
      purpose,
      submittedAt,
    })
  ).item;
}
export async function unlinkApplicationDocument(
  applicationId: string,
  id: string,
  reason?: string,
): Promise<void> {
  await applications('documents.unlink', { applicationId, id, reason });
}

/** Thin typed wrapper over the preload bridge. */
export async function request<T = unknown>(
  input: RequestInput,
): Promise<ResponseEnvelope<T>> {
  return window.career.request<T>(input);
}

/** An error carrying the typed IPC error code for UI-level handling. */
export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export async function listInsightsSessions(
  input: {
    cursor?: string;
    limit?: number;
    subject?: string;
    method?: InterviewMethod;
    status?: InterviewStatus;
  } = {},
): Promise<{ items: InsightsSession[]; nextCursor: string | null }> {
  return call({
    module: INTERVIEWS_MODULE_ID,
    version: INTERVIEWS_API_VERSION,
    action: 'insights.sessions.list',
    payload: input,
  });
}
export async function listInsightsQuestions(
  input: {
    cursor?: string;
    limit?: number;
    subject?: string;
    method?: InterviewMethod;
    competency?: string;
  } = {},
): Promise<{ items: InsightsQuestion[]; nextCursor: string | null }> {
  return call({
    module: INTERVIEWS_MODULE_ID,
    version: INTERVIEWS_API_VERSION,
    action: 'insights.questions.list',
    payload: input,
  });
}
export async function getInsightsDetail(
  sessionId: string,
): Promise<InsightsDetail> {
  return call({
    module: INTERVIEWS_MODULE_ID,
    version: INTERVIEWS_API_VERSION,
    action: 'insights.sessions.get',
    payload: { sessionId },
  });
}
export async function getInsightsProgress(
  input: { subject?: string; method?: InterviewMethod } = {},
): Promise<InsightsProgress> {
  return call({
    module: INTERVIEWS_MODULE_ID,
    version: INTERVIEWS_API_VERSION,
    action: 'insights.progress.get',
    payload: input,
  });
}

async function call<T>(input: RequestInput): Promise<T> {
  const response = await request<T>(input);
  if (!response.ok) {
    throw new ApiError(response.error.code, response.error.message);
  }
  return response.data;
}

export async function systemPing(): Promise<SystemPingOutput> {
  return call<SystemPingOutput>({
    module: SYSTEM_MODULE_ID,
    version: SYSTEM_API_VERSION,
    action: 'ping',
    payload: {},
  });
}

export function getOnboardingStatus(): Promise<{ completed: boolean }> {
  return call({
    module: SYSTEM_MODULE_ID,
    version: SYSTEM_API_VERSION,
    action: 'onboarding.status.get',
    payload: {},
  });
}

export function completeOnboarding(): Promise<{ completed: boolean }> {
  return call({
    module: SYSTEM_MODULE_ID,
    version: SYSTEM_API_VERSION,
    action: 'onboarding.complete',
    payload: {},
  });
}

export function getStorageUsage(): Promise<StorageUsage> {
  return call({
    module: STORAGE_MODULE_ID,
    version: STORAGE_API_VERSION,
    action: 'usage.get',
    payload: {},
  });
}

export function startStorageReset(): Promise<{ restarting: true }> {
  return call({
    module: STORAGE_MODULE_ID,
    version: STORAGE_API_VERSION,
    action: 'reset.start',
    payload: { confirmation: 'DELETE ALL APPLICATION DATA' },
  });
}

export async function telemetryRunsList(
  limit?: number,
): Promise<OperationRun[]> {
  const data = await call<TelemetryRunsListOutput>({
    module: TELEMETRY_MODULE_ID,
    version: TELEMETRY_API_VERSION,
    action: 'runs.list',
    payload: limit === undefined ? {} : { limit },
  });
  return data.items;
}

// --- web --------------------------------------------------------------------

/** Run a web search through the `web.search` IPC; returns normalized results. */
export async function webSearch(
  query: string,
  searchId?: string,
): Promise<WebSearchOutput> {
  return call<WebSearchOutput>({
    module: WEB_MODULE_ID,
    version: WEB_API_VERSION,
    action: 'search',
    payload: { query, ...(searchId ? { searchId } : {}) },
  });
}

export async function cancelWebSearch(searchId: string): Promise<boolean> {
  return (
    await call<{ cancelled: boolean }>({
      module: WEB_MODULE_ID,
      version: WEB_API_VERSION,
      action: 'search.cancel',
      payload: { searchId },
    })
  ).cancelled;
}

/** Read a page's rendered HTML/text through the `web.readPage` IPC. */
export async function webReadPage(url: string): Promise<PageReadResult> {
  return call<PageReadResult>({
    module: WEB_MODULE_ID,
    version: WEB_API_VERSION,
    action: 'readPage',
    payload: { url },
  });
}

/** List installed browsers and their reader support/launch status (diagnostic). */
export async function webListBrowsers(): Promise<WebBrowsersListOutput> {
  return call<WebBrowsersListOutput>({
    module: WEB_MODULE_ID,
    version: WEB_API_VERSION,
    action: 'browsers.list',
    payload: {},
  });
}

// --- identity ---------------------------------------------------------------

function identity<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: IDENTITY_MODULE_ID,
    version: IDENTITY_API_VERSION,
    action,
    payload,
  });
}

export async function getProfile(): Promise<Profile> {
  const data = await identity<{ profile: Profile }>('profile.get', {});
  return data.profile;
}

export async function listConfirmedSkills(): Promise<string[]> {
  return (await identity<{ names: string[] }>('skills.list', {})).names;
}
export async function replaceConfirmedSkills(
  names: string[],
): Promise<string[]> {
  return (await identity<{ names: string[] }>('skills.replace', { names }))
    .names;
}

export function applyProfileImport(
  input: ApplyImportInput,
): Promise<ApplyImportOutput> {
  return identity('profile.applyImport', input);
}

export async function generateProfileSummary(): Promise<string> {
  return (await identity<{ draft: string }>('summary.generate', {})).draft;
}

export async function updateProfile(patch: ProfilePatch): Promise<Profile> {
  const data = await identity<{ profile: Profile }>('profile.update', {
    patch,
  });
  return data.profile;
}

export async function listTargets(): Promise<Target[]> {
  const data = await identity<{ items: Target[] }>('targets.list', {});
  return data.items;
}

export async function createTarget(input: TargetsCreateInput): Promise<Target> {
  const data = await identity<{ item: Target }>('targets.create', input);
  return data.item;
}

export async function updateTarget(
  id: string,
  patch: TargetPatch,
): Promise<Target> {
  const data = await identity<{ item: Target }>('targets.update', {
    id,
    patch,
  });
  return data.item;
}

export async function deleteTarget(id: string): Promise<void> {
  await identity<{ deleted: true }>('targets.delete', { id });
}

export async function listExperiences(): Promise<Experience[]> {
  const data = await identity<{ items: Experience[] }>('experiences.list', {});
  return data.items;
}

export async function createExperience(
  input: ExperiencesCreateInput,
): Promise<Experience> {
  const data = await identity<{ item: Experience }>(
    'experiences.create',
    input,
  );
  return data.item;
}

export async function updateExperience(
  id: string,
  patch: ExperiencePatch,
): Promise<Experience> {
  const data = await identity<{ item: Experience }>('experiences.update', {
    id,
    patch,
  });
  return data.item;
}

export async function deleteExperience(id: string): Promise<void> {
  await identity<{ deleted: true }>('experiences.delete', { id });
}

// --- documents --------------------------------------------------------------

function documents<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: DOCUMENTS_MODULE_ID,
    version: DOCUMENTS_API_VERSION,
    action,
    payload,
  });
}

export async function importDocument(
  category: DocumentCategory,
): Promise<DocumentsImportOutput> {
  return documents<DocumentsImportOutput>('import', { category });
}

export async function listDocuments(): Promise<Document[]> {
  const data = await documents<{ items: Document[] }>('list', {});
  return data.items;
}

export async function openDocument(id: string): Promise<void> {
  await documents<{ opened: true }>('open', { id });
}

export async function removeDocument(id: string): Promise<void> {
  await documents<{ removed: true }>('remove', { id });
}

function cvImports<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: CV_IMPORTS_MODULE_ID,
    version: CV_IMPORTS_API_VERSION,
    action,
    payload,
  });
}
export async function startCvImport(documentId: string): Promise<CvImport> {
  return (await cvImports<{ item: CvImport }>('start', { documentId })).item;
}
export async function getCvImport(importId: string): Promise<CvImport> {
  return (await cvImports<{ item: CvImport }>('get', { importId })).item;
}
export async function listCvImports(): Promise<Omit<CvImport, 'draft'>[]> {
  return (await cvImports<{ items: Omit<CvImport, 'draft'>[] }>('list', {}))
    .items;
}
export async function retryCvImport(importId: string): Promise<CvImport> {
  return (await cvImports<{ item: CvImport }>('retry', { importId })).item;
}
export async function cancelCvImport(importId: string): Promise<void> {
  await cvImports('cancel', { importId });
}
export async function discardCvImport(importId: string): Promise<void> {
  await cvImports('discard', { importId });
}

// --- interviews -------------------------------------------------------------

function interviews<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: INTERVIEWS_MODULE_ID,
    version: INTERVIEWS_API_VERSION,
    action,
    payload,
  });
}

export async function listInterviewSessions(): Promise<
  InterviewSessionSummary[]
> {
  const data = await interviews<{ items: InterviewSessionSummary[] }>(
    'sessions.list',
    {},
  );
  return data.items;
}

export async function getInterviewSession(
  id: string,
): Promise<InterviewSession> {
  const data = await interviews<{ session: InterviewSession }>('sessions.get', {
    id,
  });
  return data.session;
}

export async function createInterviewSession(
  input: InterviewSessionsCreateInput,
): Promise<InterviewSession> {
  const data = await interviews<{ session: InterviewSession }>(
    'sessions.create',
    input,
  );
  return data.session;
}

export async function updateInterviewSession(
  id: string,
  patch: InterviewSessionPatch,
): Promise<InterviewSession> {
  const data = await interviews<{ session: InterviewSession }>(
    'sessions.update',
    { id, patch },
  );
  return data.session;
}

export async function deleteInterviewSession(id: string): Promise<void> {
  await interviews<{ deleted: true }>('sessions.delete', { id });
}

export async function generateInterviewQuestion(
  sessionId: string,
): Promise<InterviewQuestionsGenerateOutput> {
  return interviews<InterviewQuestionsGenerateOutput>('questions.generate', {
    sessionId,
  });
}

export async function getInterviewPreview(
  sessionId: string,
): Promise<InterviewQuestionsPreviewGetOutput> {
  return interviews<InterviewQuestionsPreviewGetOutput>(
    'questions.preview.get',
    { sessionId },
  );
}

export async function clearInterviewPreview(
  sessionId: string,
): Promise<boolean> {
  const data = await interviews<{ cleared: boolean }>(
    'questions.preview.clear',
    { sessionId },
  );
  return data.cleared;
}

export async function submitInterviewAnswer(
  sessionId: string,
  questionId: string,
  answerText: string,
  audio?: InterviewAnswerAudioLink,
): Promise<InterviewAnswersSubmitOutput> {
  return interviews<InterviewAnswersSubmitOutput>('answers.submit', {
    sessionId,
    questionId,
    answerText,
    ...(audio ? { audio } : {}),
  });
}

export async function getInterviewAnswerDraft(
  sessionId: string,
  questionId: string,
): Promise<InterviewAnswersDraftGetOutput> {
  return interviews<InterviewAnswersDraftGetOutput>('answers.draft.get', {
    sessionId,
    questionId,
  });
}

export async function saveInterviewAnswerDraft(
  sessionId: string,
  questionId: string,
  patch: { recordingId?: string | null; draftText?: string | null },
): Promise<InterviewAnswersDraftSaveOutput> {
  return interviews<InterviewAnswersDraftSaveOutput>('answers.draft.save', {
    sessionId,
    questionId,
    ...patch,
  });
}

export async function clearInterviewAnswerDraft(
  sessionId: string,
  questionId: string,
): Promise<void> {
  await interviews<{ cleared: true }>('answers.draft.clear', {
    sessionId,
    questionId,
  });
}

export async function getInterviewAnswerAudio(
  sessionId: string,
  questionId: string,
): Promise<InterviewAnswersAudioGetOutput> {
  return interviews<InterviewAnswersAudioGetOutput>('answers.audio.get', {
    sessionId,
    questionId,
  });
}

export async function runInterviewReview(
  sessionId: string,
  roundId: string,
): Promise<InterviewReviewsRunOutput> {
  return interviews<InterviewReviewsRunOutput>('reviews.run', {
    sessionId,
    roundId,
  });
}

export async function getInterviewReview(
  sessionId: string,
  roundId: string,
): Promise<InterviewReviewsGetOutput> {
  return interviews<InterviewReviewsGetOutput>('reviews.get', {
    sessionId,
    roundId,
  });
}

export async function runInterviewCoaching(
  sessionId: string,
  roundId: string,
): Promise<InterviewCoachingRunOutput> {
  return interviews<InterviewCoachingRunOutput>('coaching.run', {
    sessionId,
    roundId,
  });
}

export async function generateInterviewReassessment(
  sessionId: string,
  failedRoundId: string,
): Promise<InterviewReassessmentGenerateOutput> {
  return interviews<InterviewReassessmentGenerateOutput>(
    'reassessment.generate',
    { sessionId, failedRoundId },
  );
}

export async function startInterviewSession(
  sessionId: string,
): Promise<InterviewSessionsStartOutput> {
  return interviews<InterviewSessionsStartOutput>('sessions.start', {
    sessionId,
  });
}

export async function getInterviewProgress(
  sessionId: string,
): Promise<InterviewSessionsProgressOutput> {
  return interviews<InterviewSessionsProgressOutput>('sessions.progress', {
    sessionId,
  });
}

export async function advanceInterviewSession(
  sessionId: string,
): Promise<InterviewSessionsAdvanceOutput> {
  return interviews<InterviewSessionsAdvanceOutput>('sessions.advance', {
    sessionId,
  });
}

export async function finishInterviewSession(
  sessionId: string,
  outcome: 'completed' | 'abandoned',
): Promise<InterviewSessionsFinishOutput> {
  return interviews<InterviewSessionsFinishOutput>('sessions.finish', {
    sessionId,
    outcome,
  });
}

export async function cancelInterviewOperation(
  sessionId: string,
): Promise<boolean> {
  const data = await interviews<{ cancelled: boolean }>(
    'sessions.cancelOperation',
    { sessionId },
  );
  return data.cancelled;
}

export async function getInterviewTranscript(
  sessionId: string,
): Promise<InterviewSessionsTranscriptOutput> {
  return interviews<InterviewSessionsTranscriptOutput>('sessions.transcript', {
    sessionId,
  });
}

/** Read-only workflow snapshot; never schedules work. */
export async function getInterviewWorkflowState(
  sessionId: string,
): Promise<InterviewWorkflowState> {
  const data = await interviews<{ state: InterviewWorkflowState }>(
    'workflow.state.get',
    { sessionId },
  );
  return data.state;
}

/** An explicit onward intent; only send actions the snapshot advertises. */
export async function continueInterviewWorkflow(
  sessionId: string,
  action: InterviewWorkflowContinueInput['action'],
): Promise<InterviewWorkflowState> {
  const data = await interviews<{ state: InterviewWorkflowState }>(
    'workflow.continue',
    { sessionId, action },
  );
  return data.state;
}

/** Commit an immutable answer; only when the snapshot advertises `answer`. */
export async function submitInterviewWorkflowAnswer(
  input: InterviewAnswersSubmitInput,
): Promise<InterviewWorkflowState> {
  const data = await interviews<{ state: InterviewWorkflowState }>(
    'workflow.answer.submit',
    input,
  );
  return data.state;
}

/** Durably pause; resuming needs an explicit `workflow.continue`. */
export async function pauseInterviewWorkflow(
  sessionId: string,
): Promise<InterviewWorkflowState> {
  const data = await interviews<{ state: InterviewWorkflowState }>(
    'workflow.pause',
    { sessionId },
  );
  return data.state;
}

/**
 * Ask for results. Quick-fire may return a pending snapshot while reviews
 * finish; polling never starts synthesis, so callers request again when
 * `request_results` is advertised and nothing is running.
 */
export async function requestInterviewResults(
  sessionId: string,
): Promise<InterviewWorkflowState> {
  const data = await interviews<{ state: InterviewWorkflowState }>(
    'workflow.results.request',
    { sessionId },
  );
  return data.state;
}

// --- inference (Local AI) ---------------------------------------------------

function inference<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: INFERENCE_MODULE_ID,
    version: INFERENCE_API_VERSION,
    action,
    payload,
  });
}

export async function getInferenceStatus(): Promise<InferenceStatusGetOutput> {
  return inference<InferenceStatusGetOutput>('status.get', {});
}

export async function getInferenceHardware(): Promise<HardwareProfile> {
  const data = await inference<{ profile: HardwareProfile }>(
    'hardware.get',
    {},
  );
  return data.profile;
}

export async function getProviderHealth(
  providerId: string,
): Promise<ProviderStatus> {
  const data = await inference<{ item: ProviderStatus }>('provider.health', {
    providerId,
  });
  return data.item;
}

export async function listInferenceModels(
  providerId: string,
): Promise<ModelDescriptor[]> {
  const data = await inference<{ items: ModelDescriptor[] }>('models.list', {
    providerId,
  });
  return data.items;
}

export async function recommendInferenceModels(
  providerId: string,
): Promise<ModelRecommendations> {
  return inference<ModelRecommendations>('models.recommend', { providerId });
}

export async function getInferenceSettings(): Promise<InferenceSettingsGetOutput> {
  return inference<InferenceSettingsGetOutput>('settings.get', {});
}

export async function updateInferenceSettings(
  patch: InferenceSettingsPatch,
): Promise<InferenceSettingsUpdateOutput> {
  return inference<InferenceSettingsUpdateOutput>('settings.update', { patch });
}

export async function listInferenceDiagnostics(
  limit?: number,
): Promise<InferenceOperationSummary[]> {
  const data = await inference<InferenceDiagnosticsListOutput>(
    'diagnostics.list',
    limit === undefined ? {} : { limit },
  );
  return data.items;
}

export async function runInferenceTest(): Promise<InferenceTestRunOutput> {
  return inference<InferenceTestRunOutput>('test.run', {});
}

export async function getInferenceTest(
  testId: string,
): Promise<InferenceTestSnapshot> {
  const data = await inference<InferenceTestGetOutput>('test.get', { testId });
  return data.test;
}

export async function cancelInferenceTest(testId: string): Promise<boolean> {
  const data = await inference<{ cancelled: boolean }>('test.cancel', {
    testId,
  });
  return data.cancelled;
}

// --- audio ------------------------------------------------------------------

function audio<T>(action: string, payload: unknown): Promise<T> {
  return call<T>({
    module: AUDIO_MODULE_ID,
    version: AUDIO_API_VERSION,
    action,
    payload,
  });
}

export function audioCaptureBegin(
  label?: string,
): Promise<AudioCaptureBeginOutput> {
  return audio<AudioCaptureBeginOutput>(
    'capture.begin',
    label === undefined ? {} : { label },
  );
}

export function audioCaptureAppend(
  captureId: string,
  token: string,
  sequence: number,
  chunk: string,
): Promise<AudioCaptureAppendOutput> {
  return audio<AudioCaptureAppendOutput>('capture.append', {
    captureId,
    token,
    sequence,
    chunk,
  });
}

export async function audioCaptureComplete(
  captureId: string,
  token: string,
): Promise<AudioRecording> {
  const data = await audio<{ recording: AudioRecording }>('capture.complete', {
    captureId,
    token,
  });
  return data.recording;
}

export async function audioCaptureCancel(
  captureId: string,
  token: string,
): Promise<void> {
  await audio<{ cancelled: true }>('capture.cancel', { captureId, token });
}

export async function audioList(): Promise<AudioRecording[]> {
  const data = await audio<{ items: AudioRecording[] }>('list', {});
  return data.items;
}

export function audioPlaybackOpen(
  id: string,
): Promise<AudioPlaybackOpenOutput> {
  return audio<AudioPlaybackOpenOutput>('playback.open', { id });
}

export function audioPlaybackRead(
  id: string,
  token: string,
  offset: number,
  length: number,
): Promise<AudioPlaybackReadOutput> {
  return audio<AudioPlaybackReadOutput>('playback.read', {
    id,
    token,
    offset,
    length,
  });
}

export async function audioPlaybackClose(
  id: string,
  token: string,
): Promise<void> {
  await audio<{ closed: true }>('playback.close', { id, token });
}

// --- audio: speech-to-text (Stage 008.2) ------------------------------------

export async function audioSttProvidersList(): Promise<SttProvider[]> {
  const data = await audio<AudioSttProvidersListOutput>(
    'stt.providers.list',
    {},
  );
  return data.items;
}

export async function audioSttProvidersVerify(
  providerId: string,
): Promise<AudioSttProvidersVerifyOutput> {
  return audio<AudioSttProvidersVerifyOutput>('stt.providers.verify', {
    providerId,
  });
}

export async function audioSttJobsStart(
  recordingId: string,
  options?: { providerId?: string; languageHint?: string },
): Promise<SttJob> {
  const data = await audio<{ job: SttJob }>('stt.jobs.start', {
    recordingId,
    ...(options?.providerId ? { providerId: options.providerId } : {}),
    ...(options?.languageHint ? { languageHint: options.languageHint } : {}),
  });
  return data.job;
}

export async function audioSttJobsGet(jobId: string): Promise<SttJob> {
  const data = await audio<{ job: SttJob }>('stt.jobs.get', { jobId });
  return data.job;
}

export async function audioSttJobsList(
  recordingId?: string,
): Promise<SttJob[]> {
  const data = await audio<AudioSttJobsListOutput>(
    'stt.jobs.list',
    recordingId === undefined ? {} : { recordingId },
  );
  return data.items;
}

export async function audioSttJobsCancel(jobId: string): Promise<void> {
  await audio<{ cancelled: true }>('stt.jobs.cancel', { jobId });
}

export async function audioSttJobsRetry(jobId: string): Promise<SttJob> {
  const data = await audio<{ job: SttJob }>('stt.jobs.retry', { jobId });
  return data.job;
}

export async function audioSttTranscriptsGet(
  transcriptId: string,
): Promise<SttTranscript> {
  const data = await audio<{ transcript: SttTranscript }>(
    'stt.transcripts.get',
    { transcriptId },
  );
  return data.transcript;
}
