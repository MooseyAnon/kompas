import { defineConfig } from 'vite';

// https://vitejs.dev/config
// Native/driver-bearing dependencies must not be bundled; they are required
// from the packaged app's node_modules at runtime (shipped inside the ASAR).
//  - better-sqlite3: native N-API driver (unpacked from ASAR by Forge).
//  - playwright-core: ships its own Node driver + launcher assets and must be
//    loaded from node_modules, not Rollup-bundled. No browser is bundled; it
//    drives an installed Chrome/Edge via launch channels.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'better-sqlite3',
        'playwright-core',
        'pdfjs-dist/legacy/build/pdf.mjs',
      ],
    },
  },
});
