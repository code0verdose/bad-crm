import { fileURLToPath } from 'node:url';

import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { FSD_ALIASES } from './src/shared/config/fsd-aliases.constant.js';

/**
 * Where `pnpm dev` serves the SPA — the port the quickstart in `README.md` and the acceptance of
 * STORY-001-06 name, which is why it is pinned rather than left to Vite's default.
 */
const DEV_PORT = 5173;

/** The API of the same installation, during development. `PORT` in `.env.example`. */
const DEV_API_TARGET = 'http://localhost:3000';

/**
 * The one prefix the browser sends to the API. It matches the default of `VITE_API_BASE_URL`, so
 * development and production differ in who terminates the request, not in what the client asks for.
 */
const API_PREFIX = '/api';

/**
 * Alias table for the bundler, derived from the same object `tsconfig.json` is checked against.
 *
 * Order matters: Vite matches array entries in sequence and `find` is a prefix match, so the
 * longest alias has to come first — otherwise `@app/routes` is rewritten by the `@/*` entry.
 * The `/*` suffix is dropped: with a prefix match, `@shared` already covers `@shared/api`.
 */
const alias = Object.entries(FSD_ALIASES)
  .map(([from, target]) => ({
    find: from.replace(/\/\*$/, ''),
    replacement: fileURLToPath(new URL(target.replace(/\/\*$/, ''), import.meta.url)),
  }))
  .sort((left, right) => right.find.length - left.find.length);

export default defineConfig({
  plugins: [
    /**
     * Generates `src/app/route-tree.gen.ts` from the files in `src/app/routes/**`, and splits every
     * route into its own chunk.
     *
     * It runs **before** the React plugin, as its documentation requires: the generator rewrites
     * route modules, and a transform that has already turned JSX into `jsx()` calls is one it can
     * no longer read.
     *
     * `autoCodeSplitting` is what keeps the initial bundle inside the budget of
     * `ux-architecture.md` → «Бюджет бандла» without a single manual `lazy()`: the component and
     * loader of a route leave the first chunk, while its path, guard and search schema stay — they
     * are what the router needs to decide where to go before anything is downloaded.
     */
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/app/routes',
      generatedRouteTree: './src/app/route-tree.gen.ts',
      autoCodeSplitting: true,
      quoteStyle: 'single',
      semicolons: true,
    }),
    react(),
  ],
  resolve: { alias },
  server: {
    port: DEV_PORT,
    // Fail instead of silently moving to 5174: the port is part of the documented quickstart, and
    // a client answering on an unexpected port reads as "the dev server is broken".
    strictPort: true,
    proxy: {
      // Same-origin in the browser, so the development session cookie is a first-party cookie
      // exactly as it is in production — no CORS exception and no `SameSite=None` anywhere.
      [API_PREFIX]: { target: DEV_API_TARGET, changeOrigin: false },
    },
  },
  preview: { port: DEV_PORT, strictPort: true },
  build: {
    // Baseline-widely-available browsers, the same floor Vite 8 defaults to. Named explicitly
    // because the vault crypto module is WebAssembly (ADR-0009/ADR-0023) and this is the line that
    // decides whether a browser too old to run it gets a broken page or a refused bundle.
    target: 'baseline-widely-available',
    // Production sourcemaps: the client reports errors to `POST /api/v1/telemetry/client-error`
    // (docs/architecture/stack.md), and a stack trace over minified names is not a report.
    sourcemap: true,
  },
});
