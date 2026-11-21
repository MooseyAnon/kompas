import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import type { Dispatcher } from '../src/main/ipc/dispatcher';
import { isAppError } from '../src/main/ipc/errors';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { AudioRepository } from '../src/main/modules/audio/audio.repository';
import { RecordingService } from '../src/main/modules/audio/audio.service';
import {
  buildWavHeader,
  parseWavHeader,
  WAV_HEADER_BYTES,
} from '../src/main/modules/audio/audio.wav';
import {
  AUDIO_MAX_CHUNK_BYTES,
  AUDIO_SAMPLE_RATE,
  type AudioRecording,
  type ResponseEnvelope,
} from '../src/shared/contracts';

let workDir: string;
let storage: Storage;
let telemetry: TelemetryService;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-audio-'));
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

function makeService(): RecordingService {
  return new RecordingService({
    repository: new AudioRepository(storage.db),
    fileStore: storage.audioFileStore,
    stagingDir: storage.audioStagingDir,
    telemetry,
  });
}

/** Deterministic PCM16 tone fixture (little-endian), `samples` samples long. */
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

function b64(bytes: Buffer): string {
  return bytes.toString('base64');
}

function chunk(buffer: Buffer, size: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    parts.push(buffer.subarray(offset, offset + size));
  }
  return parts;
}

/** Drive a full capture through the service and return the committed recording. */
async function recordTone(
  service: RecordingService,
  pcm: Buffer,
  frameBytes = AUDIO_MAX_CHUNK_BYTES,
): Promise<AudioRecording> {
  const begin = service.beginCapture(null);
  const frames = chunk(pcm, frameBytes);
  let sequence = 0;
  for (const frame of frames) {
    service.appendChunk(begin.captureId, begin.token, sequence, b64(frame));
    sequence += 1;
  }
  return service.completeCapture(begin.captureId, begin.token);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected AppError ${code}`);
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    expect(error.code).toBe(code);
  }
}

async function expectCodeAsync(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected AppError ${code}`);
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    expect(error.code).toBe(code);
  }
}

describe('RecordingService — capture lifecycle', () => {
  it('records, stores and reads back the exact PCM bytes as a WAV', async () => {
    const service = makeService();
    const pcm = tonePcm(8_000); // 0.5s
    const recording = await recordTone(service, pcm);

    expect(recording.sampleRate).toBe(AUDIO_SAMPLE_RATE);
    expect(recording.channels).toBe(1);
    expect(recording.mediaType).toBe('audio/wav');
    expect(recording.durationMs).toBe(500);
    expect(recording.sizeBytes).toBe(WAV_HEADER_BYTES + pcm.length);

    expect(service.list()).toHaveLength(1);
    expect(service.get(recording.id).id).toBe(recording.id);

    // Stream the stored bytes back through the scoped playback API.
    const open = service.openPlayback(recording.id);
    expect(open.sizeBytes).toBe(recording.sizeBytes);
    const assembled: Buffer[] = [];
    let offset = 0;
    while (offset < open.sizeBytes) {
      const frame = service.readPlayback(
        recording.id,
        open.token,
        offset,
        open.maxReadBytes,
      );
      assembled.push(Buffer.from(frame.chunk, 'base64'));
      offset += frame.bytesRead;
      if (frame.eof) {
        break;
      }
    }
    const file = Buffer.concat(assembled);
    const header = parseWavHeader(file.subarray(0, WAV_HEADER_BYTES));
    expect(header?.dataBytes).toBe(pcm.length);
    expect(file.subarray(WAV_HEADER_BYTES).equals(pcm)).toBe(true);
    service.closePlayback(recording.id, open.token);
  });

  it('writes a managed WAV file and a safe public DTO without any path', async () => {
    const service = makeService();
    const recording = await recordTone(service, tonePcm(1_600));
    expect(Object.keys(recording)).not.toContain('relativePath');
    const originals = fs.readdirSync(storage.layout.audioOriginalsDir);
    expect(originals).toHaveLength(1);
    expect(originals[0].endsWith('.wav')).toBe(true);
  });

  it('rejects starting a second concurrent capture', () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    expectCode(() => service.beginCapture(null), 'CONFLICT');
    service.cancelCapture(begin.captureId, begin.token);
    // After cancel a new capture is allowed.
    const second = service.beginCapture(null);
    service.cancelCapture(second.captureId, second.token);
  });

  it('never saves an empty (silent) capture', async () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    await expectCodeAsync(
      () => service.completeCapture(begin.captureId, begin.token),
      'INVALID_INPUT',
    );
    expect(service.list()).toHaveLength(0);
    expect(fs.readdirSync(storage.layout.audioOriginalsDir)).toHaveLength(0);
  });
});

