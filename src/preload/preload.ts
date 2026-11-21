import { contextBridge, ipcRenderer } from 'electron';
import type { RequestInput } from '../shared/contracts';

const REQUEST_CHANNEL = 'career:request';

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
