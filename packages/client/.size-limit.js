/**
 * Bundle budgets, enforced by `pnpm --filter @bad-crm/client build` (the script runs `size-limit`
 * after `vite build`, so a regression fails the build rather than a dashboard).
 *
 * The numbers come from `docs/architecture/ux-architecture.md` → «Бюджет бандла», which is the
 * source of truth: initial JS ≤ 250 KB gzip, initial CSS ≤ 60 KB gzip. (STORY-004-01 quotes
 * 300 KB for the initial chunk; the stricter documented figure is used until the two are
 * reconciled — a budget that is looser than the specification measures nothing.)
 *
 * Since STORY-004-05 the routes are code-split by `@tanstack/router-plugin`, so «initial» is no
 * longer «everything in `dist/assets`». Measuring the whole directory would let a route chunk grow
 * unnoticed inside the entry budget and, worse, would report a regression on a screen that is never
 * loaded on first paint. Each line below therefore measures what one navigation actually downloads:
 *
 * - the entry and the vendor chunk it preloads — what the browser fetches before anything renders;
 * - the authenticated shell — fetched when a signed-in user lands anywhere behind the guard;
 * - each route's own chunk — the component and loader of one screen.
 *
 * The negation in the first entry is the exception the same document grants: the vault crypto chunk
 * is `libsodium-wrappers-sumo`, ~375 KB gzip of audited WebAssembly, loaded once after the vault is
 * unlocked and therefore not part of the first paint. It is measured on its own line when it exists
 * (M7, EPIC-033); the pattern matches nothing today and costs nothing.
 */
export default [
  {
    /**
     * Everything except the route chunks — the entry, the runtime and whatever shared chunks the
     * bundler decided to split out and preload.
     *
     * Written as exclusions rather than as a list of chunk names on purpose: the names of shared
     * chunks are not stable. Two consecutive builds of this very commit produced `shared-*.js` and
     * then `breadcrumbs-*.js` for the same 70 KB of vendor code, because the name is taken from one
     * arbitrary member of the group. A budget listing chunk names would have silently measured
     * nothing at all after such a rename — the glob matches no file, and `size-limit` reports 0 B.
     * Route chunk names *are* stable: they come from the route file.
     */
    name: 'initial JS — everything the first paint pulls',
    path: [
      'dist/assets/*.js',
      '!dist/assets/_authenticated-*.js',
      '!dist/assets/dashboard-*.js',
      '!dist/assets/login-*.js',
      // The splat route, `routes/_authenticated/$.tsx`. Rollup sanitises `$` to `_`, so the chunk
      // is `_-<hash>.js` — a name close enough to `_authenticated-*` to be missed by eye, which is
      // how it spent a delivery inside the initial budget it is not part of. It is downloaded only
      // by a URL that matches nothing, so measuring it here would count a screen no first paint
      // reaches; the `-` after the underscore is what keeps this pattern off `_authenticated-*`.
      '!dist/assets/_-*.js',
      '!dist/assets/vault-crypto-*.js',
    ],
    limit: '250 kB',
    gzip: true,
  },
  {
    name: 'route chunk — the authenticated shell',
    path: 'dist/assets/_authenticated-*.js',
    limit: '60 kB',
    gzip: true,
  },
  {
    name: 'route chunk — /dashboard',
    path: 'dist/assets/dashboard-*.js',
    limit: '20 kB',
    gzip: true,
  },
  {
    name: 'route chunk — /login',
    path: 'dist/assets/login-*.js',
    limit: '20 kB',
    gzip: true,
  },
  {
    // Excluded from the entry above, so it is measured here instead of nowhere: a chunk named by
    // no line is a chunk that can grow without a budget noticing.
    name: 'route chunk — the not-found splat',
    path: 'dist/assets/_-*.js',
    limit: '20 kB',
    gzip: true,
  },
  {
    name: 'initial CSS — reset, tokens and the shell',
    path: 'dist/assets/*.css',
    limit: '60 kB',
    gzip: true,
  },
];
