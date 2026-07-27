/**
 * Bundle budgets, enforced by `pnpm --filter @bad-crm/client build` (the script runs `size-limit`
 * after `vite build`, so a regression fails the build rather than a dashboard).
 *
 * The numbers come from `docs/architecture/ux-architecture.md` → «Бюджет бандла», which is the
 * source of truth: initial JS ≤ 250 KB gzip, initial CSS ≤ 60 KB gzip. (STORY-004-01 quotes
 * 300 KB for the initial chunk; the stricter documented figure is used until the two are
 * reconciled — a budget that is looser than the specification measures nothing.)
 *
 * The negation in the first entry is the exception the same document grants: the vault crypto
 * chunk is `libsodium-wrappers-sumo`, ~375 KB gzip of audited WebAssembly, loaded once after the
 * vault is unlocked and therefore not part of the first paint. It is measured on its own line when
 * it exists (M7, EPIC-033); the pattern matches nothing today and costs nothing.
 */
export default [
  {
    name: 'initial JS — shell and the first route',
    path: ['dist/assets/*.js', '!dist/assets/vault-crypto-*.js'],
    limit: '250 kB',
    gzip: true,
  },
  {
    name: 'initial CSS — reset, tokens and the shell',
    path: 'dist/assets/*.css',
    limit: '60 kB',
    gzip: true,
  },
];
