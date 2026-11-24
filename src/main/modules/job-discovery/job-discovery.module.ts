import {
  JOB_DISCOVERY_MODULE_ID,
  JOB_DISCOVERY_API_VERSION,
  savedSearchCreateInput,
  savedSearchUpdateInput,
  savedSearchIdInput,
  savedSearchActiveInput,
  savedSearchListInput,
  savedSearchOutput,
  savedSearchListOutput,
  discoveryRunStartInput,
  discoveryRunIdInput,
  discoveryRunListInput,
  discoveryRunOutput,
  discoveryRunListOutput,
  discoveryPlanOutput,
  discoveryCandidatesOutput,
  discoverySourceInput,
  discoveryCandidateOutput,
  discoveryCapturesOutput,
  jdExtractionsOutput,
  discoveryFocusInput,
  discoveryFocusOutput,
  discoveryMatchesOutput,
  discoveryDecideInput,
  discoveryTrackInput,
  discoveryReviewsOutput,
  discoveryReviewOutput,
  discoverySearchProgressOutput,
  discoveryWorkflowExecuteOutput,
  discoveryWorkflowStateOutput,
  resolutionDiagnosticsOutput,
  opportunityListInput,
  opportunityListOutput,
  opportunityIdInput,
  opportunityDetailOutput,
  opportunityDecideInput,
  opportunityDecideOutput,
  opportunityApplyInput,
  opportunityApplyOutput,
  opportunityApplyPreviewOutput,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import type { SavedSearchesService } from './saved-searches.service';
import type { DiscoveryRunsService } from './runs.service';
import type { OpportunitiesService } from './opportunities.service';

type CommandMap = ModuleManifest['commands'];

export function createJobDiscoveryModule(
  service: SavedSearchesService,
  runs: DiscoveryRunsService,
  opportunities?: OpportunitiesService,
): ModuleManifest {
  return {
    id: JOB_DISCOVERY_MODULE_ID,
    apiMajor: JOB_DISCOVERY_API_VERSION,
    commands: {
      ...(opportunities ? opportunityCommands(opportunities, runs) : {}),
      ...savedSearchCommands(service),
      ...runLifecycleCommands(runs),
      ...runPipelineCommands(runs),
    },
  };
}

function opportunityCommands(
  opportunities: OpportunitiesService,
  runs: DiscoveryRunsService,
): CommandMap {
  return {
    'opportunities.list': defineCommand({
      input: opportunityListInput,
      output: opportunityListOutput,
      handle: (input) => opportunities.list(input),
    }),
    'opportunities.get': defineCommand({
      input: opportunityIdInput,
      output: opportunityDetailOutput,
      handle: (input) => ({ item: opportunities.get(input) }),
    }),
    'opportunities.decide': defineCommand({
      input: opportunityDecideInput,
      output: opportunityDecideOutput,
      handle: (input) => ({ item: opportunities.decide(input) }),
    }),
    'opportunities.apply.preview': defineCommand({
      input: opportunityIdInput,
      output: opportunityApplyPreviewOutput,
      handle: (input) => runs.applyPreview(input.opportunityId),
    }),
    'opportunities.apply': defineCommand({
      input: opportunityApplyInput,
      output: opportunityApplyOutput,
      handle: (input) => ({ applicationId: runs.apply(input) }),
    }),
  };
}

function savedSearchCommands(service: SavedSearchesService): CommandMap {
  return {
    'savedSearches.create': defineCommand({
      input: savedSearchCreateInput,
      output: savedSearchOutput,
      handle: (input) => ({ item: service.create(input) }),
    }),
    'savedSearches.get': defineCommand({
      input: savedSearchIdInput,
      output: savedSearchOutput,
      handle: (input) => ({ item: service.get(input) }),
    }),
    'savedSearches.list': defineCommand({
      input: savedSearchListInput,
      output: savedSearchListOutput,
      handle: (input) => service.list(input),
    }),
    'savedSearches.update': defineCommand({
      input: savedSearchUpdateInput,
      output: savedSearchOutput,
      handle: (input) => ({ item: service.update(input) }),
    }),
    'savedSearches.setActive': defineCommand({
      input: savedSearchActiveInput,
      output: savedSearchOutput,
      handle: (input) => ({ item: service.setActive(input) }),
    }),
  };
}

function runLifecycleCommands(runs: DiscoveryRunsService): CommandMap {
  return {
    'runs.preview': defineCommand({
      input: discoveryRunStartInput,
      output: discoveryPlanOutput,
      handle: (input) => ({ queries: runs.preview(input) }),
    }),
    'runs.start': defineCommand({
      input: discoveryRunStartInput,
      output: discoveryRunOutput,
      handle: (input) => ({ item: runs.start(input) }),
    }),
    'runs.get': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryRunOutput,
      handle: (input) => ({ item: runs.get(input) }),
    }),
    'runs.searchProgress': defineCommand({
      input: discoveryRunIdInput,
      output: discoverySearchProgressOutput,
      handle: (input) => ({ progress: runs.searchProgress(input) }),
    }),
    'runs.list': defineCommand({
      input: discoveryRunListInput,
      output: discoveryRunListOutput,
      handle: (input) => runs.list(input),
    }),
    'runs.focus': defineCommand({
      input: discoveryFocusInput,
      output: discoveryFocusOutput,
      handle: (input) => {
        runs.focus(input.opportunityIds);
        return { ok: true as const };
      },
    }),
    'runs.cancel': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryRunOutput,
      handle: (input) => ({ item: runs.cancel(input) }),
    }),
    'runs.execute': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryRunOutput,
      handle: async (input) => ({ item: await runs.execute(input) }),
    }),
    'runs.workflow.execute': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryWorkflowExecuteOutput,
      handle: (input) => runs.executeWorkflow(input),
    }),
    'runs.workflow.state.get': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryWorkflowStateOutput,
      handle: (input) => ({ state: runs.workflowState(input) }),
    }),
  };
}

