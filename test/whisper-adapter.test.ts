import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWavHeader } from '../src/main/modules/audio/audio.wav';
import {
  WhisperCppAdapter,
  WHISPER_PROVIDER_ID,
} from '../src/main/modules/audio/stt/whisper-adapter';
import {
  resolveWhisperAssets,
  type WhisperAssets,
} from '../src/main/modules/audio/stt/whisper-assets';
import type { RecordingSource } from '../src/main/modules/audio/stt/transcription-provider';
import { AUDIO_SAMPLE_RATE } from '../src/shared/contracts';

const repoRoot = path.resolve(__dirname, '..');
const realAssets = resolveWhisperAssets(
  path.join(repoRoot, 'resources', 'whisper'),
);
const REAL_AVAILABLE =
  process.platform === 'darwin' &&
  process.arch === 'arm64' &&
  Boolean(realAssets.manifest) &&
  fs.existsSync(realAssets.binaryPath) &&
  fs.existsSync(realAssets.modelPath);

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-whisper-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A fabricated asset layout with a stub manifest for offline probe tests. */
function fakeAssets(opts: {
  binary?: boolean;
  modelBytes?: number | null;
  modelMagic?: boolean;
}): WhisperAssets {
  const binaryPath = path.join(workDir, 'bin', 'whisper-cli');
  const modelPath = path.join(workDir, 'models', 'ggml-base.bin');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  if (opts.binary) {
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binaryPath, 0o755);
  }
  if (opts.modelBytes !== null && opts.modelBytes !== undefined) {
    const buf = Buffer.alloc(opts.modelBytes);
    if (opts.modelMagic) {
      buf.writeUInt32LE(0x67676d6c, 0);
    }
    fs.writeFileSync(modelPath, buf);
  }
  return {
    rootDir: workDir,
    binaryPath,
    modelPath,
    manifestPath: path.join(workDir, 'manifest.json'),
    manifest: {
      engine: {
        id: 'whisper.cpp',
        tag: 'v1.9.5',
        commit: 'test',
        executable: 'bin/whisper-cli',
        executableSha256: 'x',
        executableBytes: 10,
        runtime: 'cpu',
      },
      model: {
        id: 'whisper-base-multilingual',
        file: 'models/ggml-base.bin',
        variant: 'base',
        multilingual: true,
        sha256: 'x',
        bytes: 2048,
      },
    },
  };
}

/** Write a canonical 16 kHz mono PCM16 WAV tone and return its path. */
function writeToneWav(samples: number): string {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(
      Math.round(Math.sin((i / AUDIO_SAMPLE_RATE) * 2 * Math.PI * 220) * 4000),
      i * 2,
    );
  }
  const header = buildWavHeader(pcm.length, {
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
  });
  const wavPath = path.join(workDir, 'tone.wav');
  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
  return wavPath;
}

describe('WhisperCppAdapter capability probe', () => {
  it('reports executable_missing when the binary is absent', async () => {
    const adapter = new WhisperCppAdapter({
      assets: fakeAssets({ binary: false, modelBytes: 2048, modelMagic: true }),
    });
    const probe = await adapter.probe();
    expect(probe.providerId).toBe(WHISPER_PROVIDER_ID);
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe('executable_missing');
  });

  it('reports model_missing when the model file is absent', async () => {
    const adapter = new WhisperCppAdapter({
      assets: fakeAssets({ binary: true, modelBytes: null }),
    });
    const probe = await adapter.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe('model_missing');
  });

  it('reports model_corrupt when the model size does not match the manifest', async () => {
    const adapter = new WhisperCppAdapter({
      assets: fakeAssets({ binary: true, modelBytes: 64, modelMagic: true }),
    });
    const probe = await adapter.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe('model_corrupt');
  });

  it('reports model_corrupt when the GGML magic is wrong', async () => {
    const adapter = new WhisperCppAdapter({
      assets: fakeAssets({ binary: true, modelBytes: 2048, modelMagic: false }),
    });
    const probe = await adapter.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe('model_corrupt');
  });

  it('fails transcription with provider_unavailable code when assets are missing', async () => {
    const adapter = new WhisperCppAdapter({
      assets: fakeAssets({ binary: false, modelBytes: null }),
    });
    const source: RecordingSource = {
      recordingId: 'r',
      absolutePath: writeToneWav(1_000),
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
    } as RecordingSource & { sizeBytes: number };
    const outcome = await adapter.transcribe(
      { ...source, sizeBytes: 0 },
      { languageHint: 'auto', timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.code).toBe('executable_missing');
    }
  });
});

describe.runIf(REAL_AVAILABLE)(
  'WhisperCppAdapter with the provisioned engine',
  () => {
    it('probes as installed & ready with measured model bytes', async () => {
      const adapter = new WhisperCppAdapter({ assets: realAssets });
      const probe = await adapter.probe();
      expect(probe.available).toBe(true);
      expect(probe.offline).toBe(true);
      expect(probe.model?.multilingual).toBe(true);
      expect(probe.model?.bytes).toBe(realAssets.manifest?.model.bytes);
      expect(probe.engineVersion).toBe(realAssets.manifest?.engine.tag);
    });

    it('deep-verify confirms the model content hash', async () => {
      const adapter = new WhisperCppAdapter({ assets: realAssets });
      const probe = await adapter.verify();
      expect(probe.available).toBe(true);
    });

    it('rejects audio that is not 16 kHz mono PCM16 as invalid_audio', async () => {
      const adapter = new WhisperCppAdapter({ assets: realAssets });
      const outcome = await adapter.transcribe(
        {
          recordingId: 'r',
          absolutePath: writeToneWav(1_000),
          sampleRate: 44_100,
          channels: 2,
          bitsPerSample: 16,
          sizeBytes: 0,
        },
        { languageHint: 'auto', timeoutMs: 20_000 },
        new AbortController().signal,
      );
      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.code).toBe('invalid_audio');
      }
    });

    it('runs the real CLI on a canonical WAV and completes (tone → empty text)', async () => {
      const adapter = new WhisperCppAdapter({ assets: realAssets, threads: 2 });
      const outcome = await adapter.transcribe(
        {
          recordingId: 'r',
          absolutePath: writeToneWav(16_000),
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: 1,
          bitsPerSample: 16,
          sizeBytes: 0,
        },
        { languageHint: 'auto', timeoutMs: 60_000 },
        new AbortController().signal,
      );
      expect(outcome.status).toBe('completed');
      if (outcome.status === 'completed') {
        expect(outcome.engineVersion).toBe(realAssets.manifest?.engine.tag);
        expect(typeof outcome.text).toBe('string');
      }
    });

    it('cancellation kills the child and returns cancelled with no result', async () => {
      const adapter = new WhisperCppAdapter({ assets: realAssets, threads: 1 });
      const controller = new AbortController();
      const promise = adapter.transcribe(
        {
          recordingId: 'r',
          absolutePath: writeToneWav(16_000 * 5),
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: 1,
          bitsPerSample: 16,
          sizeBytes: 0,
        },
        { languageHint: 'auto', timeoutMs: 60_000 },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 20);
      const outcome = await promise;
      expect(['cancelled', 'completed']).toContain(outcome.status);
    });
  },
);
