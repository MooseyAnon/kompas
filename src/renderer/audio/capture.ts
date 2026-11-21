import {
  audioCaptureAppend,
  audioCaptureBegin,
  audioCaptureCancel,
  audioCaptureComplete,
} from '../api';
import type { AudioRecording } from '../../shared/contracts';

/** Encode raw bytes to base64 without exceeding call-stack limits. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, i + step);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** Decode base64 back to bytes (used for playback assembly). */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Convert a Float32 frame to little-endian signed 16-bit PCM bytes. */
function floatToPcm16(samples: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, value, true);
  }
  return new Uint8Array(buffer);
}

export class MicrophoneUnavailableError extends Error {
  constructor() {
    super(
      'Microphone capture is not available in this window. A secure context with an audio input device is required.',
    );
    this.name = 'MicrophoneUnavailableError';
  }
}

export interface RecorderHandlers {
  onError: (message: string) => void;
  onBytes?: (totalBytes: number) => void;
  /**
   * Root-mean-square input level (0–1) of each captured frame, computed from
   * the same stream that is being recorded. Only this scalar leaves the
   * recorder; it is never stored or sent anywhere.
   */
  onLevel?: (level: number) => void;
}

/**
 * Captures microphone audio, downsamples it to the canonical 16 kHz mono PCM16
 * format and streams it to the main process as bounded, in-order frames over
 * the audio IPC. The renderer never touches the filesystem: it only produces
 * bytes and hands them to `window.career.request`.
 */
export class MicrophoneRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  private captureId = '';
  private token = '';
  private targetRate = 16_000;
  private maxChunkBytes = 32 * 1024;

  private sequence = 0;
  private totalBytes = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private resampleCursor = 0;
  private uploadChain: Promise<void> = Promise.resolve();
  private uploadError: Error | null = null;
  private active = false;

  constructor(private readonly handlers: RecorderHandlers) {}

  async start(label?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicrophoneUnavailableError();
    }

    const begin = await audioCaptureBegin(label);
    this.captureId = begin.captureId;
    this.token = begin.token;
    this.targetRate = begin.sampleRate;
    this.maxChunkBytes = begin.maxChunkBytes;
    this.sequence = 0;
    this.totalBytes = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.resampleCursor = 0;
    this.uploadChain = Promise.resolve();
    this.uploadError = null;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
    } catch (error) {
      // Permission denied / no device: release the reserved capture session.
      await audioCaptureCancel(this.captureId, this.token).catch(() => {});
      throw error;
    }

    this.context = new AudioContext();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.active) {
        return;
      }
      this.handleFrame(event.inputBuffer.getChannelData(0));
    };
    this.source.connect(this.processor);
    // ScriptProcessorNode only runs while connected to the graph output; we do
    // not copy input to output, so nothing is played back (no echo).
    this.processor.connect(this.context.destination);
    this.active = true;
  }

  /** Stop capture, flush the tail and finalize the recording. */
  async stop(): Promise<AudioRecording> {
    this.active = false;
    this.releaseMedia();
    this.flushPending(true);
    await this.settleUploads();
    if (this.uploadError) {
      await audioCaptureCancel(this.captureId, this.token).catch(() => {});
      throw this.uploadError;
    }
    return audioCaptureComplete(this.captureId, this.token);
  }

  /** Abort capture without producing a recording. */
  async cancel(): Promise<void> {
    this.active = false;
    this.releaseMedia();
    this.pending = [];
    this.pendingBytes = 0;
    await this.settleUploads();
    await audioCaptureCancel(this.captureId, this.token).catch(() => {});
  }

  /** Best-effort teardown for unmount/window close; never throws. */
  dispose(): void {
    this.active = false;
    this.releaseMedia();
    if (this.captureId && this.token) {
      void audioCaptureCancel(this.captureId, this.token).catch(() => {});
    }
  }

  private handleFrame(input: Float32Array): void {
    if (this.handlers.onLevel) this.handlers.onLevel(rootMeanSquare(input));
    const sourceRate = this.context?.sampleRate ?? this.targetRate;
    const down = this.resample(input, sourceRate);
    if (down.length === 0) {
      return;
    }
    this.pushBytes(floatToPcm16(down));
  }

  /** Nearest-sample decimation with a fractional cursor carried across blocks. */
  private resample(input: Float32Array, sourceRate: number): Float32Array {
    if (sourceRate === this.targetRate) {
      return input;
    }
    const ratio = sourceRate / this.targetRate;
    const out: number[] = [];
    let pos = this.resampleCursor;
    while (pos < input.length) {
      out.push(input[Math.floor(pos)]);
      pos += ratio;
    }
    this.resampleCursor = pos - input.length;
    return Float32Array.from(out);
  }

  private pushBytes(bytes: Uint8Array): void {
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    while (this.pendingBytes >= this.maxChunkBytes) {
      this.flushPending(false);
    }
  }

  private flushPending(force: boolean): void {
    if (this.pendingBytes === 0) {
      return;
    }
    if (!force && this.pendingBytes < this.maxChunkBytes) {
      return;
    }
    const merged = concat(this.pending, this.pendingBytes);
    const take = force
      ? Math.min(merged.length, this.maxChunkBytes)
      : this.maxChunkBytes;
    const frame = merged.subarray(0, take);
    const rest = merged.subarray(take);
    this.pending = rest.length > 0 ? [rest.slice()] : [];
    this.pendingBytes = rest.length;
    this.enqueue(frame.slice());
    if (force && this.pendingBytes > 0) {
      this.flushPending(true);
    }
  }

  private enqueue(frame: Uint8Array): void {
    const sequence = this.sequence;
    this.sequence += 1;
    this.totalBytes += frame.length;
    const encoded = bytesToBase64(frame);
    this.uploadChain = this.uploadChain.then(async () => {
      if (this.uploadError) {
        return;
      }
      try {
        await audioCaptureAppend(this.captureId, this.token, sequence, encoded);
        this.handlers.onBytes?.(this.totalBytes);
      } catch (error) {
        this.uploadError =
          error instanceof Error ? error : new Error('Upload failed.');
        this.handlers.onError(this.uploadError.message);
      }
    });
  }

  private async settleUploads(): Promise<void> {
    try {
      await this.uploadChain;
    } catch {
      /* individual errors are captured on uploadError */
    }
  }

  private releaseMedia(): void {
    try {
      this.processor?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') {
      void this.context.close().catch(() => {});
    }
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / samples.length));
}

function concat(parts: Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}
