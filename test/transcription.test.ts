import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createDispatcher, type Dispatcher } from '../src/main/ipc/dispatcher';
import { isAppError } from '../src/main/ipc/errors';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { AudioRepository } from '../src/main/modules/audio/audio.repository';
import { RecordingService } from '../src/main/modules/audio/audio.service';
import { createAudioModule } from '../src/main/modules/audio/audio.module';
import { TranscriptionRepository } from '../src/main/modules/audio/stt/transcription.repository';
import { TranscriptionService } from '../src/main/modules/audio/stt/transcription.service';
import type {
  ProviderProbe,
  RecordingSource,
  TranscriptionOptions,
  TranscriptionOutcome,
  TranscriptionProvider,
} from '../src/main/modules/audio/stt/transcription-provider';
import {
  AUDIO_MAX_CHUNK_BYTES,
  AUDIO_SAMPLE_RATE,
  type AudioRecording,
  type ResponseEnvelope,
  type SttFailureCode,
} from '../src/shared/contracts';

let workDir: string;
let storage: Storage;
let telemetry: TelemetryService;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-stt-'));
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(path.join(workDir, 'app.jsonl')),
  });
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

// --- helpers ----------------------------------------------------------------

function tonePcm(samples: number): Buffer {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(
      Math.sin((i / AUDIO_SAMPLE_RATE) * 2 * Math.PI * 440) * 8000,
    );
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

function recordingService(): RecordingService {
  return new RecordingService({
    repository: new AudioRepository(storage.db),
    fileStore: storage.audioFileStore,
    stagingDir: storage.audioStagingDir,
    telemetry,
  });
}

async function makeRecording(svc: RecordingService): Promise<AudioRecording> {
  const begin = svc.beginCapture(null);
  const pcm = tonePcm(8_000);
  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += AUDIO_MAX_CHUNK_BYTES) {
    svc.appendChunk(
      begin.captureId,
      begin.token,
      sequence,
      pcm.subarray(offset, offset + AUDIO_MAX_CHUNK_BYTES).toString('base64'),
    );
    sequence += 1;
  }
  return svc.completeCapture(begin.captureId, begin.token);
}

/**
 * A second, deliberately NOT-whisper-shaped provider used to prove the
 * contract is engine-neutral. Its behaviour is fully scripted so the service's
 * job/transcript/cancel/fail/empty paths are deterministic.
 */
class FakeProvider implements TranscriptionProvider {
  readonly id: string;
  private readonly behaviour:
    | { kind: 'text'; text: string }
    | { kind: 'empty' }
    | { kind: 'fail'; code: SttFailureCode }
    | { kind: 'wait' };
  available = true;

  constructor(id: string, behaviour: FakeProvider['behaviour']) {
    this.id = id;
    this.behaviour = behaviour;
  }

  async probe(): Promise<ProviderProbe> {
    return {
      providerId: this.id,
      engine: 'fake-engine',
      available: this.available,
      offline: true,
      engineVersion: 'fake-1.0',
      model: {
        id: 'fake-model',
        displayName: 'Fake model',
        variant: 'tiny',
        multilingual: false,
        bytes: 123,
      },
      reason: this.available ? null : 'model_missing',
      locales: ['auto'],
    };
  }

  async transcribe(
    source: RecordingSource,
    _options: TranscriptionOptions,
    signal: AbortSignal,
  ): Promise<TranscriptionOutcome> {
    if (this.behaviour.kind === 'wait') {
      // Resolve as cancelled only when the signal fires.
      return new Promise<TranscriptionOutcome>((resolve) => {
        if (signal.aborted) {
          resolve({ status: 'cancelled' });
          return;
        }
        signal.addEventListener(
          'abort',
          () => resolve({ status: 'cancelled' }),
          { once: true },
        );
      });
    }
    if (this.behaviour.kind === 'fail') {
      return { status: 'failed', code: this.behaviour.code };
    }
    const text = this.behaviour.kind === 'empty' ? '' : this.behaviour.text;
    return {
      status: 'completed',
      text,
      segments: text ? [{ startMs: 0, endMs: 500, text: text.trim() }] : null,
      languageDetected: 'en',
      engineVersion: 'fake-1.0',
      modelId: 'fake-model',
      durationMs: 5,
    };
  }
}

function service(
  rec: RecordingService,
  provider: TranscriptionProvider,
): TranscriptionService {
  return new TranscriptionService({
    repository: new TranscriptionRepository(storage.db),
    recordings: rec,
    providers: [provider],
    defaultProviderId: provider.id,
    telemetry,
    timeoutMs: 5_000,
  });
}

