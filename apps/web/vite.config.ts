import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Fontsource lists a `.woff` fallback after each `.woff2` source. Every browser the app supports
 * reads woff2, so the fallbacks would only add ~250 unused files (the Korean serif is sliced into
 * 120 unicode-range chunks per weight) to the bundle and to the packaged binary (DIG-82). */
export function fontsourceWoff2Only(): Plugin {
  return {
    name: 'digestit:fontsource-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@fontsource(-variable)?[\\/].+\.css$/.test(id)) return null;
      return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, ''), map: null };
    },
  };
}

// The API server serves this bundle (apps/server DEFAULT_WEB_DIR = apps/web/dist).
export default defineConfig({
  plugins: [react(), fontsourceWoff2Only()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { '/api': 'http://127.0.0.1:4780' } },
  test: { environment: 'node' },
});
