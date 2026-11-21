import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_MAX_CHUNK_BYTES,
  AUDIO_MAX_DURATION_MS,
  AUDIO_MAX_RECORDING_BYTES,
  AUDIO_MEDIA_TYPE,
  AUDIO_PLAYBACK_MAX_READ_BYTES,
  AUDIO_SAMPLE_RATE,
  type AudioCaptureAppendOutput,
  type AudioCaptureBeginOutput,
  type AudioPlaybackOpenOutput,
  type AudioPlaybackReadOutput,
  type AudioRecording,
} from '../../../shared/contracts';
import { LOCAL_PROFILE_ID } from '../../core/db/database';
import type { FileStore } from '../../core/files/file-store';
import { AppError } from '../../ipc/errors';
import type { TelemetryService } from '../telemetry/telemetry.service';
import {
  toPublicRecording,
  type AudioRecordingRecord,
  type AudioRepository,
} from './audio.repository';
import type {
  RecordingSource,
  RecordingSourceReader,
} from './stt/transcription-provider';
import {
  WAV_HEADER_BYTES,
  buildWavHeader,
  isValidWavFile,
  parseWavHeader,
  pcmDurationMs,
  type WavFormat,
} from './audio.wav';

const CAPTURE_FORMAT: WavFormat = {
  sampleRate: AUDIO_SAMPLE_RATE,
  channels: AUDIO_CHANNELS,
  bitsPerSample: AUDIO_BITS_PER_SAMPLE,
};

/** An in-flight upload: a raw-PCM staging file plus bounded transfer state. */
interface CaptureSession {
  captureId: string;
  token: string;
  label: string | null;
  fd: number;
  stagingPath: string;
  nextSequence: number;
  totalBytes: number;
  startedAt: string;
  closed: boolean;
}

/** Chunk size used when streaming managed files (bounded memory). */
const COPY_BUFFER_BYTES = 64 * 1024;

/** A managed recording file whose WAV header and size have been validated. */
interface ValidatedWav {
  absolutePath: string;
  sizeBytes: number;
  format: WavFormat;
}

/** A scoped, revocable handle for streaming one stored recording's bytes. */
interface PlaybackHandle {
  recordingId: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface RecordingServiceDeps {
  repository: AudioRepository;
  /** Managed store rooted at the audio-originals directory. */
  fileStore: FileStore;
  /** Private directory for raw-PCM staging files (separate from the store temp). */
  stagingDir: string;
  telemetry?: TelemetryService;
  profileId?: string;
  now?: () => string;
}

export interface ReconcileResult {
  clearedStaging: number;
  promoted: number;
  removedRows: number;
  removedOrphans: number;
}

/**
 * In-process shared Audio recording service. Owns the capture lifecycle (a
 * bounded, ordered chunk upload into a private raw-PCM staging file), crash-safe
 * finalization into a canonical PCM16/16 kHz WAV under managed private storage,
 * boot reconciliation of interrupted work, and scoped playback by opaque id.
 *
 * It has no dependency on speech-to-text, Ollama or Interviews: a recording can
 * be made, stored, listed and replayed with no models installed. The renderer
 * never receives a filesystem path — recordings are addressed by id, and bytes
 * cross the boundary only as bounded, validated base64 frames.
 */
export class RecordingService implements RecordingSourceReader {
  private readonly repository: AudioRepository;
  private readonly fileStore: FileStore;
  private readonly stagingDir: string;
  private readonly telemetry?: TelemetryService;
  private readonly profileId: string;
  private readonly now: () => string;

  private readonly sessions = new Map<string, CaptureSession>();
  private readonly playback = new Map<string, PlaybackHandle>();

  hasOpenHandles(): boolean {
    return this.sessions.size > 0 || this.playback.size > 0;
  }

