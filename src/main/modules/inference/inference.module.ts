import { z } from 'zod';
import {
  INFERENCE_API_VERSION,
  INFERENCE_MODULE_ID,
  inferenceDiagnosticsListInputSchema,
  inferenceDiagnosticsListOutputSchema,
  inferenceHardwareGetInputSchema,
  inferenceHardwareGetOutputSchema,
  inferenceModelsListInputSchema,
  inferenceModelsListOutputSchema,
  inferenceModelsRecommendInputSchema,
  inferenceModelsRecommendOutputSchema,
  inferenceProviderHealthInputSchema,
  inferenceProviderHealthOutputSchema,
  inferenceProvidersListInputSchema,
  inferenceProvidersListOutputSchema,
  inferenceSettingsGetInputSchema,
  inferenceSettingsGetOutputSchema,
  inferenceSettingsUpdateInputSchema,
  inferenceSettingsUpdateOutputSchema,
  inferenceStatusGetInputSchema,
  inferenceStatusGetOutputSchema,
  inferenceTestCancelInputSchema,
  inferenceTestCancelOutputSchema,
  inferenceTestGetInputSchema,
  inferenceTestGetOutputSchema,
  inferenceTestRunInputSchema,
  inferenceTestRunOutputSchema,
  workerStateSchema,
  type GenerationResult,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import { MOCK_MODELS, MOCK_PROVIDER_ID } from './mock-provider';
import {
  EXAMPLE_TOOL_NAMES,
  EXAMPLES_MODULE_ID,
} from '../../core/tools/example-tools';
import type { InferenceService } from './inference.service';

export interface InferenceModuleOptions {
  /**
   * Register narrow dev/smoke-only actions that drive a real end-to-end
   * generation through the worker. Never enabled for ordinary end users; used
   * only by the packaged smoke harness behind an explicit flag.
   */
  devActions?: boolean;
}

const devSelfTestOutputSchema = z.object({
  workerState: workerStateSchema,
  status: z.enum(['completed', 'cancelled', 'failed']),
  output: z.string().nullable(),
});

const devCrashRecoverOutputSchema = z.object({
  crashedStatus: z.enum(['completed', 'cancelled', 'failed']),
  crashedCode: z.string().nullable(),
  crashedLastCode: z.string().nullable(),
  recoveredStatus: z.enum(['completed', 'cancelled', 'failed']),
  recoveredOutput: z.string().nullable(),
  workerStateAfter: workerStateSchema,
});

const devToolSelfTestOutputSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'failed']),
  output: z.string().nullable(),
  toolResults: z.number().int().nonnegative(),
  deniedStatus: z.enum(['completed', 'cancelled', 'failed']),
  deniedOutput: z.string().nullable(),
});

/** A generation's output when it is plain text, otherwise `null`. */
function textOutput(result: GenerationResult): string | null {
  return typeof result.output === 'string' ? result.output : null;
}

/** Build the statically-registered `inference` module manifest (API major v1). */
export function createInferenceModule(
  service: InferenceService,
  options: InferenceModuleOptions = {},
): ModuleManifest {
  const commands = publicCommands(service);

  if (options.devActions) {
    commands['__dev.selfTest'] = devSelfTestCommand(service);
    commands['__dev.crashRecover'] = devCrashRecoverCommand(service);
    commands['__dev.toolSelfTest'] = devToolSelfTestCommand(service);
  }

  return {
    id: INFERENCE_MODULE_ID,
    apiMajor: INFERENCE_API_VERSION,
    commands,
  };
}

