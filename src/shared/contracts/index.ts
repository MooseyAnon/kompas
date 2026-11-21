import type { RequestInput, ResponseEnvelope } from './envelope';

export * from './errors';
export * from './envelope';
export * from './system';
export * from './telemetry';
export * from './identity';
export * from './experience-dates';
export * from './documents';
export * from './applications';
export * from './job-discovery';
export * from './cv-imports';
export * from './interviews';
export * from './interview-insights';
export * from './inference';
export * from './tools';
export * from './audio';
export * from './web';
export * from './storage-maintenance';

/**
 * The only API surface exposed to the sandboxed renderer via contextBridge.
 * No raw ipcRenderer, Node, filesystem or SQL access is ever exposed.
 */
export interface CareerBridge {
  request<T = unknown>(input: RequestInput): Promise<ResponseEnvelope<T>>;
}

declare global {
  interface Window {
    career: CareerBridge;
  }
}
