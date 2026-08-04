import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The landing runs beside the application during development, so it cannot take the client's
 * 5173. Pinned rather than left to Vite's "next free port": a page answering on an unexpected
 * port reads as a broken dev server.
 */
const DEV_PORT = 4321;
const PREVIEW_PORT = 4322;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) }],
  },
  css: {
    modules: {
      // Readable in devtools, hashed in production — the class name is how a reviewer finds the
      // stylesheet that produced a layout they are looking at.
      generateScopedName: '[name]__[local]__[hash:base64:5]',
    },
  },
  server: { port: DEV_PORT, strictPort: true },
  preview: { port: PREVIEW_PORT, strictPort: true },
  build: {
    // The same floor the client builds against.
    target: 'baseline-widely-available',
    sourcemap: true,
  },
});
