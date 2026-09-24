import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API server serves this bundle (apps/server DEFAULT_WEB_DIR = apps/web/dist).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { '/api': 'http://127.0.0.1:4780' } },
  test: { environment: 'node' },
});
