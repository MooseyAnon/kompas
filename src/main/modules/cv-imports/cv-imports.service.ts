import type {
  Document,
  CvImport,
  CvDiagnostics,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import {
  ExtractionError,
  type ExtractedDocument,
} from '../documents/extraction';
import type { TelemetryService } from '../telemetry/telemetry.service';
import { CvImportsRepository } from './cv-imports.repository';
import type { CvInferenceClient } from './model';
import { CV_PARSE_TIMEOUT_MS, CvModelError, interpretFullCv } from './full-cv';

/** Read access to imported CV documents and their extracted text. */
export interface CvDocumentReader {
  getCv(id: string): Document | null;
  extract(id: string, signal?: AbortSignal): Promise<ExtractedDocument>;
}

const emptyDiagnostics = (): CvDiagnostics => ({
  detected: 0,
  ambiguous: 0,
  missing: 0,
  modelAttempted: false,
  modelResolved: 0,
  modelStatus: 'not_needed',
  warnings: [],
  errorCode: null,
  durationMs: 0,
});

/**
 * Creates CV drafts from imported documents and runs one background parse per
 * draft. Drafts left `processing` by a previous session are cancelled on start-up.
 */
export class CvImportsService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly repo: CvImportsRepository,
    private readonly documents: CvDocumentReader,
    private readonly inference?: CvInferenceClient,
    private readonly telemetry?: TelemetryService,
  ) {
    repo.reconcile();
  }

  isActive(): boolean {
    return this.running.size > 0;
  }

  get(id: string): CvImport {
    const item = this.repo.get(id);
    if (!item)
      throw new AppError('NOT_FOUND', 'That CV draft could not be found.');

    return item;
  }

  list(limit?: number): Omit<CvImport, 'draft'>[] {
    return this.repo.list(limit).map(({ draft: _draft, ...item }) => item);
  }

  /** Returns the existing draft for a document, or creates one and starts parsing it. */
  start(documentId: string): CvImport {
    const document = this.documents.getCv(documentId);
    if (!document)
      throw new AppError('NOT_FOUND', 'Choose an imported CV first.');

    const existing = this.repo.byDocument(documentId);
    if (existing) return existing;

    const createdAt = new Date().toISOString();
    const item: CvImport = {
      id: crypto.randomUUID(),
      documentId,
      status: 'processing',
      draft: null,
      diagnostics: emptyDiagnostics(),
      sourceSha256: document.sha256,
      appliedStatus: 'not_applied',
      createdAt,
      updatedAt: createdAt,
    };
    this.repo.insert(item);
    this.run(item);

    return item;
  }

  retry(id: string): CvImport {
    const item = this.get(id);
    if (item.status === 'processing') return item;
    if (!item.documentId || !this.documents.getCv(item.documentId))
      throw new AppError('NOT_FOUND', 'The original CV is unavailable.');

    item.status = 'processing';
    item.diagnostics = emptyDiagnostics();
    item.updatedAt = new Date().toISOString();
    this.repo.update(item);
    this.run(item);

    return item;
  }

  cancel(id: string): { cancelled: boolean } {
    const item = this.get(id);
    if (item.status !== 'processing') return { cancelled: false };

    this.running.get(id)?.abort();
    item.status = 'cancelled';
    item.diagnostics.modelStatus = 'cancelled';
    item.updatedAt = new Date().toISOString();
    this.repo.update(item);

    return { cancelled: true };
  }

  discard(id: string): { discarded: true } {
    this.get(id);
    this.running.get(id)?.abort();
    this.repo.discard(id);

    return { discarded: true };
  }

  /**
   * Parses the CV in the background. Mutates and persists `item` with the
   * outcome; aborted runs (cancel, discard or timeout) leave persistence to
   * `settleAbortedRun` so a cancelled record is never overwritten.
   */
  private run(item: CvImport): void {
    const controller = new AbortController();
    this.running.set(item.id, controller);

    const startedAt = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CV_PARSE_TIMEOUT_MS);

    void (async () => {
      try {
        await this.interpret(item, controller.signal, startedAt);
      } catch (error) {
        if (!controller.signal.aborted) markFailed(item, error);
      } finally {
        clearTimeout(timeout);
        if (controller.signal.aborted) this.settleAbortedRun(item, timedOut);
        else this.persistOutcome(item, startedAt);

        if (this.running.get(item.id) === controller)
          this.running.delete(item.id);
      }
    })();
  }

  private async interpret(
    item: CvImport,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<void> {
    const extracted = await this.documents.extract(item.documentId!, signal);
    if (signal.aborted) return;

    if (extracted.quality === 'insufficient_text')
      throw new ExtractionError('EXTRACTION_FAILED');

    const { draft, diagnostics } = await interpretFullCv(
      extracted,
      this.inference,
      signal,
      startedAt + CV_PARSE_TIMEOUT_MS,
    );
    if (signal.aborted) return;

    item.draft = draft;
    item.diagnostics = diagnostics;
    item.status = diagnostics.ambiguous ? 'partial' : 'ready';
  }

  /** Only a still-processing record is failed; cancelled or discarded records are left as they are. */
  private settleAbortedRun(item: CvImport, timedOut: boolean): void {
    if (this.repo.get(item.id)?.status !== 'processing') return;

    item.status = 'failed';
    item.diagnostics.errorCode = timedOut ? 'TIMEOUT' : 'CANCELLED';
    item.updatedAt = new Date().toISOString();
    this.repo.update(item);
  }

  private persistOutcome(item: CvImport, startedAt: number): void {
    if (!this.repo.get(item.id)) return;

    item.diagnostics.durationMs = Date.now() - startedAt;
    item.updatedAt = new Date().toISOString();
    this.repo.update(item);

    this.recordTelemetry(item, startedAt);
  }

  private recordTelemetry(item: CvImport, startedAt: number): void {
    const { draft } = item;
    const provenance = draft?.modelProvenance;

    this.telemetry?.record({
      moduleId: 'cvImports',
      operation: 'parse',
      outcome: item.status === 'failed' ? 'failure' : 'success',
      startedAt: new Date(startedAt).toISOString(),
      detail: {
        status: item.status,
        detected: item.diagnostics.detected,
        ambiguous: item.diagnostics.ambiguous,
        modelStatus: item.diagnostics.modelStatus,
        ...(draft && provenance && item.status !== 'failed'
          ? {
              providerId: provenance.providerId,
              modelId: provenance.modelId,
              parserVersion: draft.parserVersion,
              schemaVersion: provenance.schemaVersion,
              entryCount: draft.experiences.length,
            }
          : {}),
      },
      errorCode: item.diagnostics.errorCode ?? undefined,
    });
  }
}

/** Extraction failures never reached the model, so its status stays `not_needed`. */
function markFailed(item: CvImport, error: unknown): void {
  item.status = 'failed';
  item.diagnostics.errorCode =
    error instanceof ExtractionError || error instanceof CvModelError
      ? error.code
      : 'MODEL_FAILED';
  item.diagnostics.modelStatus =
    error instanceof ExtractionError ? 'not_needed' : 'failed';
}