  constructor(deps: RecordingServiceDeps) {
    this.repository = deps.repository;
    this.fileStore = deps.fileStore;
    this.stagingDir = deps.stagingDir;
    this.telemetry = deps.telemetry;
    this.profileId = deps.profileId ?? LOCAL_PROFILE_ID;
    this.now = deps.now ?? (() => new Date().toISOString());
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  // --- capture --------------------------------------------------------------

  beginCapture(label: string | null): AudioCaptureBeginOutput {
    // One active upload per client (single trusted window). A stuck session is
    // cleared on app restart by reconcile(); it never silently evicts here.
    if (this.sessions.size > 0) {
      throw new AppError(
        'CONFLICT',
        'A recording is already in progress. Stop it before starting another.',
      );
    }

    const captureId = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('hex');
    const stagingPath = path.join(this.stagingDir, `${captureId}.pcm`);

    let fd: number;
    try {
      fd = fs.openSync(stagingPath, 'wx');
    } catch {
      throw new AppError('IO_ERROR', 'Could not start recording storage.');
    }

    this.sessions.set(captureId, {
      captureId,
      token,
      label,
      fd,
      stagingPath,
      nextSequence: 0,
      totalBytes: 0,
      startedAt: this.now(),
      closed: false,
    });

    return {
      captureId,
      token,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      bitsPerSample: AUDIO_BITS_PER_SAMPLE,
      maxChunkBytes: AUDIO_MAX_CHUNK_BYTES,
      maxDurationMs: AUDIO_MAX_DURATION_MS,
      maxBytes: AUDIO_MAX_RECORDING_BYTES,
    };
  }

  appendChunk(
    captureId: string,
    token: string,
    sequence: number,
    chunkBase64: string,
  ): AudioCaptureAppendOutput {
    const session = this.authorizeSession(captureId, token);

    if (sequence !== session.nextSequence) {
      throw new AppError(
        'CONFLICT',
        'Audio frames arrived out of order; the recording was stopped.',
      );
    }

    const bytes = Buffer.from(chunkBase64, 'base64');
    if (bytes.length === 0) {
      throw new AppError('INVALID_INPUT', 'An empty audio frame was rejected.');
    }
    if (bytes.length > AUDIO_MAX_CHUNK_BYTES) {
      this.discardSession(session);
      throw new AppError(
        'INVALID_INPUT',
        'An audio frame exceeded the allowed size.',
      );
    }
    if (session.totalBytes + bytes.length > AUDIO_MAX_RECORDING_BYTES) {
      this.discardSession(session);
      throw new AppError(
        'INVALID_INPUT',
        'The recording exceeded the maximum length and was stopped.',
      );
    }

    try {
      fs.writeSync(session.fd, bytes, 0, bytes.length);
    } catch {
      this.discardSession(session);
      throw new AppError('IO_ERROR', 'Failed to store the audio frame.');
    }

    session.totalBytes += bytes.length;
    session.nextSequence += 1;
    return { sequence, receivedBytes: session.totalBytes };
  }

  async completeCapture(
    captureId: string,
    token: string,
  ): Promise<AudioRecording> {
    const session = this.authorizeSession(captureId, token);
    session.closed = true;
    this.closeFd(session);

    const pcmBytes = session.totalBytes;
    if (pcmBytes === 0) {
      this.finishSession(session);
      throw new AppError(
        'INVALID_INPUT',
        'No audio was captured, so nothing was saved.',
      );
    }

    const recordingId = crypto.randomUUID();
    const relativePath = this.fileStore.newRelativePath('wav');
    const durationMs = pcmDurationMs(pcmBytes, CAPTURE_FORMAT);
    const wavBytes = WAV_HEADER_BYTES + pcmBytes;
    const createdAt = this.now();
    const wavTempPath = path.join(this.stagingDir, `${recordingId}.wav.part`);

    // Write-ahead the metadata intent so a crash during finalization is
    // reconcilable: the row exists as `finalizing` before the file is committed.
    this.repository.insertFinalizing({
      id: recordingId,
      profileId: this.profileId,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      sizeBytes: wavBytes,
      durationMs,
      relativePath,
      label: session.label,
      createdAt,
    });

    try {
      await this.commitRecording(
        recordingId,
        session.stagingPath,
        wavTempPath,
        relativePath,
        pcmBytes,
      );
    } catch {
      // Finalization failed: never leave a phantom completed asset behind.
      this.safeStoreRemove(relativePath);
      this.repository.delete(recordingId);
      this.removeStaging(wavTempPath);
      this.finishSession(session);
      throw new AppError('IO_ERROR', 'The recording could not be saved.');
    }

    this.removeStaging(wavTempPath);
    this.finishSession(session);

    this.record('capture.complete', 'success', session.startedAt, {
      durationMs,
      sizeBytes: wavBytes,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      frames: session.nextSequence,
    });

    const record = this.repository.get(recordingId);
    if (!record) {
      throw new AppError('INTERNAL', 'The recording could not be read back.');
    }
    return toPublicRecording(record);
  }

  cancelCapture(captureId: string, token: string): { cancelled: true } {
    const session = this.sessions.get(captureId);
    // Cancellation is idempotent: an unknown/already-finished capture is a no-op.
    if (!session) {
      return { cancelled: true };
    }
    if (session.token !== token) {
      throw new AppError('PERMISSION_DENIED', 'This action is not permitted.');
    }
    this.discardSession(session);
    this.record('capture.cancel', 'cancelled', session.startedAt, {
      frames: session.nextSequence,
    });
    return { cancelled: true };
  }

  // --- listing --------------------------------------------------------------

  list(): AudioRecording[] {
    return this.repository.listReady();
  }

  get(id: string): AudioRecording {
    return toPublicRecording(this.requireReadyRecord(id));
  }

  /**
   * Resolve a finalized recording into a validated, main-process-only source
   * descriptor for transcription. This is the Audio domain's read-only seam for
   * the TranscriptionService: it confirms the recording is `ready` and that the
   * managed file is a genuine canonical PCM WAV before returning its absolute
   * path. The renderer never calls this and never receives the path. A foreign
   * or non-ready id is rejected (`NOT_FOUND`); a corrupt file is `IO_ERROR`.
   */
  resolveRecordingSource(recordingId: string): RecordingSource {
    const record = this.requireReadyRecord(recordingId);
    const { absolutePath, sizeBytes, format } = this.readValidatedWav(
      record,
      'The stored recording is corrupt and cannot be transcribed.',
    );
    return {
      recordingId,
      absolutePath,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: format.bitsPerSample,
      sizeBytes,
    };
  }

  // --- playback -------------------------------------------------------------

  openPlayback(id: string): AudioPlaybackOpenOutput {
    const record = this.requireReadyRecord(id);
    const { absolutePath, sizeBytes } = this.readValidatedWav(
      record,
      'The stored recording is corrupt and cannot be played.',
    );

    const token = crypto.randomBytes(24).toString('hex');
    this.playback.set(token, { recordingId: id, absolutePath, sizeBytes });

    return {
      token,
      sizeBytes,
      mediaType: AUDIO_MEDIA_TYPE,
      maxReadBytes: AUDIO_PLAYBACK_MAX_READ_BYTES,
    };
  }

  readPlayback(
    id: string,
    token: string,
    offset: number,
    length: number,
  ): AudioPlaybackReadOutput {
    const handle = this.playback.get(token);
    if (!handle || handle.recordingId !== id) {
      throw new AppError('NOT_FOUND', 'That playback session is not active.');
    }
    if (offset > handle.sizeBytes) {
      throw new AppError('INVALID_INPUT', 'The read offset is out of range.');
    }

    const toRead = Math.min(
      length,
      AUDIO_PLAYBACK_MAX_READ_BYTES,
      handle.sizeBytes - offset,
    );
    if (toRead <= 0) {
      return { chunk: '', bytesRead: 0, offset, eof: true };
    }

    const buffer = Buffer.alloc(toRead);
    let fd: number | undefined;
    let bytesRead = 0;
    try {
      fd = fs.openSync(handle.absolutePath, 'r');
      bytesRead = fs.readSync(fd, buffer, 0, toRead, offset);
    } catch {
      throw new AppError('IO_ERROR', 'The recording could not be read.');
    } finally {
      closeQuietly(fd);
    }

    return {
      chunk: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      offset,
      eof: offset + bytesRead >= handle.sizeBytes,
    };
  }

  closePlayback(id: string, token: string): { closed: true } {
    const handle = this.playback.get(token);
    if (handle && handle.recordingId === id) {
      this.playback.delete(token);
    }
    return { closed: true };
  }

  // --- reconciliation -------------------------------------------------------

  /**
   * Reconcile durable state at boot: clear interrupted staging files, promote
   * finalizing rows whose file committed cleanly, drop finalizing/failed rows
   * whose file is missing or corrupt, and remove unreferenced managed files.
   * Finalized (`ready`) recordings are never touched.
   */
  reconcile(): ReconcileResult {
    const clearedStaging = this.clearStaging();

    let promoted = 0;
    let removedRows = 0;
    for (const record of this.repository.listNotReady()) {
      if (record.state === 'finalizing' && this.tryPromoteFinalizing(record)) {
        promoted += 1;
        continue;
      }
      this.safeStoreRemove(record.relativePath);
      this.repository.delete(record.id);
      removedRows += 1;
    }

    const removedOrphans = this.removeOrphans();

    const result = { clearedStaging, promoted, removedRows, removedOrphans };
    if (clearedStaging || promoted || removedRows || removedOrphans) {
      this.record('reconcile', 'success', this.now(), { ...result });
    }
    return result;
  }

  // --- helpers --------------------------------------------------------------

  private authorizeSession(captureId: string, token: string): CaptureSession {
    const session = this.sessions.get(captureId);
    if (!session || session.closed) {
      throw new AppError('NOT_FOUND', 'That recording session is not active.');
    }
    if (session.token !== token) {
      throw new AppError('PERMISSION_DENIED', 'This action is not permitted.');
    }
    return session;
  }

  private requireReadyRecord(id: string): AudioRecordingRecord {
    const record = this.repository.get(id);
    if (!record || record.state !== 'ready') {
      throw new AppError('NOT_FOUND', 'That recording could not be found.');
    }
    return record;
  }

  /**
   * Locate a ready recording's managed file and confirm it is a canonical WAV
   * whose declared length matches its size. Throws `NOT_FOUND` when the file
   * is missing and `IO_ERROR` (with `corruptMessage`) when it is invalid.
   */
  private readValidatedWav(
    record: AudioRecordingRecord,
    corruptMessage: string,
  ): ValidatedWav {
    const absolutePath = this.resolveExisting(record);
    const sizeBytes = fs.statSync(absolutePath).size;
    const header = readFileHeader(absolutePath, WAV_HEADER_BYTES);
    const format = parseWavHeader(header);
    if (!format || !isValidWavFile(header, sizeBytes)) {
      throw new AppError('IO_ERROR', corruptMessage);
    }
    return { absolutePath, sizeBytes, format };
  }

  /** Non-throwing variant for reconciliation: any problem yields `undefined`. */
  private inspectStoredWav(relativePath: string): ValidatedWav | undefined {
    try {
      const absolutePath = this.fileStore.resolve(relativePath);
      if (!fs.existsSync(absolutePath)) {
        return undefined;
      }
      const sizeBytes = fs.statSync(absolutePath).size;
      const header = readFileHeader(absolutePath, WAV_HEADER_BYTES);
      const format = parseWavHeader(header);
      if (!format || !isValidWavFile(header, sizeBytes)) {
        return undefined;
      }
      return { absolutePath, sizeBytes, format };
    } catch {
      return undefined;
    }
  }

  /** Convert the staged PCM to WAV, commit it to the store and mark it ready. */
  private async commitRecording(
    recordingId: string,
    stagingPath: string,
    wavTempPath: string,
    relativePath: string,
    pcmBytes: number,
  ): Promise<void> {
    wrapPcmAsWav(stagingPath, wavTempPath, pcmBytes, CAPTURE_FORMAT);
    const stored = await this.fileStore.importFromPath(
      wavTempPath,
      relativePath,
    );
    this.repository.markReady(
      recordingId,
      stored.sha256,
      stored.sizeBytes,
      this.now(),
    );
  }

  private tryPromoteFinalizing(record: AudioRecordingRecord): boolean {
    const wav = this.inspectStoredWav(record.relativePath);
    if (
      !wav ||
      wav.format.sampleRate !== record.sampleRate ||
      wav.format.channels !== record.channels
    ) {
      return false;
    }
    const sha256 = hashFile(wav.absolutePath);
    if (!sha256) {
      return false;
    }
    this.repository.markReady(record.id, sha256, wav.sizeBytes, this.now());
    return true;
  }

  private clearStaging(): number {
    let removed = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.stagingDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      try {
        fs.rmSync(path.join(this.stagingDir, entry), { force: true });
        removed += 1;
      } catch {
        /* best-effort */
      }
    }
    return removed;
  }

