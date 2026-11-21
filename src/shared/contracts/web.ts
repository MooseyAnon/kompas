import { z } from 'zod';

/** Public API major version for the `web` module. */
export const WEB_API_VERSION = 1;
export const WEB_MODULE_ID = 'web';

// --- Capabilities -----------------------------------------------------------

/**
 * Stable capability vocabulary for the Web domain. Capabilities are the stable
 * operations; adapters advertise which subset they implement. `readPage` is
 * reserved here (Stage 009.2) and is intentionally *not* exposed as a public
 * command until a real adapter implements it — no stubbed behaviour.
 */
export const WEB_CAPABILITIES = ['search', 'readPage'] as const;
export type WebCapability = (typeof WEB_CAPABILITIES)[number];

// --- Bounded limits ---------------------------------------------------------

/** Conservative, centrally owned guardrails for web operations. */
export const WEB_LIMITS = {
  minQueryChars: 1,
  maxQueryChars: 256,
  maxResults: 20,
  maxTitleChars: 400,
  maxSnippetChars: 600,
  maxUrlChars: 2048,
  /**
   * Hard cap on provider attempts for one resolve, independent of policy size.
   */
  maxAttempts: 4,
  /** Total time budget for a single `readPage` operation. */
  readPageTimeoutMs: 25_000,
  /**
   * Required readPage settling wait after `domcontentloaded`, within the read
   * deadline.
   */
  readPageRenderSettleMs: 3_000,
  /** Initial browser-search settling wait after `domcontentloaded`. */
  renderSettleMs: 600,
  /**
   * Max serialized DOM HTML returned by `readPage` (bytes); beyond this it is
   * truncated.
   */
  maxHtmlBytes: 2_000_000,
  /**
   * Max visible-text characters returned by `readPage`; beyond this it is
   * truncated.
   */
  maxTextChars: 200_000,
  /** Max page title characters returned by `readPage`. */
  maxPageTitleChars: 1_000,
  /** Hard cap on browsers reported by `browsers.list`. */
  maxBrowsers: 8,
  maxStructuredBytes: 128_000,
  maxStructuredBlocks: 300,
  maxStructuredTextChars: 2_000,
  maxStructuredItems: 60,
  maxStructuredRows: 60,
  maxStructuredCells: 20,
  maxStructuredRefs: 40,
} as const;

// --- Error taxonomy ---------------------------------------------------------

/**
 * Detailed internal web error codes used inside trusted service/adapter
 * interfaces. These are mapped to the narrow public IPC error vocabulary
 * (`ErrorCode`) before crossing the renderer boundary; raw upstream messages,
 * query text and URLs never leave the main process in error payloads.
 */
export const WEB_ERROR_CODES = [
  'INVALID_INPUT',
  'UNSAFE_URL',
  'NO_CAPABLE_PROVIDER',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_FAILURE',
  'RATE_LIMITED',
  'TIMEOUT',
  'QUEUE_FULL',
  'CANCELLED',
  'CONTENT_LIMIT',
  'BROWSER_UNAVAILABLE',
  'BROWSER_LAUNCH_FAILED',
  'NAVIGATION_FAILED',
  'INTERNAL_ERROR',
] as const;

export const webErrorCodeSchema = z.enum(WEB_ERROR_CODES);

export type WebErrorCode = (typeof WEB_ERROR_CODES)[number];

/** Per-adapter attempt outcomes recorded for safe provenance (no content). */
export const WEB_ATTEMPT_OUTCOMES = [
  'ok',
  'empty',
  'unavailable',
  'retryable',
  'fatal',
] as const;
export type WebAttemptOutcome = (typeof WEB_ATTEMPT_OUTCOMES)[number];

// --- Shared validators ------------------------------------------------------

/** True only for an absolute `http:`/`https:` URL. */
export function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

const httpUrlSchema = z
  .string()
  .min(1)
  .max(WEB_LIMITS.maxUrlChars)
  .refine(isHttpUrl, { message: 'URL must be an absolute http(s) URL.' });

