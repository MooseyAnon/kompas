import type { IpcMainInvokeEvent } from 'electron';

/** Minimal, Electron-free description of an IPC sender for testable checks. */
export interface SenderInfo {
  /** webContents id of the sender. */
  senderId: number;

  /** True only when the sending frame is the window's top (main) frame. */
  isMainFrame: boolean;

  /** URL of the sending frame, if available. */
  frameUrl: string | undefined;
}

export interface SenderPolicy {
  /** webContents id of the trusted application window. */
  expectedWebContentsId: number;

  /** Allowed URL prefixes for the app origin (dev server URL and/or file://). */
  allowedUrlPrefixes: string[];
}

/**
 * Fail-closed authorisation for privileged IPC. The sender must be our window's
 * webContents, its top frame, and served from an allowed app origin. Sub-frames
 * (e.g. an injected iframe) and any other webContents are rejected.
 */
export function isAuthorisedSender(
  info: SenderInfo,
  policy: SenderPolicy,
): boolean {
  if (info.senderId !== policy.expectedWebContentsId) {
    return false;
  }

  if (!info.isMainFrame) {
    return false;
  }

  const frameUrl = info.frameUrl;

  if (!frameUrl) {
    return false;
  }

  return policy.allowedUrlPrefixes.some((prefix) =>
    frameUrl.startsWith(prefix),
  );
}

export function senderInfoFromEvent(
  event: IpcMainInvokeEvent,
  expectedMainFrameId: number | undefined,
): SenderInfo {
  const frame = event.senderFrame ?? undefined;

  return {
    senderId: event.sender.id,
    isMainFrame:
      frame !== undefined &&
      expectedMainFrameId !== undefined &&
      frame.frameTreeNodeId === expectedMainFrameId,
    frameUrl: frame?.url,
  };
}
