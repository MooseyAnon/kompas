import type { MessagePortMain } from 'electron';
import { WorkerRuntime } from '../modules/inference/worker-runtime';
import type { WorkerToMainMessage } from '../../shared/contracts/inference-worker';

/**
 * Entry point for the Electron utility process that hosts provider-neutral
 * inference. It runs in a genuinely isolated process with no database, file,
 * renderer or privileged-main access. It speaks only the validated v1 transport
 * protocol over `process.parentPort`.
 */

const parentPort = (process as unknown as { parentPort: MessagePortMain })
  .parentPort;

// Dev/smoke-only seam: a `mock-fault-crash` generation triggers a real process
// exit so the supervisor's crash-recovery path can be proven end-to-end in the
// packaged app. Enabled only when the main process forks us with this flag.
const crashSeamEnabled = process.env.CAREER_INFERENCE_DEV === '1';

function send(message: WorkerToMainMessage): void {
  parentPort.postMessage(message);
}

const runtime = new WorkerRuntime({ send });

function isCrashRequest(data: unknown): boolean {
  if (!crashSeamEnabled || !data || typeof data !== 'object') {
    return false;
  }
  const message = data as { kind?: unknown; payload?: { modelId?: unknown } };
  return (
    message.kind === 'generation.start' &&
    message.payload?.modelId === 'mock-fault-crash'
  );
}

parentPort.on('message', (event: { data: unknown }) => {
  const data = event?.data;
  if (isCrashRequest(data)) {
    process.exit(1);
  }
  runtime.handle(data);
});