// --- Search result ----------------------------------------------------------

/**
 * Provider-neutral search result. `url` is an absolute http(s) reference and is
 * untrusted (never auto-followed). `snippet` is optional and may be absent when
 * the source provides none — it is never synthesised.
 */
export const searchResultSchema = z
  .object({
    title: z.string().min(1).max(WEB_LIMITS.maxTitleChars),
    url: httpUrlSchema,
    snippet: z.string().max(WEB_LIMITS.maxSnippetChars).optional(),
    rank: z.number().int().positive(),
  })
  .strict();

export type SearchResult = z.infer<typeof searchResultSchema>;

/** Safe, content-free record of one adapter attempt during resolution. */
export const searchAttemptSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    outcome: z.enum(WEB_ATTEMPT_OUTCOMES),
    errorCode: webErrorCodeSchema.optional(),
  })
  .strict();

export type SearchAttempt = z.infer<typeof searchAttemptSchema>;

// --- `web.search` IPC contract ---------------------------------------------

export const webSearchInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(WEB_LIMITS.minQueryChars)
      .max(WEB_LIMITS.maxQueryChars),
    searchId: z.uuid().optional(),
  })
  .strict();

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export const webSearchOutputSchema = z
  .object({
    /** The adapter that actually produced the results (not the capability). */
    providerId: z.string().min(1).max(64),
    results: z.array(searchResultSchema).max(WEB_LIMITS.maxResults),
    attempts: z
      .array(searchAttemptSchema)
      .max(WEB_LIMITS.maxAttempts)
      .optional(),
    totalKnown: z.number().int().nonnegative().optional(),
  })
  .strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

export const webSearchCancelInputSchema = z
  .object({ searchId: z.uuid() })
  .strict();

export const webSearchCancelOutputSchema = z
  .object({ cancelled: z.boolean() })
  .strict();

// --- `web.readPage` IPC contract -------------------------------------------

export const webReadPageInputSchema = z
  .object({
    url: httpUrlSchema,
  })
  .strict();

export type WebReadPageInput = z.infer<typeof webReadPageInputSchema>;

/**
 * Honest truncation flags for a {@link PageReadResult}. `true` means the
 * corresponding field was cut to its byte/character cap and does not represent
 * the full document.
 */
export const pageTruncationSchema = z
  .object({
    html: z.boolean(),
    text: z.boolean(),
  })
  .strict();

const structuredTextSchema = z.string().max(WEB_LIMITS.maxStructuredTextChars);

const pageLinkSchema = z
  .object({
    text: structuredTextSchema,
    href: z.string().max(WEB_LIMITS.maxUrlChars),
  })
  .strict();

const pageLinksSchema = z
  .array(pageLinkSchema)
  .max(WEB_LIMITS.maxStructuredItems)
  .optional();

const pageItemSchema = z
  .object({
    text: structuredTextSchema,
    links: pageLinksSchema,
  })
  .strict();

const headingBlockSchema = z
  .object({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(6),
    id: structuredTextSchema.optional(),
    text: structuredTextSchema,
  })
  .strict();

const paragraphBlockSchema = z
  .object({
    type: z.literal('paragraph'),
    text: structuredTextSchema,
    links: pageLinksSchema,
  })
  .strict();

const listBlockSchema = z
  .object({
    type: z.literal('list'),
    ordered: z.boolean(),
    items: z.array(pageItemSchema).max(WEB_LIMITS.maxStructuredItems),
  })
  .strict();

const linkBlockSchema = z
  .object({
    type: z.literal('link'),
    text: structuredTextSchema,
    href: z.string().max(WEB_LIMITS.maxUrlChars),
  })
  .strict();

const tableRowSchema = z
  .array(structuredTextSchema)
  .max(WEB_LIMITS.maxStructuredCells);

const tableBlockSchema = z
  .object({
    type: z.literal('table'),
    rows: z.array(tableRowSchema).max(WEB_LIMITS.maxStructuredRows),
  })
  .strict();

