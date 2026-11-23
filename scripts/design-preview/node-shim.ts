// Main-process code is bundled as CommonJS for Electron; the one module that
// uses `__filename` (for createRequire) needs it when Vite loads it as ESM.
// Imported first by backend.ts so it runs before the main-process modules.
import path from 'node:path';

const globals = globalThis as { __filename?: string };
globals.__filename ??= path.resolve(
  import.meta.dirname,
  '../../src/main/modules/web/adapters/playwright/playwright-engine.ts',
);
