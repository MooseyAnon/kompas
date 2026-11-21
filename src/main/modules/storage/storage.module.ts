import {
  STORAGE_API_VERSION,
  STORAGE_MODULE_ID,
  storageUsageInputSchema,
  storageUsageOutputSchema,
  storageResetInputSchema,
  storageResetOutputSchema,
} from '../../../shared/contracts';
import type { ModuleManifest } from '../../ipc/dispatcher';
import { storageUsage } from '../../core/storage-maintenance';

export function createStorageModule(
  dataDir: string,
  reset: () => Promise<void>,
): ModuleManifest {
  return {
    id: STORAGE_MODULE_ID,
    apiMajor: STORAGE_API_VERSION,
    commands: {
      'usage.get': {
        input: storageUsageInputSchema,
        output: storageUsageOutputSchema,
        handle: () => storageUsage(dataDir),
      },
      'reset.start': {
        input: storageResetInputSchema,
        output: storageResetOutputSchema,
        handle: async () => {
          await reset();
          return { restarting: true as const };
        },
      },
    },
  };
}
