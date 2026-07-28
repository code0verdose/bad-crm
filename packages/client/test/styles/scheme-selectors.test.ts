import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * What the theme tokens compile *to*, as opposed to what they are written as.
 *
 * Every other check of the design system reads `tokens.css` as source: `test/theme/tokens.test.ts`
 * parses it for the token table and the contrast numbers, and `stylelint.config.js` lints it. Both
 * are blind to the one thing that decides whether any of it reaches the page — the selector the
 * scheme blocks end up under.
 *
 * That gap is not hypothetical. Written at the top level of the file, `@mixin light-root` expands
 * to a bare `&[data-mantine-color-scheme='light']`, because the mixin appends to its enclosing
 * rule and there is none. The documented form nests both mixins inside `:root`, and
 * postcss-preset-mantine says so in as many words: «light-dark function does not work on
 * :root/html element. Use light-root and dark-root mixins instead» — mixins that are shown nested.
 *
 * A stylesheet-root `&` resolves as `:scope`, and `:scope` outside a scoping context does match the
 * root element, so the bare form happens to work in a current browser. It is still one spec
 * subtlety and one build-target lowering away from a dark theme that silently never applies —
 * exactly the failure mode the token file's own header warns about — and nothing in the suite would
 * have noticed. Hence this test: it compiles through the real PostCSS configuration and asserts the
 * selector, so the question is answered by the output rather than by reading the input.
 */

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tokensCssPath = join(clientRoot, 'src/app/styles/tokens.css');

/**
 * The real configuration, not a copy of its plugin list. It is CommonJS on purpose (see its own
 * header), and `createRequire` is how an ESM test reads it — a second declaration of the plugins
 * here would compile through something other than what the build compiles through, which is the
 * one thing this file must not do.
 */
const postcssConfig = createRequire(import.meta.url)(join(clientRoot, 'postcss.config.cjs')) as {
  plugins: Record<string, Record<string, unknown>>;
};

/**
 * The selectors of every compiled rule that declares `--bc-surface`.
 *
 * Walks the PostCSS tree rather than matching braces in the output text: a regular expression over
 * compiled CSS pulls the preceding comment into the selector it reports, which turns a real failure
 * into an unreadable one.
 */
const schemeSelectorsOf = async (css: string): Promise<string[]> => {
  const load = createRequire(import.meta.url);
  const plugins = Object.entries(postcssConfig.plugins).map(([name, options]) =>
    (load(name) as (o: Record<string, unknown>) => postcss.Plugin)(options),
  );

  const result = await postcss(plugins).process(css, { from: tokensCssPath });
  const selectors: string[] = [];

  result.root.walkRules((rule) => {
    if (rule.some((node) => node.type === 'decl' && node.prop === '--bc-surface')) {
      selectors.push(rule.selector);
    }
  });

  return selectors;
};

describe('theme scheme selectors', () => {
  it('puts both scheme blocks on the root element', async () => {
    const selectors = await schemeSelectorsOf(readFileSync(tokensCssPath, 'utf8'));

    expect(selectors).toEqual([
      ":root[data-mantine-color-scheme='light']",
      ":root[data-mantine-color-scheme='dark']",
    ]);
  });

  /**
   * The positive control. Without it the assertion above passes just as well on a file that
   * declares no tokens at all — `schemeSelectorsOf` would simply return nothing to compare.
   */
  it('recognises the top-level form as the defect it is', async () => {
    const topLevel = [
      '@mixin light-root { --bc-surface: white; }',
      '@mixin dark-root { --bc-surface: black; }',
    ].join('\n');

    const selectors = await schemeSelectorsOf(topLevel);

    expect(selectors).toEqual([
      "&[data-mantine-color-scheme='light']",
      "&[data-mantine-color-scheme='dark']",
    ]);
  });
});
