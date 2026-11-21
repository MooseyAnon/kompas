import fs from 'node:fs';
import path from 'node:path';

/**
 * Parsed subset of `resources/whisper/manifest.json` (written by
 * `scripts/provision-whisper.mjs`). The manifest pins the exact upstream
 * revision, measured bytes and SHA-256 of the bundled executable and model, so
 * the adapter can report a truthful, verifiable installed state and the
 * packaged-asset gate can confirm the physical bytes match.
 */
export interface WhisperManifest {
  engine: {
    id: string;
    tag: string;
    commit: string;
    executable: string;
    executableSha256: string;
    executableBytes: number;
    runtime: string;
  };
  model: {
    id: string;
    file: string;
    variant: string;
    multilingual: boolean;
    sha256: string;
    bytes: number;
  };
}

export interface WhisperAssets {
  /** Root of the bundled whisper resources (dev tree or packaged Resources). */
  rootDir: string;
  binaryPath: string;
  modelPath: string;
  manifestPath: string;
  manifest: WhisperManifest | null;
}

/**
 * Resolve the location of the bundled whisper assets from the resources root.
 * In the packaged app this is `<process.resourcesPath>/whisper`; in development
 * and tests it is `<repo>/resources/whisper`. No path is ever taken from the
 * renderer, and resolution never depends on the current working directory.
 */
export function resolveWhisperAssets(rootDir: string): WhisperAssets {
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = readManifest(manifestPath);
  // Prefer manifest-declared relative locations; fall back to conventions.
  const executableRel = manifest?.engine.executable ?? 'bin/whisper-cli';
  const modelRel = manifest?.model.file ?? 'models/ggml-base.bin';
  return {
    rootDir,
    binaryPath: path.join(rootDir, executableRel),
    modelPath: path.join(rootDir, modelRel),
    manifestPath,
    manifest,
  };
}

function readManifest(manifestPath: string): WhisperManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as WhisperManifest;
    if (
      parsed?.engine?.executable &&
      parsed?.model?.file &&
      typeof parsed.model.bytes === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
