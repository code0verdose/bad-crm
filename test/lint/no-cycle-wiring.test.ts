import { describe, expect, it } from 'vitest';

import eslintConfig from '../../eslint.config.js';

/**
 * The three settings `import/no-cycle` needs before it reports anything at all.
 *
 * This is not a style preference expressed as a test. It is the record of a measurement: the rule
 * was switched on, a deliberate two-file cycle was added to `packages/client/src/shared/lib`, and
 * `pnpm lint` stayed **green**. Twice — once for each missing piece.
 *
 * 1. Without `import/resolver.typescript`, every specifier in this package is unresolvable to the
 *    plugin: internal imports are either `@`-aliased (`@units/auth`) or carry the `.js` suffix that
 *    TypeScript ESM requires for a `.ts` file, and the default node resolver follows neither.
 * 2. With the resolver but without `import/parsers`, resolution succeeds and the rule still says
 *    nothing: to find the edge *back*, `no-cycle` has to parse each module it follows, and it picks
 *    the parser by file extension from that map. Unparseable dependency, graph one level deep, no
 *    cycle — and `import/no-unresolved` keeps passing the whole time, which is what makes the gap
 *    so quiet.
 * 3. The resolver's `project` is absolute, because `pnpm lint` runs ESLint from two different
 *    working directories — the repository root for `//#lint:repo` and the package directory for
 *    `@bad-crm/client#lint`. A relative path resolves in one and fails in the other, and a resolver
 *    that cannot find its project reports no cycles rather than an error.
 *
 * A fixture under `test/lint/fixtures` cannot cover this: the resolver is pinned to the real
 * `packages/client/tsconfig.json`, which does not include the fixture tree, so the fixture pair
 * lints clean no matter how the rule is configured. Asserting the wiring is the honest substitute —
 * it fails on exactly the three edits that were measured to disable the rule in silence.
 */

interface ConfigBlock {
  readonly files?: readonly string[];
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly settings?: Readonly<Record<string, unknown>>;
}

const CLIENT_SOURCE_GLOB = 'packages/client/src/**/*.{ts,tsx}';

const clientBlock = (eslintConfig as readonly ConfigBlock[]).find(
  (block) =>
    block.files?.includes(CLIENT_SOURCE_GLOB) === true && block.rules?.['import/no-cycle'] != null,
);

describe('import/no-cycle wiring', () => {
  it('is enabled on the client source, which is where the barrels are', () => {
    expect(
      clientBlock,
      `no block matching ${CLIENT_SOURCE_GLOB} enables import/no-cycle`,
    ).toBeDefined();
    expect(clientBlock?.rules?.['import/no-cycle']).not.toBe('off');
  });

  it('carries the resolver without which the rule reports nothing', () => {
    const resolver = clientBlock?.settings?.['import/resolver'] as
      { typescript?: { project?: string } } | undefined;

    expect(
      resolver?.typescript?.project,
      'import/resolver.typescript is gone — every specifier becomes unresolvable and no-cycle ' +
        'goes quiet while lint stays green',
    ).toBeTypeOf('string');
  });

  it('points the resolver at an absolute project, since lint runs from two directories', () => {
    const resolver = clientBlock?.settings?.['import/resolver'] as {
      typescript?: { project?: string };
    };

    expect(
      resolver.typescript?.project?.startsWith('/'),
      'a repository-relative project resolves from the root and fails from inside the package',
    ).toBe(true);
  });

  it('carries the parser map without which the graph stops one level deep', () => {
    const parsers = clientBlock?.settings?.['import/parsers'] as
      Readonly<Record<string, readonly string[]>> | undefined;

    expect(
      parsers?.['@typescript-eslint/parser'],
      'import/parsers is gone — dependencies cannot be parsed, so the edge back is never found',
    ).toEqual(expect.arrayContaining(['.ts', '.tsx']));
  });
});
