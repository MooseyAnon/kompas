import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { RequestInput } from '../shared/contracts';

const REQUEST_CHANNEL = 'career:request';
const DROP_CHANNEL = 'career:dropped';

/**
 * The single, narrow API exposed to the sandboxed renderer. No raw ipcRenderer,
 * Node, filesystem, process or SQL access is exposed. The requestId (a UUID
 * correlation id) is generated here so the renderer cannot spoof it.
 */
const careerBridge = {
  request: (input: RequestInput) => {
    const envelope = {
      requestId: globalThis.crypto.randomUUID(),
      module: String(input?.module ?? ''),
      version: Number(input?.version),
      action: String(input?.action ?? ''),
      payload: input?.payload ?? {},
    };
    return ipcRenderer.invoke(REQUEST_CHANNEL, envelope);
  },
};

contextBridge.exposeInMainWorld('career', careerBridge);

/**
 * A file dropped on the window: its path goes straight to the main process,
 * never to the page. Only real dropped files have a path, so the page cannot
 * name an arbitrary file; the import that follows applies the usual checks.
 */
window.addEventListener(
  'drop',
  (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const filePath = webUtils.getPathForFile(file);
    if (filePath) ipcRenderer.send(DROP_CHANNEL, filePath);
  },
  true,
);