export const structuredBlockSchema = z.discriminatedUnion('type', [
  headingBlockSchema,
  paragraphBlockSchema,
  listBlockSchema,
  linkBlockSchema,
  tableBlockSchema,
]);
export type StructuredBlock = z.infer<typeof structuredBlockSchema>;

/**
 * Script and stylesheet URLs referenced by the page; recorded, never fetched.
 */
const pageRefsSchema = z
  .array(z.string().max(WEB_LIMITS.maxUrlChars))
  .max(WEB_LIMITS.maxStructuredRefs);

export const structuredPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    url: httpUrlSchema,
    title: z.string().max(WEB_LIMITS.maxPageTitleChars),
    scripts: pageRefsSchema,
    stylesheets: pageRefsSchema,
    content: z
      .object({
        blocks: z
          .array(structuredBlockSchema)
          .max(WEB_LIMITS.maxStructuredBlocks),
      })
      .strict(),
    truncated: z.boolean(),
  })
  .strict();
export type StructuredPage = z.infer<typeof structuredPageSchema>;

/**
 * Slack above the `readPage` caps so a value truncated at the limit (plus any
 * truncation marker) still validates.
 */
const TRUNCATION_HEADROOM = 1024;

/**
 * Result of a passive page read. `requestedUrl` is the caller input; `url` is
 * the actual final location after redirects. `html` is the rendered DOM
 * serialized after bounded navigation (not the initial network body); `text`
 * is best-effort page-visible text. `status` may be `null` when no HTTP
 * response is associated (SPA / browser-level). `browserId` is a sanitized
 * adapter detail — never an executable path or OS username.
 */
export const pageReadResultSchema = z
  .object({
    requestedUrl: httpUrlSchema,
    url: httpUrlSchema,
    title: z.string().max(WEB_LIMITS.maxPageTitleChars),
    status: z.number().int().min(100).max(599).nullable(),
    html: z.string().max(WEB_LIMITS.maxHtmlBytes + TRUNCATION_HEADROOM),
    text: z.string().max(WEB_LIMITS.maxTextChars + TRUNCATION_HEADROOM),
    providerId: z.string().min(1).max(64),
    browserId: z.string().min(1).max(64),
    truncated: pageTruncationSchema,
    structured: structuredPageSchema.optional(),
    structureError: z.enum(['EXTRACTION_FAILED']).optional(),
  })
  .strict();

export type PageReadResult = z.infer<typeof pageReadResultSchema>;

export const webReadPageOutputSchema = pageReadResultSchema;
export type WebReadPageOutput = z.infer<typeof webReadPageOutputSchema>;

// --- `web.browsers.list` IPC contract (diagnostic) -------------------------

/** Stable browser identifiers reported by the installed-browser inventory. */
export const WEB_BROWSER_IDS = [
  'chrome',
  'msedge',
  'firefox',
  'safari',
] as const;
export type WebBrowserId = (typeof WEB_BROWSER_IDS)[number];

/**
 * Diagnostic descriptor of an installed browser. `supported` is false for
 * browsers the no-bundle Playwright reader cannot drive (standard Firefox /
 * Safari). `launchVerified` is `null` when a launch probe was not attempted.
 * No executable path or OS-specific detail is ever included.
 */
export const browserInfoSchema = z
  .object({
    id: z.enum(WEB_BROWSER_IDS),
    displayName: z.string().min(1).max(64),
    detected: z.boolean(),
    supported: z.boolean(),
    launchVerified: z.boolean().nullable(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export type BrowserInfo = z.infer<typeof browserInfoSchema>;

export const webBrowsersListOutputSchema = z
  .object({
    browsers: z.array(browserInfoSchema).max(WEB_LIMITS.maxBrowsers),
    selectedId: z.enum(WEB_BROWSER_IDS).optional(),
  })
  .strict();

export type WebBrowsersListOutput = z.infer<typeof webBrowsersListOutputSchema>;
