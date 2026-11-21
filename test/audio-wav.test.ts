import { describe, expect, it } from 'vitest';
import {
  WAV_HEADER_BYTES,
  buildWavHeader,
  isValidWavFile,
  parseWavHeader,
  pcmDurationMs,
} from '../src/main/modules/audio/audio.wav';

const FORMAT = { sampleRate: 16_000, channels: 1, bitsPerSample: 16 };

describe('wav header', () => {
  it('builds a canonical 44-byte PCM header round-trippable by the parser', () => {
    const dataBytes = 32_000;
    const header = buildWavHeader(dataBytes, FORMAT);
    expect(header.length).toBe(WAV_HEADER_BYTES);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.toString('ascii', 8, 12)).toBe('WAVE');

    const parsed = parseWavHeader(header);
    expect(parsed).toEqual({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes,
    });
  });

  it('encodes the correct byte rate and block alignment', () => {
    const header = buildWavHeader(0, FORMAT);
    expect(header.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(header.readUInt32LE(28)).toBe(32_000); // byte rate = rate * 2
    expect(header.readUInt16LE(32)).toBe(2); // block align
    expect(header.readUInt16LE(34)).toBe(16); // bits per sample
    expect(header.readUInt16LE(20)).toBe(1); // PCM
  });

  it('rejects non-RIFF, non-PCM and truncated headers', () => {
    expect(parseWavHeader(Buffer.alloc(10))).toBeUndefined();
    const notRiff = buildWavHeader(10, FORMAT);
    notRiff.write('XXXX', 0, 'ascii');
    expect(parseWavHeader(notRiff)).toBeUndefined();

    const nonPcm = buildWavHeader(10, FORMAT);
    nonPcm.writeUInt16LE(3, 20); // IEEE float, not PCM
    expect(parseWavHeader(nonPcm)).toBeUndefined();
  });

  it('validates total file size against the declared data length', () => {
    const dataBytes = 1_000;
    const header = buildWavHeader(dataBytes, FORMAT);
    expect(isValidWavFile(header, WAV_HEADER_BYTES + dataBytes)).toBe(true);
    // Truncated / mismatched total is rejected.
    expect(isValidWavFile(header, WAV_HEADER_BYTES + dataBytes - 1)).toBe(
      false,
    );
    expect(isValidWavFile(header, dataBytes)).toBe(false);
  });

  it('computes duration from PCM byte count', () => {
    // 16 kHz mono 16-bit => 32000 bytes/sec.
    expect(pcmDurationMs(32_000, FORMAT)).toBe(1_000);
    expect(pcmDurationMs(16_000, FORMAT)).toBe(500);
    expect(pcmDurationMs(0, FORMAT)).toBe(0);
  });
});
