/**
 * The FSD layer aliases, in the shape `tsconfig.json` writes them: alias → package-relative target.
 *
 * One definition, three consumers. `tsconfig.json` needs them for `tsc`, `vite.config.ts` for the
 * bundler and `vitest.config.ts` for the test runner, and an alias that resolves in two of the
 * three is worse than no alias at all: the build stays green while the editor is red, or the other
 * way round. `test/repo/client-aliases.test.ts` asserts the compiler configuration and the Vite
 * configuration both against this object, so a divergence fails a test rather than a workday.
 *
 * It lives under `src/` rather than in a `config/` directory of its own because everything that
 * already guards this package is anchored there: the ESLint globs, the `packages/{pkg}/src` inputs
 * of `//#test:repo`, and the coverage `include`. A build-time constant outside that tree would be
 * linted by nothing and hashed by nothing.
 *
 * Targets are written exactly as `tsconfig` needs them, prefix aliases included; `vite.config.ts`
 * resolves them to absolute paths at load time.
 */
export const FSD_ALIASES = {
  '@app': './src/app',
  '@app/*': './src/app/*',
  '@pages': './src/pages',
  '@pages/*': './src/pages/*',
  '@widgets/*': './src/widgets/*',
  '@units/*': './src/units/*',
  '@shared': './src/shared',
  '@shared/*': './src/shared/*',
  // No catch-all `@/*` on purpose. It existed, and it was a second spelling for every path the
  // layer aliases restrict: `@/units/session/service/hooks/...` reached straight into another
  // unit's internals while ESLint stayed silent and every architecture test stayed green, because
  // every guard matches the literal `@units/`. («All twenty» stood here until 2026-08-30; no count
  // of architecture tests matches it — at `ade50a3`, which wrote the sentence, there were seven
  // files and fifty-five cases, and there are more of both now. `ls test/architecture/*.test.ts
  // packages/client/test/architecture/*.test.ts` is the honest answer.) A catch-all next to layer
  // aliases has no
  // use except to route around them.
} as const satisfies Record<string, string>;

export type FsdAlias = keyof typeof FSD_ALIASES;
