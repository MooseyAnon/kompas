import type { DiscoveryRun, JdExtraction } from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { DiscoveryRunsRepository } from './runs.repository';
import {
  interpretJd,
  JdExtractionError,
  type JdInference,
} from './jd-extraction';
import { verifyJobDescription } from './jd-verifier';

type ExtractionErrorCode = JdExtractionError['code'] | 'MODEL_FAILED';

/**
 * One local-model extraction at a time; capture and verifier identity are
 * authoritative.
 */
export class JdExtractionService {
  private active: { runId: string; controller: AbortController } | null = null;

  constructor(
    private readonly repo: DiscoveryRunsRepository,
    private readonly inference?: JdInference,
    private readonly clock: () => Date = () => new Date(),
    private readonly resolutionActive: () => boolean = () => false,
  ) {}

  isActive(): boolean {
    return this.active !== null;
  }

  isActiveRun(runId: string): boolean {
    return this.active?.runId === runId;
  }

  cancel(runId: string): void {
    if (this.active?.runId === runId) this.active.controller.abort();
  }

  list(runId: string, sourceId: string): JdExtraction[] {
    const items = this.repo.extractions(runId, sourceId);
    if (!items)
      throw new AppError('NOT_FOUND', 'Candidate not found in this run.');

    return items;
  }

  async extract(run: DiscoveryRun, sourceId?: string): Promise<JdExtraction[]> {
    if (run.status === 'running' || (run.status === 'cancelled' && !sourceId))
      throw new AppError(
        'CONFLICT',
        'Finish discovery before extracting job descriptions.',
      );
    const operationInProgress =
      this.active !== null || this.repo.hasRunning() || this.resolutionActive();
    if (operationInProgress)
      throw new AppError(
        'CONFLICT',
        'Another discovery operation is in progress.',
      );

    const candidates = sourceId
      ? [this.repo.admitted(run.id, sourceId)]
      : this.repo.candidates(run.id);
    if (candidates.some((candidate) => !candidate))
      throw new AppError('NOT_FOUND', 'Candidate not found in this run.');

    // An explicit candidate gets a fresh window; a batch keeps the run
    // deadline.
    const deadline = sourceId
      ? this.clock().getTime() + run.configSnapshot.run.deadlineMs
      : Date.parse(run.startedAt) + run.configSnapshot.run.deadlineMs;
    if (this.clock().getTime() >= deadline)
      throw new AppError(
        'CONFLICT',
        'Run deadline reached. Extract a candidate explicitly.',
      );

    const controller = new AbortController();
    this.active = { runId: run.id, controller };
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - this.clock().getTime()),
    );

    try {
      for (const candidate of candidates) {
        if (controller.signal.aborted || this.clock().getTime() >= deadline)
          break;
        if (!candidate) continue;
        await this.extractCandidate(
          run,
          candidate.sourceId,
          deadline,
          controller.signal,
          !!sourceId,
        );
      }
    } finally {
      clearTimeout(timer);
      this.active = null;
    }

    return sourceId
      ? this.list(run.id, sourceId)
      : candidates.flatMap((item) =>
          item ? this.list(run.id, item.sourceId) : [],
        );
  }

  /**
   * Coordinator-owned path; a serial candidate worker enforces the single
   * extraction cap.
   */
  async extractWithinRun(
    run: DiscoveryRun,
    sourceId: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      signal.aborted ||
      this.clock().getTime() >= deadline ||
      this.repo.get(run.id)?.status !== 'running'
    )
      return;

    await this.extractCandidate(run, sourceId, deadline, signal, false, true);
  }

  private async extractCandidate(
    run: DiscoveryRun,
    sourceId: string,
    deadline: number,
    signal: AbortSignal,
    required: boolean,
    requireRunning = false,
  ): Promise<void> {
    const capture = this.repo.verifiedCapture(run.id, sourceId);
    if (!capture) {
      if (required)
        throw new AppError(
          'CONFLICT',
          'A verified job description is required.',
        );
      return;
    }

    const attempt = this.repo.claimExtraction(
      run.id,
      sourceId,
      capture.id,
      this.clock().toISOString(),
    );
    if (!attempt) {
      if (required)
        throw new AppError(
          'CONFLICT',
          'Extraction is complete or its retry limit was reached.',
        );
      return;
    }

    try {
      const verification = verifyJobDescription(
        capture.rawReadPage,
        this.repo.admitted(run.id, sourceId)!,
      );
      if (verification.kind !== 'job_description')
        throw new JdExtractionError('NOT_JOB_DESCRIPTION');

      const result = await interpretJd(
        capture.rawReadPage,
        this.inference,
        signal,
        deadline - this.clock().getTime(),
      );
      const stopped =
        signal.aborted ||
        this.clock().getTime() >= deadline ||
        (requireRunning && this.repo.get(run.id)?.status !== 'running');
      if (stopped) throw new JdExtractionError('DEADLINE_REACHED');

      this.repo.finishExtraction(
        run.id,
        sourceId,
        attempt.id,
        { ...result, errorCode: null },
        this.clock().toISOString(),
        requireRunning,
      );
    } catch (error) {
      const code = this.failureCode(error, deadline, signal);
      this.repo.finishExtraction(
        run.id,
        sourceId,
        attempt.id,
        { jd: null, provenance: null, diagnostics: [], errorCode: code },
        this.clock().toISOString(),
        requireRunning,
      );
    }
  }

  private failureCode(
    error: unknown,
    deadline: number,
    signal: AbortSignal,
  ): ExtractionErrorCode {
    if (signal.aborted) return 'CANCELLED';
    if (this.clock().getTime() >= deadline) return 'DEADLINE_REACHED';
    if (error instanceof JdExtractionError) return error.code;

    return 'MODEL_FAILED';
  }
}