async function catchError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (error) {
    return error;
  }
}

// --- tests ------------------------------------------------------------------

describe('TranscriptionService with a non-whisper fake provider', () => {
  it('lists the provider capability (engine-neutral contract)', async () => {
    const rec = recordingService();
    const stt = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'text', text: 'hi' }),
    );
    const providers = await stt.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].providerId).toBe('fake-stt');
    expect(providers[0].engine).not.toContain('whisper');
    expect(providers[0].ready).toBe(true);
  });

  it('transcribes a real recording into a job + immutable transcript', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const stt = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'text', text: 'hello world' }),
    );

    const started = await stt.startJob({ recordingId: recording.id });
    expect(started.status).toBe('running');
    await stt.whenSettled(started.id);

    const job = stt.getJob(started.id);
    expect(job.status).toBe('succeeded');
    expect(job.transcriptId).not.toBeNull();

    const transcript = stt.getTranscript(job.transcriptId as string);
    expect(transcript.text).toBe('hello world');
    expect(transcript.empty).toBe(false);
    expect(transcript.recordingId).toBe(recording.id);
    expect(transcript.segments).not.toBeNull();
  });

  it('rejects an unknown/foreign recording id without creating a job', async () => {
    const rec = recordingService();
    const stt = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'text', text: 'x' }),
    );
    const err = await catchError(
      stt.startJob({ recordingId: crypto.randomUUID() }),
    );
    expect(isAppError(err) && err.code).toBe('NOT_FOUND');
    expect(stt.listJobs()).toHaveLength(0);
  });

  it('records an empty recognised result as a completed empty transcript', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const stt = service(rec, new FakeProvider('fake-stt', { kind: 'empty' }));
    const started = await stt.startJob({ recordingId: recording.id });
    await stt.whenSettled(started.id);
    const job = stt.getJob(started.id);
    expect(job.status).toBe('succeeded');
    const transcript = stt.getTranscript(job.transcriptId as string);
    expect(transcript.empty).toBe(true);
    expect(transcript.text).toBe('');
  });

  it('records a typed failure code and writes no transcript', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const stt = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'fail', code: 'engine_failed' }),
    );
    const started = await stt.startJob({ recordingId: recording.id });
    await stt.whenSettled(started.id);
    const job = stt.getJob(started.id);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('engine_failed');
    expect(job.transcriptId).toBeNull();
  });

  it('cancellation terminates the job with no partial transcript (idempotent)', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const stt = service(rec, new FakeProvider('fake-stt', { kind: 'wait' }));
    const started = await stt.startJob({ recordingId: recording.id });
    expect(stt.cancelJob(started.id)).toEqual({ cancelled: true });
    // Double cancel is a safe no-op.
    expect(stt.cancelJob(started.id)).toEqual({ cancelled: true });
    await stt.whenSettled(started.id);
    const job = stt.getJob(started.id);
    expect(job.status).toBe('cancelled');
    expect(job.transcriptId).toBeNull();
  });

  it('retry creates a new, attributable attempt; the original transcript remains', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const stt = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'text', text: 'attempt' }),
    );
    const first = await stt.startJob({ recordingId: recording.id });
    await stt.whenSettled(first.id);
    const firstTranscriptId = stt.getJob(first.id).transcriptId as string;

    const second = await stt.retryJob(first.id);
    await stt.whenSettled(second.id);
    expect(second.id).not.toBe(first.id);

    const jobs = stt.listJobs(recording.id);
    expect(jobs).toHaveLength(2);
    // The original transcript is still readable (immutable, not overwritten).
    expect(stt.getTranscript(firstTranscriptId).text).toBe('attempt');
    expect(stt.getJob(second.id).transcriptId).not.toBe(firstTranscriptId);
  });

  it('rejects a second concurrent job while one is active', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const stt = service(rec, new FakeProvider('fake-stt', { kind: 'wait' }));
    const first = await stt.startJob({ recordingId: recording.id });
    const err = await catchError(stt.startJob({ recordingId: recording.id }));
    expect(isAppError(err) && err.code).toBe('CONFLICT');
    stt.cancelJob(first.id);
    await stt.whenSettled(first.id);
  });

  it('reconciles interrupted running jobs after a restart and allows retry', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    // Leave a job stuck in `wait` (simulating an unclean exit), then build a
    // fresh service (new process) and reconcile.
    const first = service(rec, new FakeProvider('fake-stt', { kind: 'wait' }));
    const stuck = await first.startJob({ recordingId: recording.id });
    // Do not settle; the in-memory runner is abandoned.

    const fresh = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'text', text: 'after restart' }),
    );
    const reconciled = fresh.reconcile();
    expect(reconciled).toBe(1);
    expect(fresh.getJob(stuck.id).status).toBe('interrupted');

    const retried = await fresh.retryJob(stuck.id);
    await fresh.whenSettled(retried.id);
    expect(fresh.getJob(retried.id).status).toBe('succeeded');
  });

  it('keeps recognised text out of telemetry and the JSONL log (privacy canary)', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const canary = 'CANARY_SPOKEN_PHRASE_98765';
    const stt = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'text', text: canary }),
    );
    const started = await stt.startJob({ recordingId: recording.id });
    await stt.whenSettled(started.id);

    const rows = telemetry.listByModule('audio', 50);
    expect(JSON.stringify(rows)).not.toContain(canary);
    const logText = fs.readFileSync(path.join(workDir, 'app.jsonl'), 'utf8');
    expect(logText).not.toContain(canary);
    // But the transcript table legitimately holds it.
    const transcript = stt.getTranscript(
      stt.getJob(started.id).transcriptId as string,
    );
    expect(transcript.text).toBe(canary);
  });

  it('cascades jobs + transcripts when the recording is deleted; FK stays clean', async () => {
    const rec = recordingService();
    const recording = await makeRecording(rec);
    const stt = service(
      rec,
      new FakeProvider('fake-stt', { kind: 'text', text: 'bye' }),
    );
    const started = await stt.startJob({ recordingId: recording.id });
    await stt.whenSettled(started.id);

    storage.db
      .prepare('DELETE FROM audio_recordings WHERE id = ?')
      .run(recording.id);
    const jobs = storage.db
      .prepare('SELECT COUNT(*) AS c FROM audio_transcription_jobs')
      .get() as { c: number };
    const transcripts = storage.db
      .prepare('SELECT COUNT(*) AS c FROM audio_transcripts')
      .get() as { c: number };
    expect(jobs.c).toBe(0);
    expect(transcripts.c).toBe(0);
    expect(storage.db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
  });
});

