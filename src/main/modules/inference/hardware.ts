import fs from 'node:fs';
import os from 'node:os';
import type { Acceleration, HardwareProfile } from '../../../shared/contracts';

const MAX_OS_RELEASE_CHARS = 64;

function probeFreeDiskBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    const free = Math.floor(stats.bavail * stats.bsize);

    return free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/**
 * Collect a safe, advisory local hardware snapshot from standard OS APIs.
 * Deliberately excludes any machine identifiers (hostname, username, serial,
 * MAC address, process list). Unknown GPU/VRAM information stays `null`; a
 * snapshot is advisory and is not a capability certificate.
 */
export function collectHardwareProfile(probeDir?: string): HardwareProfile {
  const platform = process.platform;
  const architecture = process.arch;
  const cpus = os.cpus();
  const cpuLogicalCount =
    Array.isArray(cpus) && cpus.length > 0 ? cpus.length : 1;

  const isAppleSilicon = platform === 'darwin' && architecture === 'arm64';
  const acceleration: Acceleration = isAppleSilicon ? 'metal' : 'unknown';

  const notes: string[] = [];
  if (isAppleSilicon) {
    notes.push('Apple Silicon: unified memory shared between CPU and GPU.');
  }

  return {
    platform,
    architecture,
    cpuLogicalCount,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    freeDiskBytes: probeFreeDiskBytes(probeDir ?? os.tmpdir()),
    capturedAt: new Date().toISOString(),
    osRelease: os.release().slice(0, MAX_OS_RELEASE_CHARS),
    gpuName: null,
    gpuMemoryBytes: null,
    acceleration,
    notes,
  };
}
