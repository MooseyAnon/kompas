import {
  JOB_SNAPSHOT_MAX_BYTES,
  importPreviewInput,
  jobSnapshotSchema,
  pageReadResultSchema,
  snapshotWithinLimit,
  type ImportPreview,
  type JobSnapshot,
  type PageReadResult,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import { isWebError } from '../web/web.error';
import { classifyExternalUrl } from '../web/url-safety';
import {
  isJobBoardHost,
  verifyJobDescription,
} from '../job-discovery/jd-verifier';
import {
  interpretJd,
  JdExtractionError,
  type JdInference,
} from '../job-discovery/jd-extraction';

export interface PreviewPageReader {
  readPage(url: string): Promise<PageReadResult>;
}

type PreviewReason = NonNullable<ImportPreview['reason']>;

type PageRead =
  | { ok: true; page: PageReadResult }
  | { ok: false; webError: ImportPreview['webError'] };

type SnapshotBuild =
  | { ok: true; snapshot: JobSnapshot }
  | { ok: false; reason: PreviewReason };

interface ExtractedIdentity {
  companyName: string;
  roleTitle: string;
  location: string | null;
}

const BLOCKER_PATTERN =
  /captcha|verify you are human|access denied|sign in to continue/i;
const BLOCKER_SCAN_CHARS = 1200;
const JD_SECTION_PATTERN =
  /\b(?:responsibilities|requirements|qualifications|about the role|your role|what you(?:'|’)ll do)\b/i;
const MAX_IDENTITY_FIELD_LENGTH = 200;
const EXTRACTION_TIMEOUT_MS = 120_000;

/** Read-only Applications preview; Web owns network safety and inference owns scheduling. */
export class ImportPreviewService {
  constructor(
    private readonly web: PreviewPageReader,
    private readonly inference?: JdInference,
  ) {}

  /**
   * Reads a public job page and reports what could be imported, without persisting anything.
   *
   * `reason` holds the first failure only: snapshot problems take precedence over
   * extraction problems, and it is `null` only when a complete snapshot is available.
   */
  async preview(raw: unknown): Promise<ImportPreview> {
    const suppliedUrl = parseSuppliedUrl(raw);
    const result = emptyPreview(suppliedUrl);

    const read = await this.readPage(suppliedUrl);
    if (!read.ok) {
      result.webError = read.webError;
      return result;
    }
    const { page } = read;

    // A malformed adapter response must never promote partial or unsafe content.
    if (
      !pageReadResultSchema.safeParse(page).success ||
      page.requestedUrl !== suppliedUrl
    )
      return result;
    if (!classifyExternalUrl(page.url).ok) return result;
    result.observedUrl = page.url;
    if (!isSuccessStatus(page.status)) return result;

    result.readSucceeded = true;
    result.reason = null;
    const rejection = rejectPage(page);
    if (rejection) {
      result.reason = rejection;
      return result;
    }

    // Original visible text is retained even if inference is unavailable.
    const built = buildSnapshot(page, suppliedUrl);
    if (built.ok) {
      result.snapshot = built.snapshot;
      result.snapshotAvailable = true;
    } else {
      result.reason = built.reason;
    }

    try {
      const identity = await this.extractIdentity(page);
      if (!identity) {
        result.reason ??= 'identity_unconfirmed';
        return result;
      }
      result.extractionSucceeded = true;
      result.companyName = identity.companyName;
      result.roleTitle = identity.roleTitle;
      result.location = identity.location;
    } catch (error) {
      result.reason ??= extractionFailureReason(error);
    }
    return result;
  }

  private async readPage(url: string): Promise<PageRead> {
    try {
      return { ok: true, page: await this.web.readPage(url) };
    } catch (error) {
      return { ok: false, webError: isWebError(error) ? error.code : null };
    }
  }

  /** Returns `null` when the model's identity is missing, oversized or not evidenced by the page. */
  private async extractIdentity(
    page: PageReadResult,
  ): Promise<ExtractedIdentity | null> {
    const interpreted = await interpretJd(
      page,
      this.inference,
      new AbortController().signal,
      EXTRACTION_TIMEOUT_MS,
    );
    const { title, company, location } = interpreted.jd;
    if (
      !title ||
      !company ||
      title.text.length > MAX_IDENTITY_FIELD_LENGTH ||
      company.text.length > MAX_IDENTITY_FIELD_LENGTH ||
      (location && location.text.length > MAX_IDENTITY_FIELD_LENGTH)
    )
      return null;

    const identity: ExtractedIdentity = {
      companyName: company.text,
      roleTitle: title.text,
      location: location?.text ?? null,
    };
    const verification = verifyJobDescription(page, {
      title: identity.roleTitle,
      company: identity.companyName,
      location: identity.location,
    });
    return verification.kind === 'job_description' ? identity : null;
  }
}

function parseSuppliedUrl(raw: unknown): string {
  const parsed = importPreviewInput.safeParse(raw);
  if (!parsed.success || !classifyExternalUrl(parsed.data.url).ok)
    throw new AppError('INVALID_INPUT', 'Enter a public http(s) job URL.');
  return parsed.data.url;
}

function emptyPreview(suppliedUrl: string): ImportPreview {
  return {
    suppliedUrl,
    observedUrl: null,
    readSucceeded: false,
    extractionSucceeded: false,
    snapshotAvailable: false,
    reason: 'page_unavailable',
    webError: null,
    companyName: null,
    roleTitle: null,
    location: null,
    snapshot: null,
  };
}

function isSuccessStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/** Cheap, deterministic checks that rule a page out before any snapshot or model work. */
function rejectPage(page: PageReadResult): PreviewReason | null {
  if (page.truncated.html || page.truncated.text || page.structured?.truncated)
    return 'page_incomplete';
  if (
    !page.text.trim() ||
    isJobBoardHost(new URL(page.url).hostname) ||
    BLOCKER_PATTERN.test(
      `${page.title} ${page.text.slice(0, BLOCKER_SCAN_CHARS)}`,
    ) ||
    !JD_SECTION_PATTERN.test(page.text)
  )
    return 'not_job_description';
  return null;
}

/** A complete supported manual snapshot needs no model-derived fields or blocks. */
function buildSnapshot(
  page: PageReadResult,
  suppliedUrl: string,
): SnapshotBuild {
  const rawSnapshot = {
    schemaVersion: 1,
    source: 'manual',
    sourceUrl: suppliedUrl,
    capturedAt: new Date().toISOString(),
    title: null,
    company: null,
    location: null,
    descriptionText: page.text,
    contentBlocks: [],
  };
  if (utf8ByteLength(JSON.stringify(rawSnapshot)) > JOB_SNAPSHOT_MAX_BYTES)
    return { ok: false, reason: 'snapshot_too_large' };

  const snapshot = jobSnapshotSchema.safeParse(rawSnapshot);
  if (!snapshot.success) return { ok: false, reason: 'snapshot_incomplete' };
  if (!snapshotWithinLimit(snapshot.data))
    return { ok: false, reason: 'snapshot_too_large' };
  return { ok: true, snapshot: snapshot.data };
}

function extractionFailureReason(error: unknown): PreviewReason {
  return error instanceof JdExtractionError &&
    error.code === 'MODEL_UNAVAILABLE'
    ? 'model_unavailable'
    : 'extraction_failed';
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
