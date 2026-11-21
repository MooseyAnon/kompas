import { defineConfig } from 'vite';

// https://vitejs.dev/config
// Inference utility-process worker build. The Forge Vite `main` target emits
// this as `.vite/build/inference-worker.cjs` (CommonJS) with `electron`
// externalised. The worker must not pull in the native SQLite driver.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
});
