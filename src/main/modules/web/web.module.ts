import {
  WEB_API_VERSION,
  WEB_MODULE_ID,
  webBrowsersListOutputSchema,
  webReadPageInputSchema,
  webReadPageOutputSchema,
  webSearchInputSchema,
  webSearchOutputSchema,
  webSearchCancelInputSchema,
  webSearchCancelOutputSchema,
} from '../../../shared/contracts';
import { z } from 'zod';
import { AppError } from '../../ipc/errors';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import { isWebError, toPublicErrorCode } from './web.error';
import type { WebService } from './web.service';

/**
 * Build the statically-registered `web` module manifest (API major v1).
 *
 * Stage 009.2 adds the `readPage` reader and the `browsers.list` diagnostic
 * alongside `search`. Detailed {@link WebError} codes are translated to the
 * narrow public IPC vocabulary here; raw upstream messages, query text, URLs
 * and browser paths never cross the boundary in errors.
 */
export function createWebModule(service: WebService): ModuleManifest {
  const searches = new Map<string, AbortController>();

  return {
    id: WEB_MODULE_ID,
    apiMajor: WEB_API_VERSION,
    commands: {
      search: defineCommand({
        input: webSearchInputSchema,
        output: webSearchOutputSchema,
        handle: async (input) => {
          if (!input.searchId) {
            return mapWebErrors(() => service.search(input.query));
          }

          if (searches.has(input.searchId)) {
            throw new AppError('CONFLICT', 'Search is already running.');
          }

          const controller = new AbortController();
          searches.set(input.searchId, controller);
          try {
            return await mapWebErrors(() =>
              service.search(input.query, { signal: controller.signal }),
            );
          } finally {
            searches.delete(input.searchId);
          }
        },
      }),
      'search.cancel': defineCommand({
        input: webSearchCancelInputSchema,
        output: webSearchCancelOutputSchema,
        handle: (input) => {
          const controller = searches.get(input.searchId);
          controller?.abort();

          return { cancelled: !!controller };
        },
      }),
      readPage: defineCommand({
        input: webReadPageInputSchema,
        output: webReadPageOutputSchema,
        handle: async (input) =>
          mapWebErrors(() => service.readPage(input.url)),
      }),
      'browsers.list': defineCommand({
        input: z.object({}).strict(),
        output: webBrowsersListOutputSchema,
        handle: async () => mapWebErrors(() => service.listBrowsers()),
      }),
    },
  };
}

async function mapWebErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isWebError(error)) {
      throw new AppError(toPublicErrorCode(error.code), error.safeMessage);
    }

    throw error;
  }
}
