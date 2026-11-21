import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  SttFailureCode,
  SttModelInfo,
} from '../../../../shared/contracts';
import { parseWavHeader, WAV_HEADER_BYTES } from '../audio.wav';
import type {
  ProviderProbe,
  ProviderSegment,
  RecordingSource,
  TranscriptionOptions,
  TranscriptionOutcome,
  TranscriptionProvider,
} from './transcription-provider';
import type { WhisperAssets } from './whisper-assets';

/** Stable provider id and human engine name (safe to surface in the UI). */
export const WHISPER_PROVIDER_ID = 'whisper-cpp';
export const WHISPER_ENGINE_NAME = 'whisper.cpp';

/** GGML file magic (`ggml` as little-endian uint32) at the start of the model. */
const GGML_MAGIC = 0x67676d6c;

/** Expected canonical recording format (Stage 008.1). */
const EXPECTED_SAMPLE_RATE = 16_000;
const EXPECTED_CHANNELS = 1;
const EXPECTED_BITS = 16;

/** Bounded stdio capture: we read only a little, and never log it. */
const MAX_STDIO_BYTES = 16 * 1024;

/** Languages surfaced as commonly-supported hints (multilingual base). */
const SUPPORTED_LOCALES = ['auto', 'en'];

/** How a `whisper-cli` invocation ended, with its exit code when it exited. */
interface CliRunResult {
  status: 'exited' | 'cancelled' | 'timed_out' | 'crashed';
  code: number | null;
}

/** Normalised fields extracted from the CLI's JSON result file. */
interface ParsedWhisperOutput {
  text: string;
  segments: ProviderSegment[] | null;
  language: string | null;
}

export interface WhisperCppAdapterDeps {
  assets: WhisperAssets;
  /** Thread count for the CLI; defaults to a small bounded value. */
  threads?: number;
  /** Private directory for per-job output; defaults to the OS temp dir. */
  tmpDir?: string;
}

/**
 * Speech-to-text provider backed by the bundled, pinned `whisper-cli`
 * executable. The engine is run as a trusted, application-controlled child
 * process: a fixed executable path, an argument *vector* (never a shell string,
 * never a PATH lookup), a fixed model path and a private per-call output
 * directory. Only model-specific flags are constructed here; the generic
 * TranscriptionService never sees them. stdout/stderr are read with a hard cap
 * and never logged; recognised text is returned to the caller only.
 */
export class WhisperCppAdapter implements TranscriptionProvider {
  readonly id = WHISPER_PROVIDER_ID;
  private readonly assets: WhisperAssets;
  private readonly threads: number;
  private readonly tmpDir: string;

  constructor(deps: WhisperCppAdapterDeps) {
    this.assets = deps.assets;
    this.threads = Math.max(1, Math.min(deps.threads ?? 4, 8));
    this.tmpDir = deps.tmpDir ?? os.tmpdir();
  }

  async probe(): Promise<ProviderProbe> {
    return this.inspect(false);
  }

  async verify(): Promise<ProviderProbe> {
    return this.inspect(true);
  }

