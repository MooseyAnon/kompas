import { z } from 'zod';

export const STORAGE_MODULE_ID = 'storage';
export const STORAGE_API_VERSION = 1;

/** Managed storage areas; usage always reports every category exactly once. */
export const storageCategorySchema = z.enum([
  'database',
  'documents',
  'audio',
  'logs',
  'cache',
  'session',
]);

export const storageUsageInputSchema = z.object({}).strict();

export const storageUsageOutputSchema = z.object({
  categories: z
    .array(
      z
        .object({
          category: storageCategorySchema,
          bytes: z.number().nonnegative().safe().nullable(),
        })
        .strict(),
    )
    .length(storageCategorySchema.options.length),
  totalBytes: z.number().nonnegative().safe().nullable(),
  partial: z.boolean(),
});
export type StorageUsage = z.infer<typeof storageUsageOutputSchema>;

/**
 * Destructive reset requires the exact confirmation phrase typed by the user.
 */
export const storageResetInputSchema = z
  .object({
    confirmation: z.literal('DELETE ALL APPLICATION DATA'),
  })
  .strict();

export const storageResetOutputSchema = z
  .object({ restarting: z.literal(true) })
  .strict();