describe('RecordingService — idempotence & misuse', () => {
  it('treats cancel as idempotent for unknown/finished captures', () => {
    const service = makeService();
    expect(service.cancelCapture(crypto.randomUUID(), 'x'.repeat(32))).toEqual({
      cancelled: true,
    });
    const begin = service.beginCapture(null);
    service.cancelCapture(begin.captureId, begin.token);
    // Cancelling again is still a no-op success.
    expect(service.cancelCapture(begin.captureId, begin.token)).toEqual({
      cancelled: true,
    });
  });

  it('rejects out-of-order and duplicate frame sequences', () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    const frame = b64(tonePcm(100));
    service.appendChunk(begin.captureId, begin.token, 0, frame);
    expectCode(
      () => service.appendChunk(begin.captureId, begin.token, 0, frame),
      'CONFLICT',
    );
    service.cancelCapture(begin.captureId, begin.token);
  });

  it('rejects a foreign token on append, complete and cancel', async () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    const foreign = 'f'.repeat(48);
    expectCode(
      () => service.appendChunk(begin.captureId, foreign, 0, b64(tonePcm(10))),
      'PERMISSION_DENIED',
    );
    await expectCodeAsync(
      () => service.completeCapture(begin.captureId, foreign),
      'PERMISSION_DENIED',
    );
    expectCode(
      () => service.cancelCapture(begin.captureId, foreign),
      'PERMISSION_DENIED',
    );
    service.cancelCapture(begin.captureId, begin.token);
  });

  it('rejects an unknown capture session', () => {
    const service = makeService();
    expectCode(
      () =>
        service.appendChunk(
          crypto.randomUUID(),
          'z'.repeat(32),
          0,
          b64(tonePcm(10)),
        ),
      'NOT_FOUND',
    );
  });

  it('rejects empty and oversized frames and stops on overflow', () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    // An empty frame is rejected but keeps the session alive.
    expectCode(
      () => service.appendChunk(begin.captureId, begin.token, 0, ''),
      'INVALID_INPUT',
    );
    service.appendChunk(begin.captureId, begin.token, 0, b64(tonePcm(10)));
    // An oversized frame tears the session down.
    const tooBig = Buffer.alloc(AUDIO_MAX_CHUNK_BYTES + 2);
    expectCode(
      () => service.appendChunk(begin.captureId, begin.token, 1, b64(tooBig)),
      'INVALID_INPUT',
    );
    // Session was discarded: a follow-up append is unknown.
    expectCode(
      () =>
        service.appendChunk(begin.captureId, begin.token, 1, b64(tonePcm(1))),
      'NOT_FOUND',
    );
  });

  it('cannot complete the same capture twice', async () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    service.appendChunk(begin.captureId, begin.token, 0, b64(tonePcm(1_000)));
    await service.completeCapture(begin.captureId, begin.token);
    expect(service.list()).toHaveLength(1);
    // The session is consumed; a second completion is unknown.
    await expectCodeAsync(
      () => service.completeCapture(begin.captureId, begin.token),
      'NOT_FOUND',
    );
  });
});

describe('RecordingService — storage failures', () => {
  it('does not create a phantom recording when finalization fails', async () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    service.appendChunk(begin.captureId, begin.token, 0, b64(tonePcm(500)));
    // Remove the staging file out from under finalization to force an IO error.
    const staging = path.join(
      storage.layout.audioStagingDir,
      `${begin.captureId}.pcm`,
    );
    fs.rmSync(staging, { force: true });
    await expectCodeAsync(
      () => service.completeCapture(begin.captureId, begin.token),
      'IO_ERROR',
    );
    expect(service.list()).toHaveLength(0);
    // No committed file and no leftover row.
    expect(fs.readdirSync(storage.layout.audioOriginalsDir)).toHaveLength(0);
    expect(new AudioRepository(storage.db).count()).toBe(0);
  });
});

