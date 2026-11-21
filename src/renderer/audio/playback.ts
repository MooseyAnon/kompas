import {
  audioPlaybackClose,
  audioPlaybackOpen,
  audioPlaybackRead,
} from '../api';
import { base64ToBytes } from './capture';

/**
 * Assemble a stored recording into a Blob by streaming bounded byte frames over
 * the scoped playback IPC. The renderer only ever holds opaque ids and a
 * short-lived token; it never learns a filesystem path, and the handle is
 * always revoked on completion.
 */
export async function fetchRecordingBlob(id: string): Promise<Blob> {
  const open = await audioPlaybackOpen(id);
  const parts: Uint8Array[] = [];
  try {
    let offset = 0;
    while (offset < open.sizeBytes) {
      const length = Math.min(open.maxReadBytes, open.sizeBytes - offset);
      const frame = await audioPlaybackRead(id, open.token, offset, length);
      if (frame.bytesRead <= 0) {
        break;
      }
      parts.push(base64ToBytes(frame.chunk));
      offset += frame.bytesRead;
      if (frame.eof) {
        break;
      }
    }
  } finally {
    await audioPlaybackClose(id, open.token).catch(() => {});
  }
  return new Blob(parts as BlobPart[], { type: open.mediaType });
}