  private removeOrphans(): number {
    const referenced = this.repository.allRelativePaths();
    let removed = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.fileStore.resolve('.'), {
        withFileTypes: true,
      });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isFile() || referenced.has(entry.name)) {
        continue;
      }
      this.safeStoreRemove(entry.name);
      removed += 1;
    }
    return removed;
  }

  private resolveExisting(record: AudioRecordingRecord): string {
    let absolutePath: string;
    try {
      absolutePath = this.fileStore.resolve(record.relativePath);
    } catch {
      throw new AppError('IO_ERROR', 'The managed file could not be located.');
    }
    if (!fs.existsSync(absolutePath)) {
      throw new AppError(
        'NOT_FOUND',
        'The stored recording is missing and cannot be played.',
      );
    }
    return absolutePath;
  }

  private discardSession(session: CaptureSession): void {
    session.closed = true;
    this.closeFd(session);
    this.finishSession(session);
  }

  /** Remove the staging file and forget the session (fd must already be closed). */
  private finishSession(session: CaptureSession): void {
    this.removeStaging(session.stagingPath);
    this.sessions.delete(session.captureId);
  }

  private closeFd(session: CaptureSession): void {
    try {
      fs.closeSync(session.fd);
    } catch {
      /* descriptor already closed */
    }
  }

  private removeStaging(target: string): void {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  private safeStoreRemove(relativePath: string): void {
    try {
      this.fileStore.remove(relativePath);
    } catch {
      /* reconciled later */
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

/** Stream a raw-PCM staging file into a canonical WAV temp file (bounded memory). */
function wrapPcmAsWav(
  pcmPath: string,
  wavPath: string,
  pcmBytes: number,
  format: WavFormat,
): void {
  const header = buildWavHeader(pcmBytes, format);
  fs.writeFileSync(wavPath, header, { flag: 'wx' });

  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  let readFd: number | undefined;
  let writeFd: number | undefined;
  try {
    readFd = fs.openSync(pcmPath, 'r');
    writeFd = fs.openSync(wavPath, 'a');
    let position = 0;
    for (;;) {
      const read = fs.readSync(readFd, buffer, 0, buffer.length, position);
      if (read <= 0) {
        break;
      }
      fs.writeSync(writeFd, buffer, 0, read);
      position += read;
    }
  } finally {
    closeQuietly(readFd);
    closeQuietly(writeFd);
  }
}

function closeQuietly(fd: number | undefined): void {
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

function readFileHeader(filePath: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    throw new AppError('IO_ERROR', 'The recording could not be read.');
  } finally {
    closeQuietly(fd);
  }
}

function hashFile(filePath: string): string | undefined {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    closeQuietly(fd);
  }
}
