/**
 * Types for the flat config, so a test may import a ban's own source of truth instead of restating
 * it. `packages/server/test/unit/architecture/layers.test.ts` reads `PRISMA_MODULE_SPECIFIERS` for
 * exactly that reason (ADR-0027, wave 3); without this file the import is an implicit `any` and the
 * suite type-checks nothing it reads from here.
 *
 * The default export is left opaque on purpose: nothing type-checks the config itself, and giving it
 * a hand-written shape would create a second description of ESLint's schema to keep in step.
 */
export declare const PRISMA_MODULE_SPECIFIERS: readonly string[];

declare const config: unknown[];
export default config;