describe('RecordingService — playback access control', () => {
  it('revokes handles and validates id/token/offset', async () => {
    const service = makeService();
    const recording = await recordTone(service, tonePcm(1_000));
    const open = service.openPlayback(recording.id);

    // Foreign token or mismatched id is rejected.
    expectCode(
      () => service.readPlayback(recording.id, 'n'.repeat(48), 0, 16),
      'NOT_FOUND',
    );
    expectCode(
      () => service.readPlayback(crypto.randomUUID(), open.token, 0, 16),
      'NOT_FOUND',
    );
    // Offset past the end is rejected.
    expectCode(
      () =>
        service.readPlayback(recording.id, open.token, open.sizeBytes + 10, 16),
      'INVALID_INPUT',
    );
    // After close the handle no longer works.
    service.closePlayback(recording.id, open.token);
    expectCode(
      () => service.readPlayback(recording.id, open.token, 0, 16),
      'NOT_FOUND',
    );
  });

  it('refuses playback of an unknown recording', () => {
    const service = makeService();
    expectCode(() => service.openPlayback(crypto.randomUUID()), 'NOT_FOUND');
  });

  it('detects a corrupt/truncated stored file', async () => {
    const service = makeService();
    const recording = await recordTone(service, tonePcm(1_000));
    const file = path.join(
      storage.layout.audioOriginalsDir,
      fs.readdirSync(storage.layout.audioOriginalsDir)[0],
    );
    fs.truncateSync(file, 20); // corrupt the header/size
    expectCode(() => service.openPlayback(recording.id), 'IO_ERROR');
  });
});

describe('RecordingService — restart reconciliation', () => {
  it('clears an interrupted upload leaving no row or temp file', () => {
    const service = makeService();
    const begin = service.beginCapture(null);
    service.appendChunk(begin.captureId, begin.token, 0, b64(tonePcm(500)));
    // Simulate a crash: a staging .pcm remains and the session is lost.
    expect(
      fs.readdirSync(storage.layout.audioStagingDir).length,
    ).toBeGreaterThan(0);

    const rebuilt = makeService();
    const result = rebuilt.reconcile();
    expect(result.clearedStaging).toBeGreaterThan(0);
    expect(fs.readdirSync(storage.layout.audioStagingDir)).toHaveLength(0);
    expect(rebuilt.list()).toHaveLength(0);
  });

  it('promotes a finalizing row whose file committed cleanly', () => {
    const repo = new AudioRepository(storage.db);
    const pcm = tonePcm(1_000);
    const relativePath = storage.audioFileStore.newRelativePath('wav');
    const wav = Buffer.concat([
      buildWavHeader(pcm.length, {
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
      }),
      pcm,
    ]);
    fs.writeFileSync(storage.audioFileStore.resolve(relativePath), wav);
    repo.insertFinalizing({
      id: crypto.randomUUID(),
      profileId: 'local',
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
      sizeBytes: wav.length,
      durationMs: 500,
      relativePath,
      label: null,
      createdAt: new Date().toISOString(),
    });

    const service = makeService();
    const result = service.reconcile();
    expect(result.promoted).toBe(1);
    expect(service.list()).toHaveLength(1);
  });

  it('drops a finalizing row whose file never committed', () => {
    const repo = new AudioRepository(storage.db);
    repo.insertFinalizing({
      id: crypto.randomUUID(),
      profileId: 'local',
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
      sizeBytes: 1000,
      durationMs: 500,
      relativePath: storage.audioFileStore.newRelativePath('wav'),
      label: null,
      createdAt: new Date().toISOString(),
    });
    const service = makeService();
    const result = service.reconcile();
    expect(result.removedRows).toBe(1);
    expect(repo.count()).toBe(0);
  });

  it('removes an unreferenced orphan managed file', () => {
    const orphan = storage.audioFileStore.newRelativePath('wav');
    fs.writeFileSync(storage.audioFileStore.resolve(orphan), Buffer.alloc(64));
    const service = makeService();
    const result = service.reconcile();
    expect(result.removedOrphans).toBe(1);
    expect(fs.readdirSync(storage.layout.audioOriginalsDir)).toHaveLength(0);
  });

  it('leaves a committed recording intact across reconcile and restart', async () => {
    const service = makeService();
    const recording = await recordTone(service, tonePcm(2_000));
    // Rebuild service (simulated restart) and reconcile.
    const rebuilt = makeService();
    const result = rebuilt.reconcile();
    expect(result.promoted).toBe(0);
    expect(result.removedRows).toBe(0);
    expect(result.removedOrphans).toBe(0);
    const list = rebuilt.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(recording.id);
    // Still playable.
    const open = rebuilt.openPlayback(recording.id);
    expect(open.sizeBytes).toBe(recording.sizeBytes);
    rebuilt.closePlayback(recording.id, open.token);
  });
});

