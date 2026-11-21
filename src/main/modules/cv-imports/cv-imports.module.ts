import {
  CV_IMPORTS_MODULE_ID,
  CV_IMPORTS_API_VERSION,
  cvStartInputSchema,
  cvIdInputSchema,
  cvListInputSchema,
  cvImportOutputSchema,
  cvListOutputSchema,
  cvCancelOutputSchema,
  cvDiscardOutputSchema,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import type { CvImportsService } from './cv-imports.service';

export function createCvImportsModule(
  service: CvImportsService,
): ModuleManifest {
  return {
    id: CV_IMPORTS_MODULE_ID,
    apiMajor: CV_IMPORTS_API_VERSION,
    commands: {
      start: defineCommand({
        input: cvStartInputSchema,
        output: cvImportOutputSchema,
        handle: (input) => ({ item: service.start(input.documentId) }),
      }),
      get: defineCommand({
        input: cvIdInputSchema,
        output: cvImportOutputSchema,
        handle: (input) => ({ item: service.get(input.importId) }),
      }),
      list: defineCommand({
        input: cvListInputSchema,
        output: cvListOutputSchema,
        handle: (input) => ({ items: service.list(input.limit) }),
      }),
      retry: defineCommand({
        input: cvIdInputSchema,
        output: cvImportOutputSchema,
        handle: (input) => ({ item: service.retry(input.importId) }),
      }),
      cancel: defineCommand({
        input: cvIdInputSchema,
        output: cvCancelOutputSchema,
        handle: (input) => service.cancel(input.importId),
      }),
      discard: defineCommand({
        input: cvIdInputSchema,
        output: cvDiscardOutputSchema,
        handle: (input) => service.discard(input.importId),
      }),
    },
  };
}
