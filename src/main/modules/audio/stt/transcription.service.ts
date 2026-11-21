import crypto from 'node:crypto';
import type {
  SttJob,
  SttProvider,
  SttTranscript,
} from '../../../../shared/contracts';
import { AppError } from '../../../ipc/errors';
import type { TelemetryService } from '../../telemetry/telemetry.service';
import type { TranscriptionRepository } from './transcription.repository';
import type {
  ProviderProbe,
  RecordingSource,
  RecordingSourceReader,
  TranscriptionOptions,
  TranscriptionOutcome,
  TranscriptionProvider,
} from './transcription-provider';

/** Default hard ceiling on a single transcription (CPU base model, short clip). */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface TranscriptionServiceDeps {
  repository: TranscriptionRepository;
  recordings: RecordingSourceReader;
  providers: TranscriptionProvider[];
  /** Provider used when a request does not name one (008.2: whisper). */
  defaultProviderId: string;
  telemetry?: TelemetryService;
  timeoutMs?: number;
  now?: () => string;
}

interface ActiveJob {
  jobId: string;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Orchestrates speech-to-text jobs over a provider-neutral
 * {@link TranscriptionProvider}. It validates the source recording, creates a
 * durable job, runs exactly one active transcription at a time with a bounded
 * timeout, writes an immutable transcript on success, records only safe failure
 * codes, and supports idempotent cancellation and attributable retries. It is
 * ignorant of interview scoring and of any provider's internal mechanics.
 */
export class TranscriptionService {
  private readonly repository: TranscriptionRepository;
  private readonly recordings: RecordingSourceReader;
  private readonly providers: Map<string, TranscriptionProvider>;
  private readonly defaultProviderId: string;
  private readonly telemetry?: TelemetryService;
  private readonly timeoutMs: number;
  private readonly now: () => string;

  private active: ActiveJob | null = null;

  isActive(): boolean {
    return this.active !== null;
  }

  constructor(deps: TranscriptionServiceDeps) {
    this.repository = deps.repository;
    this.recordings = deps.recordings;
    this.providers = new Map(deps.providers.map((p) => [p.id, p]));
    this.defaultProviderId = deps.defaultProviderId;
    this.telemetry = deps.telemetry;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Reconcile jobs left `running`/`queued` by an unclean exit into the
   * retryable `interrupted` state. Called once at boot, before any new job.
   */
  reconcile(): number {
    return this.repository.reconcileInterrupted(this.now());
  }

  // --- providers ------------------------------------------------------------

  async listProviders(): Promise<SttProvider[]> {
    const probes = await Promise.all(
      [...this.providers.values()].map((provider) => provider.probe()),
    );
    return probes.map(toProviderDto);
  }

  async verifyProvider(
    providerId: string,
  ): Promise<{ provider: SttProvider; verified: boolean }> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AppError('NOT_FOUND', 'That speech-to-text engine is unknown.');
    }
    const probe = provider.verify
      ? await provider.verify()
      : await provider.probe();
    return { provider: toProviderDto(probe), verified: probe.available };
  }

  // --- jobs -----------------------------------------------------------------

  async startJob(input: {
    recordingId: string;
    providerId?: string;
    languageHint?: string;
  }): Promise<SttJob> {
    // Validate the recording exists and is a genuine finalized WAV. A foreign or
    // non-ready id is rejected here, before any job row is created.
    const source = this.recordings.resolveRecordingSource(input.recordingId);

    const providerId = input.providerId ?? this.defaultProviderId;
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AppError(
        'INVALID_INPUT',
        'That speech-to-text engine is not available.',
      );
    }

    if (this.active) {
      throw new AppError(
        'CONFLICT',
        'A transcription is already running. Wait for it to finish.',
      );
    }

    const probe = await provider.probe();
    const languageHint = input.languageHint ?? 'auto';
    const jobId = crypto.randomUUID();
    const createdAt = this.now();
    this.repository.insertJob({
      id: jobId,
      recordingId: source.recordingId,
      providerId,
      engineVersion: probe.engineVersion,
      modelId: probe.model?.id ?? null,
      locale: languageHint === 'auto' ? null : languageHint,
      status: 'running',
      createdAt,
      startedAt: createdAt,
    });

    const controller = new AbortController();
    const done = this.run(
      jobId,
      provider,
      source,
      { languageHint, timeoutMs: this.timeoutMs },
      controller.signal,
    );
    this.active = { jobId, controller, done };