/** The narrow, validated actions available to the renderer. */
function publicCommands(service: InferenceService): ModuleManifest['commands'] {
  return {
    'status.get': defineCommand({
      input: inferenceStatusGetInputSchema,
      output: inferenceStatusGetOutputSchema,
      handle: () => service.getStatusSnapshot(),
    }),
    'hardware.get': defineCommand({
      input: inferenceHardwareGetInputSchema,
      output: inferenceHardwareGetOutputSchema,
      handle: () => ({ profile: service.getHardwareProfile() }),
    }),
    'providers.list': defineCommand({
      input: inferenceProvidersListInputSchema,
      output: inferenceProvidersListOutputSchema,
      handle: async () => ({ items: await service.getProvidersSnapshot() }),
    }),
    'provider.health': defineCommand({
      input: inferenceProviderHealthInputSchema,
      output: inferenceProviderHealthOutputSchema,
      handle: async (input) => ({
        item: await service.getProviderHealth(input.providerId),
      }),
    }),
    'models.list': defineCommand({
      input: inferenceModelsListInputSchema,
      output: inferenceModelsListOutputSchema,
      handle: async (input) => ({
        items: await service.listModels(input.providerId),
      }),
    }),
    'models.recommend': defineCommand({
      input: inferenceModelsRecommendInputSchema,
      output: inferenceModelsRecommendOutputSchema,
      handle: (input) => service.recommendModels(input.providerId),
    }),
    'settings.get': defineCommand({
      input: inferenceSettingsGetInputSchema,
      output: inferenceSettingsGetOutputSchema,
      handle: () => service.getSettingsSnapshot(),
    }),
    'settings.update': defineCommand({
      input: inferenceSettingsUpdateInputSchema,
      output: inferenceSettingsUpdateOutputSchema,
      handle: async (input) => ({
        settings: await service.updateSettings(input.patch),
      }),
    }),
    'diagnostics.list': defineCommand({
      input: inferenceDiagnosticsListInputSchema,
      output: inferenceDiagnosticsListOutputSchema,
      handle: (input) => ({ items: service.listDiagnostics(input.limit) }),
    }),
    'test.run': defineCommand({
      input: inferenceTestRunInputSchema,
      output: inferenceTestRunOutputSchema,
      handle: () => service.startTest(),
    }),
    'test.get': defineCommand({
      input: inferenceTestGetInputSchema,
      output: inferenceTestGetOutputSchema,
      handle: (input) => ({ test: service.getTest(input.testId) }),
    }),
    'test.cancel': defineCommand({
      input: inferenceTestCancelInputSchema,
      output: inferenceTestCancelOutputSchema,
      handle: async (input) => ({
        cancelled: await service.cancelTest(input.testId),
      }),
    }),
  };
}

/** Dev/smoke-only: one plain mock generation through the real worker. */
function devSelfTestCommand(
  service: InferenceService,
): ModuleManifest['commands'][string] {
  return defineCommand({
    input: z.object({}).strict(),
    output: devSelfTestOutputSchema,
    handle: async () => {
      const result = await service.generate({
        callerModule: 'inference',
        execution: { priority: 'interactive' },
        providerId: MOCK_PROVIDER_ID,
        modelId: MOCK_MODELS.static,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return {
        workerState: service.getWorkerState(),
        status: result.status,
        output: textOutput(result),
      };
    },
  });
}

/** Dev/smoke-only: crash the worker mid-run, then prove it recovers. */
function devCrashRecoverCommand(
  service: InferenceService,
): ModuleManifest['commands'][string] {
  return defineCommand({
    input: z.object({}).strict(),
    output: devCrashRecoverOutputSchema,
    handle: async () => {
      const crashed = await service.generate({
        callerModule: 'inference',
        execution: { priority: 'interactive', retry: { maxRetries: 0 } },
        providerId: MOCK_PROVIDER_ID,
        modelId: MOCK_MODELS.faultCrash,
        messages: [{ role: 'user', content: 'crash' }],
        limits: { timeoutMs: 5_000 },
      });
      const recovered = await service.generate({
        callerModule: 'inference',
        execution: { priority: 'interactive' },
        providerId: MOCK_PROVIDER_ID,
        modelId: MOCK_MODELS.static,
        messages: [{ role: 'user', content: 'again' }],
      });
      return {
        crashedStatus: crashed.status,
        crashedCode: crashed.error?.code ?? null,
        crashedLastCode: crashed.lastErrorCode ?? null,
        recoveredStatus: recovered.status,
        recoveredOutput: textOutput(recovered),
        workerStateAfter: service.getWorkerState(),
      };
    },
  });
}

/** Dev/smoke-only: one authorised tool run and one denied write tool. */
function devToolSelfTestCommand(
  service: InferenceService,
): ModuleManifest['commands'][string] {
  return defineCommand({
    input: z.object({}).strict(),
    output: devToolSelfTestOutputSchema,
    handle: async () => {
      // Authorised read tool: runs end-to-end through worker↔broker↔handler.
      let toolResults = 0;
      const allowed = await service.generate({
        callerModule: EXAMPLES_MODULE_ID,
        execution: {
          priority: 'interactive',
          onEvent: (event) => {
            if (event.kind === 'tool_result' && event.ok) toolResults += 1;
          },
        },
        providerId: MOCK_PROVIDER_ID,
        modelId: MOCK_MODELS.toolsAdd,
        messages: [{ role: 'user', content: 'add' }],
        toolNames: [EXAMPLE_TOOL_NAMES.addNumbers],
      });
      // A write tool proposed without approval must be denied, not executed.
      const denied = await service.generate({
        execution: { priority: 'interactive' },
        providerId: MOCK_PROVIDER_ID,
        modelId: MOCK_MODELS.toolsWrite,
        messages: [{ role: 'user', content: 'write' }],
        callerModule: EXAMPLES_MODULE_ID,
        toolNames: [EXAMPLE_TOOL_NAMES.writeNote],
      });
      return {
        status: allowed.status,
        output: textOutput(allowed),
        toolResults,
        deniedStatus: denied.status,
        deniedOutput: textOutput(denied),
      };
    },
  });
}
