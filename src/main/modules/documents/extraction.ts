import fs from 'node:fs/promises';
import {
  getDocument,
  PasswordResponses,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import {
  DOCUMENT_MAX_BYTES,
  SUPPORTED_DOCUMENT_TYPES,
} from '../../../shared/contracts';

export type ExtractionErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'CORRUPT_DOCUMENT'
  | 'ENCRYPTED_DOCUMENT'
  | 'DOCUMENT_UNAVAILABLE'
  | 'RESOURCE_LIMIT'
  | 'CANCELLED'
  | 'EXTRACTION_FAILED';

/** Typed extraction failure; `message` equals `code` so it is safe to log. */
export class ExtractionError extends Error {
  constructor(readonly code: ExtractionErrorCode) {
    super(code);
  }
}

export interface TextBlock {
  text: string;
  kind: 'line' | 'paragraph' | 'heading';
  page?: number;
  paragraph?: number;
}

export interface ExtractedDocument {
  adapterId: string;
  adapterVersion: string;
  blocks: TextBlock[];
  text: string;
  quality: 'usable' | 'insufficient_text' | 'partial';
  warnings: string[];
  pageCount?: number;
}

/** Converts the bytes of one supported media type into bounded text blocks. */
export interface ExtractionAdapter {
  mediaType: string;
  id: string;
  extract(bytes: Uint8Array, signal?: AbortSignal): Promise<ExtractedDocument>;
}

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type ZipEntry = JSZip.JSZipObject;

const ADAPTER_VERSION = '1';

const MAX_TEXT = 120_000;
const MAX_BLOCKS = 3000;
const MAX_PAGES = 60;
const MAX_WARNINGS = 20;
const MAX_ZIP_ENTRIES = 150;
const MAX_UNCOMPRESSED = 32 * 1024 * 1024;

/** Vertical distance (PDF units) beyond which text items start a new line. */
const LINE_BREAK_Y_TOLERANCE = 3;

/** Leftward jump (PDF units) treated as a return to the start of a line. */
const BACKWARD_JUMP_X_TOLERANCE = 10;

const DOCX_REQUIRED_ENTRIES = ['word/document.xml', '[Content_Types].xml'];

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExtractionError('CANCELLED');
}

function classifyQuality(
  text: string,
  warnings: string[],
): ExtractedDocument['quality'] {
  if (!text) return 'insufficient_text';
  if (warnings.includes('truncated')) return 'partial';

  return 'usable';
}

/**
 * Collapse whitespace, drop empty blocks and enforce the block/text budgets.
 * Appends `truncated` / `scanned_or_image_only` to `warnings` as applicable.
 */
function normalise(
  id: string,
  blocks: TextBlock[],
  warnings: string[],
  pageCount?: number,
): ExtractedDocument {
  const bounded: TextBlock[] = [];
  let length = 0;

  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const exceedsBudget =
      bounded.length >= MAX_BLOCKS || length + text.length > MAX_TEXT;
    if (exceedsBudget) {
      warnings.push('truncated');
      break;
    }

    bounded.push({ ...block, text });
    length += text.length + 1;
  }

  const text = bounded.map((b) => b.text).join('\n');
  if (!text) warnings.push('scanned_or_image_only');

  return {
    adapterId: id,
    adapterVersion: ADAPTER_VERSION,
    blocks: bounded,
    text,
    quality: classifyQuality(text, warnings),
    warnings: [...new Set(warnings)].slice(0, MAX_WARNINGS),
    ...(pageCount === undefined ? {} : { pageCount }),
  };
}

/**
 * Group one page's positioned text items into `line` blocks appended to
 * `blocks`. Stops early once the block budget is exceeded; the caller decides
 * whether to record truncation.
 */
async function collectPageLines(
  page: PdfPage,
  pageNumber: number,
  blocks: TextBlock[],
  warnings: string[],
): Promise<void> {
  const content = await page.getTextContent();
  let line = '';
  let previousX = -Infinity;
  let previousY: number | undefined;

  const flush = () => {
    if (line.trim()) {
      blocks.push({ text: line, kind: 'line', page: pageNumber });
    }
    line = '';
  };

  for (const item of content.items) {
    if (!('str' in item)) continue;

    const x = item.transform[4];
    const y = item.transform[5];

    if (previousY !== undefined) {
      const verticalGap = Math.abs(y - previousY);
      const jumpedBackwards = x < previousX - BACKWARD_JUMP_X_TOLERANCE;

      if (verticalGap > LINE_BREAK_Y_TOLERANCE || jumpedBackwards) flush();

      // Same baseline but moved left: likely multi-column text.
      if (verticalGap < LINE_BREAK_Y_TOLERANCE && jumpedBackwards) {
        warnings.push('reading_order_uncertain');
      }
    }

    line += item.str + (item.hasEOL ? '\n' : ' ');
    if (item.hasEOL) flush();

    previousX = x;
    previousY = y;

    if (blocks.length > MAX_BLOCKS) break;
  }

  flush();
  page.cleanup();
}

function isPasswordError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return (
    error.name === 'PasswordException' ||
    String(error.message).includes(String(PasswordResponses.NEED_PASSWORD))
  );
}