/** Resolution, extraction, matching and review commands for a run. */
function runPipelineCommands(runs: DiscoveryRunsService): CommandMap {
  return {
    'runs.candidates': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryCandidatesOutput,
      handle: (input) => ({ items: runs.candidates(input) }),
    }),
    'runs.resolve': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryCandidatesOutput,
      handle: async (input) => ({ items: await runs.resolve(input) }),
    }),
    'runs.retryResolution': defineCommand({
      input: discoverySourceInput,
      output: discoveryCandidateOutput,
      handle: async (input) => ({ item: await runs.retryResolution(input) }),
    }),
    'runs.captures': defineCommand({
      input: discoverySourceInput,
      output: discoveryCapturesOutput,
      handle: (input) => ({ items: runs.captures(input) }),
    }),
    'runs.resolutionDiagnostics': defineCommand({
      input: discoverySourceInput,
      output: resolutionDiagnosticsOutput,
      handle: (input) => runs.resolutionDiagnostics(input),
    }),
    'runs.extractions': defineCommand({
      input: discoverySourceInput,
      output: jdExtractionsOutput,
      handle: (input) => ({ items: runs.extractions(input) }),
    }),
    'runs.extract': defineCommand({
      input: discoveryRunIdInput,
      output: jdExtractionsOutput,
      handle: async (input) => ({ items: await runs.extract(input) }),
    }),
    'runs.retryExtraction': defineCommand({
      input: discoverySourceInput,
      output: jdExtractionsOutput,
      handle: async (input) => ({ items: await runs.retryExtraction(input) }),
    }),
    'runs.matches': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryMatchesOutput,
      handle: (input) => ({ items: runs.matches(input) }),
    }),
    'runs.refreshMatches': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryMatchesOutput,
      handle: (input) => ({ items: runs.refreshMatches(input) }),
    }),
    'runs.reviews': defineCommand({
      input: discoveryRunIdInput,
      output: discoveryReviewsOutput,
      handle: (input) => ({ items: runs.reviews(input) }),
    }),
    'runs.decide': defineCommand({
      input: discoveryDecideInput,
      output: discoveryReviewOutput,
      handle: (input) => ({ item: runs.decide(input) }),
    }),
    'runs.track': defineCommand({
      input: discoveryTrackInput,
      output: discoveryReviewOutput,
      handle: (input) => ({ item: runs.track(input) }),
    }),
  };
}
