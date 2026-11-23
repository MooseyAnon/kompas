// Stand-in for the Electron preload bridge: same `window.career.request`
// shape, forwarded to the preview back end. Must be installed before the app
// makes its first request.
import type { RequestInput } from '../../src/shared/contracts';

Object.defineProperty(window, 'career', {
  value: {
    request: async (input: RequestInput) => {
      const response = await fetch('/__career/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          module: input.module,
          version: input.version,
          action: input.action,
          payload: input.payload ?? {},
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
  },
});

await import('../../src/renderer/main');

export {};
