import {
  DOCUMENTS_API_VERSION,
  DOCUMENTS_MODULE_ID,
  documentsImportInputSchema,
  documentsImportOutputSchema,
  documentsListInputSchema,
  documentsListOutputSchema,
  documentsOpenInputSchema,
  documentsOpenOutputSchema,
  documentsRemoveInputSchema,
  documentsRemoveOutputSchema,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import type { DocumentsService } from './documents.service';

/** Build the statically-registered `documents` module manifest (API major v1). */
export function createDocumentsModule(
  service: DocumentsService,
): ModuleManifest {
  return {
    id: DOCUMENTS_MODULE_ID,
    apiMajor: DOCUMENTS_API_VERSION,
    commands: {
      import: defineCommand({
        input: documentsImportInputSchema,
        output: documentsImportOutputSchema,
        handle: (input) => service.import(input.category),
      }),
      list: defineCommand({
        input: documentsListInputSchema,
        output: documentsListOutputSchema,
        handle: () => ({ items: service.list() }),
      }),
      open: defineCommand({
        input: documentsOpenInputSchema,
        output: documentsOpenOutputSchema,
        handle: (input) => service.open(input.id),
      }),
      remove: defineCommand({
        input: documentsRemoveInputSchema,
        output: documentsRemoveOutputSchema,
        handle: (input) => service.remove(input.id),
      }),
    },
  };
}
