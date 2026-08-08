import { readdirSync, readFileSync } from 'node:fs';

/**
 * Bundle budgets, enforced by `pnpm --filter @bad-crm/client build` (the script runs `size-limit`
 * after `vite build`, so a regression fails the build rather than a dashboard).
 *
 * The numbers come from `docs/architecture/ux-architecture.md` → «Бюджет бандла», which is the
 * source of truth: initial JS ≤ 250 KB gzip, initial CSS ≤ 60 KB gzip. (STORY-004-01 quotes
 * 300 KB for the initial chunk; the stricter documented figure is used until the two are
 * reconciled — a budget that is looser than the specification measures nothing.)
 *
 * ## What «initial» means here, and why it is read out of the HTML
 *
 * It used to be «everything in `dist/assets` except these names», with one exclusion added per
 * route as the routes appeared. That worked while there were four chunks and stopped working the
 * moment there were twelve: a chunk shared by two lazily-loaded screens counted as initial, a route
 * chunk nobody remembered to exclude counted as initial, and — worse in the other direction — an
 * exclusion could hide a chunk the first paint really does download. Both failures are silent.
 *
 * So the list is **taken from the built `index.html`**: the `<script type="module">` and every
 * `<link rel="modulepreload">`. That is, by construction, exactly what a browser fetches before
 * anything renders — no name matching, no list to keep in step with the routes, and a shared chunk
 * is counted if and only if the entry actually preloads it.
 *
 * Route chunks are then measured **individually** below, by the name Rollup takes from the route
 * file. A chunk named by no line is a chunk that can grow without a budget noticing, and
 * `ROUTE_CHUNK_BUDGET` is the answer for the ones that come and go with the screens.
 */

const DIST = 'dist';
const ASSETS = `${DIST}/assets`;

/** Every script the entry document pulls before the first render — entry plus modulepreloads. */
const initialScripts = () => {
  const html = readFileSync(`${DIST}/index.html`, 'utf8');
  const files = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map(
    (match) => `${ASSETS}/${match[1]}`,
  );

  if (files.length === 0) {
    // A silent zero is the failure mode this whole file exists to prevent: `size-limit` reports 0 B
    // for a glob that matches nothing, and the build goes green on a bundle nobody measured.
    throw new Error('.size-limit.js: dist/index.html references no scripts — did the build run?');
  }

  return files;
};

/**
 * What a single screen may weigh on its own.
 *
 * 60 kB for the authenticated shell, which carries the navigation every signed-in screen shares;
 * 40 kB for a screen. The roles matrix is the one that actually uses its allowance — three hundred
 * permissions against every role — and it is the reason the number is not 20.
 */
const ROUTE_CHUNK_BUDGET = '40 kB';
const SHELL_CHUNK_BUDGET = '60 kB';

/** Chunks the entry document does **not** preload: one screen each, measured one at a time. */
const routeChunks = () => {
  const preloaded = new Set(initialScripts());

  return readdirSync(ASSETS)
    .filter((file) => file.endsWith('.js'))
    .map((file) => `${ASSETS}/${file}`)
    .filter((file) => !preloaded.has(file))
    .map((file) => ({
      name: `route chunk — ${file.slice(ASSETS.length + 1)}`,
      path: file,
      limit: file.includes('_authenticated-') ? SHELL_CHUNK_BUDGET : ROUTE_CHUNK_BUDGET,
      gzip: true,
    }));
};

export default [
  {
    name: 'initial JS — everything the first paint pulls',
    path: initialScripts(),
    limit: '250 kB',
    gzip: true,
  },
  ...routeChunks(),
  {
    name: 'initial CSS — reset, tokens and the shell',
    path: `${ASSETS}/*.css`,
    limit: '60 kB',
    gzip: true,
  },
];