    const job = this.repository.getJob(jobId);
    if (!job) {
      throw new AppError('INTERNAL', 'The transcription could not be started.');
    }
    return job;
  }

  getJob(jobId: string): SttJob {
    const job = this.repository.getJob(jobId);
    if (!job) {
      throw new AppError('NOT_FOUND', 'That transcription could not be found.');
    }
    return job;
  }

  listJobs(recordingId?: string): SttJob[] {
    return this.repository.listJobs(recordingId);
  }

  cancelJob(jobId: string): { cancelled: true } {
    // Idempotent: cancelling an unknown/finished job is a safe no-op.
    if (this.active && this.active.jobId === jobId) {
      this.active.controller.abort();
    }
    return { cancelled: true };
  }

  async retryJob(jobId: string, languageHint?: string): Promise<SttJob> {
    const existing = this.repository.getJob(jobId);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'That transcription could not be found.');
    }
    return this.startJob({
      recordingId: existing.recordingId,
      providerId: existing.providerId,
      languageHint: languageHint ?? existing.locale ?? 'auto',
    });
  }

  getTranscript(transcriptId: string): SttTranscript {
    const transcript = this.repository.getTranscript(transcriptId);
    if (!transcript) {
      throw new AppError('NOT_FOUND', 'That transcript could not be found.');
    }
    return transcript;
  }

  /** Test seam: resolve once the given job has reached a terminal state. */
  async whenSettled(jobId: string): Promise<void> {
    if (this.active && this.active.jobId === jobId) {
      await this.active.done;
    }
  }

  // --- internals ------------------------------------------------------------

  private async run(
    jobId: string,
    provider: TranscriptionProvider,
    source: RecordingSource,
    options: TranscriptionOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = this.now();
    this.repository.markRunning(jobId, startedAt);

    let outcome: TranscriptionOutcome;
    try {
      outcome = await provider.transcribe(source, options, signal);
    } catch {
      outcome = { status: 'failed', code: 'engine_failed' };
    }

    try {
      this.persistOutcome(
        jobId,
        provider.id,
        source,
        options,
        outcome,
        startedAt,
      );
    } finally {
      if (this.active?.jobId === jobId) {
        this.active = null;
      }
    }
  }

  /** Write the job's terminal state (and transcript on success) and record telemetry. */
  private persistOutcome(
    jobId: string,
    providerId: string,
    source: RecordingSource,
    options: TranscriptionOptions,
    outcome: TranscriptionOutcome,
    startedAt: string,
  ): void {
    const finishedAt = this.now();

    if (outcome.status === 'cancelled') {
      this.repository.markTerminal(jobId, 'cancelled', 'cancelled', finishedAt);
      this.record('stt.transcribe', 'cancelled', startedAt, { providerId });
      return;
    }

    if (outcome.status === 'failed') {
      this.repository.markTerminal(jobId, 'failed', outcome.code, finishedAt);
      this.record('stt.transcribe', 'failure', startedAt, {
        providerId,
        code: outcome.code,
      });
      return;
    }

    const requestedLocale =
      options.languageHint === 'auto' ? null : options.languageHint;
    const empty = outcome.text.trim().length === 0;
    const written = this.repository.completeWithTranscript(
      {
        id: crypto.randomUUID(),
        jobId,
        recordingId: source.recordingId,
        providerId,
        engineVersion: outcome.engineVersion,
        modelId: outcome.modelId,
        locale: outcome.languageDetected ?? requestedLocale,
        text: outcome.text,
        empty,
        segments: outcome.segments,
        createdAt: finishedAt,
      },
      finishedAt,
    );
    if (written) {
      this.record('stt.transcribe', 'success', startedAt, {
        providerId,
        modelId: outcome.modelId,
        durationMs: outcome.durationMs,
        empty,
      });
    }
  }

  private record(
    operation: string,
    outcome: 'success' | 'failure' | 'cancelled',
    startedAt: string,
    detail: Record<string, string | number | boolean | null>,
  ): void {
    this.telemetry?.record({
      moduleId: 'audio',
      operation,
      outcome,
      startedAt,
      detail,
    });
  }
}

function toProviderDto(probe: ProviderProbe): SttProvider {
  return {
    providerId: probe.providerId,
    engine: probe.engine,
    state: probe.available ? 'ready' : 'unavailable',
    ready: probe.available,
    offline: probe.offline,
    engineVersion: probe.engineVersion,
    model: probe.model,
    reason: probe.reason,
    locales: probe.locales,
  };
}
