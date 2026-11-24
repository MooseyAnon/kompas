import { z } from 'zod';

/** Public API major version for the `documents` module. */
export const DOCUMENTS_API_VERSION = 1;

/** Stable module id used to namespace this module's IPC channels. */
export const DOCUMENTS_MODULE_ID = 'documents';

/** Document category enum; matches the `documents.category` CHECK. */
export const DOCUMENT_CATEGORIES = ['cv', 'cover_letter', 'other'] as const;
export const documentCategorySchema = z.enum(DOCUMENT_CATEGORIES);
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** Maximum size of an imported document (25 MiB). */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Supported import formats. Extension/MIME are hints only; the main process
 * additionally verifies file content (magic bytes) before storing.
 */
export const SUPPORTED_DOCUMENT_TYPES = [
  {
    extension: 'pdf',
    mediaType: 'application/pdf',
  },
  {
    extension: 'docx',
    mediaType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
] as const;

/**
 * Safe public projection of a `documents` row. The internal `relative_path`
 * and any absolute filesystem path are deliberately never exposed; documents
 * are addressed by id only.
 */
export const documentSchema = z.object({
  id: z.string().min(1),
  category: documentCategorySchema,
  originalName: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  createdAt: z.string().min(1),
});
export type Document = z.infer<typeof documentSchema>;

// --- documents.import -------------------------------------------------------

export const documentsImportInputSchema = z
  .object({
    category: documentCategorySchema,
    /** `drop` imports the file just dropped on the window instead of opening the picker. */
    source: z.enum(['picker', 'drop']).optional(),
  })
  .strict();
export type DocumentsImportInput = z.infer<typeof documentsImportInputSchema>;

/** The native picker may be cancelled; cancellation is not an error. */
export const documentsImportOutputSchema = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(true) }),
  z.object({ cancelled: z.literal(false), item: documentSchema }),
]);
export type DocumentsImportOutput = z.infer<typeof documentsImportOutputSchema>;

// --- documents.list ---------------------------------------------------------

export const documentsListInputSchema = z.object({}).strict();

export const documentsListOutputSchema = z.object({
  items: z.array(documentSchema),
});
export type DocumentsListOutput = z.infer<typeof documentsListOutputSchema>;

// --- documents.open ---------------------------------------------------------

export const documentsOpenInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export type DocumentsOpenInput = z.infer<typeof documentsOpenInputSchema>;

export const documentsOpenOutputSchema = z.object({
  opened: z.literal(true),
});
export type DocumentsOpenOutput = z.infer<typeof documentsOpenOutputSchema>;

// --- documents.remove -------------------------------------------------------

export const documentsRemoveInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export type DocumentsRemoveInput = z.infer<typeof documentsRemoveInputSchema>;

export const documentsRemoveOutputSchema = z.object({
  removed: z.literal(true),
});
export type DocumentsRemoveOutput = z.infer<typeof documentsRemoveOutputSchema>;