describe('audio STT over the validated IPC boundary', () => {
  function dispatcher(provider: TranscriptionProvider): {
    dispatch: Dispatcher;
    stt: TranscriptionService;
    rec: RecordingService;
  } {
    const rec = recordingService();
    const stt = service(rec, provider);
    const dispatch = createDispatcher([createAudioModule(rec, stt)]);
    return { dispatch, stt, rec };
  }

  async function send<T = unknown>(
    dispatch: Dispatcher,
    action: string,
    payload: unknown,
  ): Promise<ResponseEnvelope<T>> {
    return dispatch.dispatch({
      requestId: crypto.randomUUID(),
      module: 'audio',
      version: 1,
      action,
      payload,
    }) as Promise<ResponseEnvelope<T>>;
  }

  it('rejects an injected (invalid) language hint at the schema boundary', async () => {
    const { dispatch, rec } = dispatcher(
      new FakeProvider('fake-stt', { kind: 'text', text: 'x' }),
    );
    const recording = await makeRecording(rec);
    const res = await send(dispatch, 'stt.jobs.start', {
      recordingId: recording.id,
      languageHint: 'en; rm -rf /',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects a non-uuid recording id at the schema boundary', async () => {
    const { dispatch } = dispatcher(
      new FakeProvider('fake-stt', { kind: 'text', text: 'x' }),
    );
    const res = await send(dispatch, 'stt.jobs.start', {
      recordingId: 'not-a-uuid',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('runs the full start → get → transcript flow through IPC', async () => {
    const { dispatch, stt, rec } = dispatcher(
      new FakeProvider('fake-stt', { kind: 'text', text: 'ipc works' }),
    );
    const recording = await makeRecording(rec);
    const start = await send<{ job: { id: string } }>(
      dispatch,
      'stt.jobs.start',
      {
        recordingId: recording.id,
      },
    );
    expect(start.ok).toBe(true);
    const jobId = start.ok ? start.data.job.id : '';
    await stt.whenSettled(jobId);

    const got = await send<{ job: { status: string; transcriptId: string } }>(
      dispatch,
      'stt.jobs.get',
      { jobId },
    );
    expect(got.ok).toBe(true);
    const transcriptId = got.ok ? got.data.job.transcriptId : '';
    const transcript = await send<{ transcript: { text: string } }>(
      dispatch,
      'stt.transcripts.get',
      { transcriptId },
    );
    expect(transcript.ok && transcript.data.transcript.text).toBe('ipc works');
  });
});