  /**
   * Inspect bundled assets. The cheap path checks the executable bit and that
   * the model is present with the manifest-declared size and a valid GGML magic
   * header. When `deep` is set, the model's full SHA-256 is verified against the
   * manifest so a silently-corrupted file is detected.
   */
  private async inspect(deep: boolean): Promise<ProviderProbe> {
    const model = this.modelInfo();
    const base: ProviderProbe = {
      providerId: this.id,
      engine: WHISPER_ENGINE_NAME,
      available: false,
      offline: true,
      engineVersion: this.assets.manifest?.engine.tag ?? null,
      model,
      reason: null,
      locales: SUPPORTED_LOCALES,
    };

    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      return { ...base, reason: 'unsupported_platform' };
    }
    if (!this.isExecutableReady()) {
      return { ...base, reason: 'executable_missing' };
    }
    const modelState = this.checkModel(deep);
    if (modelState !== 'ok') {
      return { ...base, reason: modelState };
    }
    return { ...base, available: true };
  }

  private modelInfo(): SttModelInfo | null {
    const manifest = this.assets.manifest;
    const bytes = fileBytesSafe(this.assets.modelPath);
    if (manifest) {
      return {
        id: manifest.model.id,
        displayName: 'Whisper base (multilingual)',
        variant: manifest.model.variant,
        multilingual: manifest.model.multilingual,
        bytes: bytes ?? manifest.model.bytes,
      };
    }
    if (bytes === null) {
      return null;
    }
    return {
      id: 'whisper-base',
      displayName: 'Whisper base',
      variant: 'base',
      multilingual: true,
      bytes,
    };
  }

  private isExecutableReady(): boolean {
    try {
      fs.accessSync(this.assets.binaryPath, fs.constants.X_OK);
      return fs.statSync(this.assets.binaryPath).isFile();
    } catch {
      return false;
    }
  }

  private checkModel(deep: boolean): 'ok' | SttFailureCode {
    const bytes = fileBytesSafe(this.assets.modelPath);
    if (bytes === null) {
      return 'model_missing';
    }
    const manifest = this.assets.manifest;
    if (manifest && bytes !== manifest.model.bytes) {
      return 'model_corrupt';
    }
    if (!hasGgmlMagic(this.assets.modelPath)) {
      return 'model_corrupt';
    }
    if (
      deep &&
      manifest &&
      sha256File(this.assets.modelPath) !== manifest.model.sha256
    ) {
      return 'model_corrupt';
    }
    return 'ok';
  }

  async transcribe(
    source: RecordingSource,
    options: TranscriptionOptions,
    signal: AbortSignal,
  ): Promise<TranscriptionOutcome> {
    const probe = await this.probe();
    if (!probe.available) {
      return { status: 'failed', code: probe.reason ?? 'provider_unavailable' };
    }
    if (!this.isValidSource(source)) {
      return { status: 'failed', code: 'invalid_audio' };
    }
    if (signal.aborted) {
      return { status: 'cancelled' };
    }

    const outDir = fs.mkdtempSync(path.join(this.tmpDir, 'cw-stt-'));
    const outBase = path.join(outDir, 'out');
    const startedMs = Date.now();
    try {
      const run = await this.runCli(
        source.absolutePath,
        outBase,
        options,
        signal,
      );
      if (run.status === 'cancelled') {
        return { status: 'cancelled' };
      }
      if (run.status === 'timed_out') {
        return { status: 'failed', code: 'timed_out' };
      }
      if (run.status === 'crashed') {
        return { status: 'failed', code: 'process_crashed' };
      }
      if (run.code !== 0) {
        return { status: 'failed', code: 'engine_failed' };
      }
      const parsed = this.parseOutput(`${outBase}.json`);
      if (!parsed) {
        return { status: 'failed', code: 'invalid_output' };
      }
      return {
        status: 'completed',
        text: parsed.text,
        segments: parsed.segments,
        languageDetected: parsed.language,
        engineVersion: this.assets.manifest?.engine.tag ?? 'unknown',
        modelId: probe.model?.id ?? 'whisper-base',
        durationMs: Date.now() - startedMs,
      };
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }

  private isValidSource(source: RecordingSource): boolean {
    if (
      source.sampleRate !== EXPECTED_SAMPLE_RATE ||
      source.channels !== EXPECTED_CHANNELS ||
      source.bitsPerSample !== EXPECTED_BITS
    ) {
      return false;
    }
    const header = readHeaderSafe(source.absolutePath, WAV_HEADER_BYTES);
    if (!header) {
      return false;
    }
    const parsed = parseWavHeader(header);
    return Boolean(
      parsed &&
      parsed.sampleRate === EXPECTED_SAMPLE_RATE &&
      parsed.channels === EXPECTED_CHANNELS &&
      parsed.bitsPerSample === EXPECTED_BITS,
    );
  }

  /**
   * Fixed, argument-vector invocation. `shell:false`, no PATH lookup (absolute
   * executable path), a fixed model path and a private output base. The only
   * caller-influenced value is a validated language hint. The child is force
   * killed and reaped on cancellation or timeout.
   */
  private runCli(
    wavPath: string,
    outBase: string,
    options: TranscriptionOptions,
    signal: AbortSignal,
  ): Promise<CliRunResult> {
    const args = this.buildCliArgs(wavPath, outBase, options.languageHint);

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let stderrBytes = 0;

      const child = spawn(this.assets.binaryPath, args, {
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: '' },
        cwd: path.dirname(outBase),
      });

      const finish = (status: CliRunResult['status'], code: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve({ status, code });
      };

      const kill = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);

      const onAbort = () => {
        cancelled = true;
        kill();
      };
      if (signal.aborted) {
        cancelled = true;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      // Drain stderr with a hard cap; it is NEVER logged or surfaced.
      child.stderr?.on('data', (buf: Buffer) => {
        stderrBytes += buf.length;
        if (stderrBytes > MAX_STDIO_BYTES) {
          child.stderr?.pause();
        }
      });

      child.on('error', () => finish('crashed', null));
      child.on('close', (code, sig) => {
        if (cancelled) {
          finish('cancelled', code);
        } else if (timedOut) {
          finish('timed_out', code);
        } else if (sig) {
          finish('crashed', code);
        } else {
          finish('exited', code);
        }
      });

      if (cancelled) {
        kill();
      }
    });
  }

  /** Fixed argument vector; the language hint is the only caller-influenced value. */
  private buildCliArgs(
    wavPath: string,
    outBase: string,
    languageHint: string,
  ): string[] {
    const language = /^(auto|[a-z]{2})$/u.test(languageHint)
      ? languageHint
      : 'auto';
    return [
      '-m',
      this.assets.modelPath,
      '-f',
      wavPath,
      '-l',
      language,
      '-t',
      String(this.threads),
      '-ng', // CPU only (matches the static, Metal-free build)
      '-np', // no prints other than results
      '-nt', // no inline timestamps in the text output
      '-oj', // write a JSON result file
      '-of',
      outBase,
    ];
  }

  private parseOutput(jsonPath: string): ParsedWhisperOutput | null {
    let raw: string;
    try {
      raw = fs.readFileSync(jsonPath, 'utf8');
    } catch {
      return null;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') {
      return null;
    }
    const record = data as {
      transcription?: Array<{
        text?: unknown;
        offsets?: { from?: unknown; to?: unknown };
      }>;
      result?: { language?: unknown };
    };
    const rows = Array.isArray(record.transcription)
      ? record.transcription
      : [];
    const segments: ProviderSegment[] = [];
    let text = '';
    for (const row of rows) {
      const piece = typeof row.text === 'string' ? row.text : '';
      text += piece;
      const from = toInt(row.offsets?.from);
      const to = toInt(row.offsets?.to);
      segments.push({
        startMs: from,
        endMs: Math.max(from, to),
        text: piece.trim(),
      });
    }
    const language =
      typeof record.result?.language === 'string'
        ? record.result.language
        : null;
    return {
      text: text.trim(),
      segments: segments.length > 0 ? segments : null,
      language,
    };
  }
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function fileBytesSafe(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function hasGgmlMagic(filePath: string): boolean {
  const header = readHeaderSafe(filePath, 4);
  return Boolean(
    header && header.length >= 4 && header.readUInt32LE(0) === GGML_MAGIC,
  );
}

function readHeaderSafe(filePath: string, length: number): Buffer | undefined {
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function sha256File(filePath: string): string | null {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  } catch {
    return null;
  }
}
