import {
  TELEMETRY_API_VERSION,
  TELEMETRY_MODULE_ID,
  telemetryRunsListInputSchema,
  telemetryRunsListOutputSchema,
  type TelemetryRunsListInput,
  type TelemetryRunsListOutput,
} from '../../../shared/contracts';
import type { ModuleManifest } from '../../ipc/dispatcher';
import type { TelemetryService } from './telemetry.service';

/** Build the statically-registered `telemetry` module manifest (API major v1). */
export function createTelemetryModule(
  service: TelemetryService,
): ModuleManifest {
  return {
    id: TELEMETRY_MODULE_ID,
    apiMajor: TELEMETRY_API_VERSION,
    commands: {
      'runs.list': {
        input: telemetryRunsListInputSchema,
        output: telemetryRunsListOutputSchema,
        handle: (input): TelemetryRunsListOutput => {
          const { limit } = input as TelemetryRunsListInput;
          return { items: service.list(limit) };
        },
      },
    },
  };
}
