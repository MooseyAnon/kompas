import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  // Forge preserves symlinks by default, which can bundle multiple React copies.
  resolve: { preserveSymlinks: false },
});
