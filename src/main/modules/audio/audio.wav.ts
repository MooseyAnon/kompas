/**
 * Minimal, dependency-free RIFF/WAVE helpers for the canonical Stage 008.1
 * recording format: signed 16-bit little-endian PCM, mono, 16 kHz. We only ever
 * produce and read this one format, so the parser is deliberately strict — any
 * deviation (wrong magic, truncated header, mismatched sizes) is rejected so a
 * corrupt or partial file is never served as a valid recording.
 */

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Fixed size of a canonical PCM WAV header (no extra chunks). */
export const WAV_HEADER_BYTES = 44;

/**
 * Build the 44-byte canonical PCM WAV header for a payload of `dataBytes` PCM
 * samples. The data itself is appended by the caller (streamed, never buffered
 * whole) so memory stays bounded for long recordings.
 */
export function buildWavHeader(dataBytes: number, format: WavFormat): Buffer {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4); // RIFF chunk size
  header.write('WAVE', 8, 'ascii');

  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  return header;
}

export interface ParsedWav extends WavFormat {
  /** Byte count declared by the `data` chunk. */
  dataBytes: number;
}

/**
 * Parse and validate a canonical PCM WAV header from the leading bytes of a
 * file. Returns the format and declared data length, or `undefined` if the
 * header is not the expected PCM/WAVE shape.
 */
export function parseWavHeader(header: Buffer): ParsedWav | undefined {
  if (header.length < WAV_HEADER_BYTES) {
    return undefined;
  }
  if (
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE' ||
    header.toString('ascii', 12, 16) !== 'fmt ' ||
    header.toString('ascii', 36, 40) !== 'data'
  ) {
    return undefined;
  }
  const audioFormat = header.readUInt16LE(20);
  if (audioFormat !== 1) {
    return undefined;
  }
  return {
    channels: header.readUInt16LE(22),
    sampleRate: header.readUInt32LE(24),
    bitsPerSample: header.readUInt16LE(34),
    dataBytes: header.readUInt32LE(40),
  };
}

/**
 * Confirm the leading bytes are a canonical PCM WAV header whose declared data
 * length is consistent with the file's total size. Used before serving a file
 * for playback so truncated/corrupt assets are detected.
 */
export function isValidWavFile(
  header: Buffer,
  totalFileBytes: number,
): boolean {
  const parsed = parseWavHeader(header);
  if (!parsed) {
    return false;
  }
  if (parsed.dataBytes < 0) {
    return false;
  }
  return parsed.dataBytes + WAV_HEADER_BYTES === totalFileBytes;
}

/** Milliseconds of audio represented by `pcmBytes` of PCM samples. */
export function pcmDurationMs(pcmBytes: number, format: WavFormat): number {
  const bytesPerMs =
    (format.sampleRate * format.channels * (format.bitsPerSample / 8)) / 1000;
  if (bytesPerMs <= 0) {
    return 0;
  }
  return Math.floor(pcmBytes / bytesPerMs);
}