function toPdfExtractionError(
  error: unknown,
  signal?: AbortSignal,
): ExtractionError {
  if (signal?.aborted) return new ExtractionError('CANCELLED');
  if (error instanceof ExtractionError) return error;
  if (isPasswordError(error)) return new ExtractionError('ENCRYPTED_DOCUMENT');

  return new ExtractionError('CORRUPT_DOCUMENT');
}

/** PDF text extraction via pdf.js, bounded by page and block limits. */
export class PdfExtractionAdapter implements ExtractionAdapter {
  readonly mediaType = SUPPORTED_DOCUMENT_TYPES[0].mediaType;
  readonly id = 'pdfjs';

  async extract(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ExtractedDocument> {
    check(signal);

    const task = getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    const abort = () => task.destroy();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const pdf = await task.promise;
      if (pdf.numPages > MAX_PAGES) throw new ExtractionError('RESOURCE_LIMIT');

      const blocks: TextBlock[] = [];
      const warnings: string[] = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        check(signal);

        const page = await pdf.getPage(pageNumber);
        await collectPageLines(page, pageNumber, blocks, warnings);

        if (blocks.length > MAX_BLOCKS) {
          warnings.push('truncated');
          break;
        }
      }

      return normalise(this.id, blocks, warnings, pdf.numPages);
    } catch (error) {
      throw toPdfExtractionError(error, signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      await task.destroy().catch(() => {});
    }
  }
}

/**
 * JSZip keeps the central-directory size on a private field. An entry without
 * it is treated as over the limit so unknown sizes are never trusted.
 */
function declaredUncompressedSize(entry: ZipEntry): number {
  const internal = entry as unknown as {
    _data?: { uncompressedSize?: number };
  };

  return internal._data?.uncompressedSize ?? MAX_UNCOMPRESSED + 1;
}

/** Reject zip bombs, path traversal and archives missing DOCX parts. */
function assertSafeDocxArchive(zip: JSZip): void {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  const hasUnsafePath = entries.some(
    (entry) => entry.name.includes('..') || entry.name.startsWith('/'),
  );
  if (entries.length > MAX_ZIP_ENTRIES || hasUnsafePath) {
    throw new ExtractionError('RESOURCE_LIMIT');
  }

  let inflated = 0;
  for (const entry of entries) {
    inflated += declaredUncompressedSize(entry);
    if (inflated > MAX_UNCOMPRESSED) {
      throw new ExtractionError('RESOURCE_LIMIT');
    }
  }

  if (!DOCX_REQUIRED_ENTRIES.every((name) => zip.file(name))) {
    throw new ExtractionError('CORRUPT_DOCUMENT');
  }
}

async function loadZip(bytes: Uint8Array): Promise<JSZip> {
  try {
    // CRC validation inflates every entry before we can enforce size limits.
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new ExtractionError('CORRUPT_DOCUMENT');
  }
}

/** DOCX raw-text extraction via mammoth, after archive safety checks. */
export class DocxExtractionAdapter implements ExtractionAdapter {
  readonly mediaType = SUPPORTED_DOCUMENT_TYPES[1].mediaType;
  readonly id = 'mammoth';

  async extract(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ExtractedDocument> {
    check(signal);

    const zip = await loadZip(bytes);
    assertSafeDocxArchive(zip);
    check(signal);

    try {
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(bytes),
      });
      check(signal);

      const blocks: TextBlock[] = result.value
        .split(/\n+/)
        .map((text, paragraph) => ({
          text,
          kind: 'paragraph' as const,
          paragraph,
        }));
      const warnings = result.messages.length ? ['format_warning'] : [];

      return normalise(this.id, blocks, warnings);
    } catch {
      if (signal?.aborted) throw new ExtractionError('CANCELLED');
      throw new ExtractionError('CORRUPT_DOCUMENT');
    }
  }
}

/** Routes extraction to the single adapter registered for a media type. */
export class ExtractionRegistry {
  private readonly adapters = new Map<string, ExtractionAdapter>();

  constructor(adapters: ExtractionAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.mediaType)) {
        throw new Error('Duplicate extraction media type');
      }
      this.adapters.set(adapter.mediaType, adapter);
    }
  }

  async extract(
    mediaType: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ExtractedDocument> {
    const adapter = this.adapters.get(mediaType);
    if (!adapter) throw new ExtractionError('UNSUPPORTED_FORMAT');
    if (bytes.length > DOCUMENT_MAX_BYTES) {
      throw new ExtractionError('RESOURCE_LIMIT');
    }
    check(signal);

    return adapter.extract(bytes, signal);
  }
}

/** Read a managed file by absolute path, enforcing the document size limit. */
export async function readManagedDocument(
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  check(signal);

  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > DOCUMENT_MAX_BYTES) {
      throw new ExtractionError('RESOURCE_LIMIT');
    }

    const bytes = await fs.readFile(path, { signal });
    check(signal);

    return bytes;
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    if (signal?.aborted) throw new ExtractionError('CANCELLED');
    throw new ExtractionError('DOCUMENT_UNAVAILABLE');
  }
}