describe('RecordingService — bounded large transfer', () => {
  it('accepts many frames and finalizes a credible size/duration', async () => {
    const service = makeService();
    // ~2s of audio across many bounded frames.
    const pcm = tonePcm(32_000);
    const recording = await recordTone(service, pcm, 8 * 1024);
    expect(recording.durationMs).toBe(2_000);
    expect(recording.sizeBytes).toBe(WAV_HEADER_BYTES + pcm.length);
  });
});

describe('audio IPC + privacy', () => {
  function buildDispatcher(): Dispatcher {
    return createAppDispatcher({
      getAppVersion: () => '1.0.0',
      isStorageReady: () => true,
      telemetry,
      storage: {
        db: storage.db,
        fileStore: storage.fileStore,
        audioFileStore: storage.audioFileStore,
        audioStagingDir: storage.audioStagingDir,
      },
    });
  }

  async function send<T = unknown>(
    action: string,
    payload: unknown,
  ): Promise<ResponseEnvelope<T>> {
    return buildDispatcher().dispatch({
      requestId: crypto.randomUUID(),
      module: 'audio',
      version: 1,
      action,
      payload,
    }) as Promise<ResponseEnvelope<T>>;
  }

  it('exposes the audio module at API v1 over the dispatcher', async () => {
    const res = await send('list', {});
    expect(res.ok).toBe(true);
  });

  it('rejects an unsupported API version', async () => {
    const res = await buildDispatcher().dispatch({
      requestId: crypto.randomUUID(),
      module: 'audio',
      version: 2,
      action: 'list',
      payload: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VERSION_UNSUPPORTED');
    }
  });

  it('validates input and rejects malformed capture ids', async () => {
    const res = await send('capture.append', {
      captureId: 'not-a-uuid',
      token: 'x'.repeat(32),
      sequence: 0,
      chunk: 'AAAA',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_INPUT');
    }
  });

  it('keeps audio bytes, labels and paths out of telemetry (privacy canary)', async () => {
    const service = makeService();
    const canary = 'SENSITIVE_LABEL_CANARY';
    const begin = service.beginCapture(canary);
    service.appendChunk(begin.captureId, begin.token, 0, b64(tonePcm(1_000)));
    await service.completeCapture(begin.captureId, begin.token);

    const rows = telemetry.listByModule('audio', 50);
    expect(rows.length).toBeGreaterThan(0);
    const allowed = new Set([
      'durationMs',
      'sizeBytes',
      'sampleRate',
      'channels',
      'frames',
    ]);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(canary);
    expect(serialised).not.toContain(storage.layout.audioOriginalsDir);
    expect(serialised).not.toContain('.wav');
    for (const row of rows) {
      for (const key of Object.keys(row.detail ?? {})) {
        expect(allowed.has(key)).toBe(true);
      }
    }

    // The JSONL telemetry log must not leak the label or a path either.
    const logText = fs.readFileSync(path.join(workDir, 'app.jsonl'), 'utf8');
    expect(logText).not.toContain(canary);
    expect(logText).not.toContain(storage.layout.audioOriginalsDir);
  });

  it('passes foreign_key_check and integrity_check with a stored recording', async () => {
    const service = makeService();
    await recordTone(service, tonePcm(1_000));
    expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(storage.db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
  });
});
