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
  // unit's internals while ESLint stayed silent and all twenty architecture tests stayed green,
  // because every guard matches the literal `@units/`. A catch-all next to layer aliases has no
  // use except to route around them.
} as const satisfies Record<string, string>;

export type FsdAlias = keyof typeof FSD_ALIASES;
