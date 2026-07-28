import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The one half of `rules/design-system.mdc` §3 that Stylelint cannot see: at-rule *preludes*.
 *
 * This file used to be `tokens-only.test.ts`, and it re-implemented the whole rule — no hex, no
 * colour function, no magic pixel — with three regular expressions over every stylesheet, plus its
 * own copy of the "except `tokens.css` and `global.css`" exemption. That was the right call while
 * there was no Stylelint. There is one now (`stylelint.config.js`, run by `pnpm stylelint` inside
 * `turbo run lint` and in CI), it enforces the same three claims with a real CSS parser, and it
 * carries the exemption in `TOKEN_DECLARATION_FILES`. Two lists of exempt paths and two encodings
 * of the same rule do not stay equal; they stay equal until the first one is edited alone. So the
 * duplicated part is deleted rather than re-derived from the config — a check that merely restates
 * a linter adds a way to be wrong and no way to be safe.
 *
 * What is left is the residue, and it is real. Measured against the shipped config, every rule it
 * uses is bound to a declaration or to `@media`: `declaration-property-value-disallowed-list` sees
 * declarations, `media-feature-name-value-allowed-list` sees media features. Nothing looks at the
 * text between an at-rule's name and its block, so all of these lint clean today:
 *
 * - `@mixin smaller-than 700px` — the preset helper, taking a hard-coded breakpoint;
 * - `@container (min-width: 700px)` — a container query, which is not `@media`;
 * - `@supports (padding: 13px)` / `@supports (color: #1971c2)` — a literal inside a feature query;
 * - `@custom-media --narrow (max-width: 700px)` — the breakpoint given a name and a magic value.
 *
 * Each is a measured value where a token belongs, and each is invisible to the linter, so it is
 * asserted here by reading the stylesheets. The exemption list does not come back with it: a
 * prelude declares no token, so `tokens.css` and `global.css` have nothing to be exempt from — they
 * are checked like every other file.
 */

const SRC = resolve(process.cwd(), 'src');

/**
 * Everything between an at-rule's name and its block or its semicolon.
 *
 * `[^;{]*` stops at the first `{` or `;`, which is exactly the prelude: `@media (width <= 40em)`
 * yields ` (width <= 40em)` and the declarations inside the block are left to Stylelint.
 */
const AT_RULE_PRELUDE = /@[\w-]+([^;{]*)/g;

/**
 * The literal notations, each with a prelude that contains it.
 *
 * The sample is not decoration: it is asserted to match, so a pattern broken by an edit fails here
 * instead of silently finding nothing in a directory of clean stylesheets.
 */
const LITERALS: readonly (readonly [name: string, pattern: RegExp, sample: string])[] = [
  ['a literal colour', /#[\da-f]{3,8}\b/i, '@supports (color: #1971c2)'],
  ['a colour function', /(?<![\w-])(?:rgba?|hsla?|color-mix)\(/i, '@supports (color: rgb(0 0 0))'],
  // `px`, `em` and `rem` are the three a breakpoint is written in. `2dppx` is not matched — the
  // digits are not adjacent to the unit — and `$mantine-breakpoint-sm`, the form the rule asks for,
  // carries no number at all.
  ['a measured length', /(?<![\w.-])-?\d*\.?\d+(?:px|r?em)\b/i, '@mixin smaller-than 700px'],
];

const cssFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return cssFiles(path);

    return path.endsWith('.css') ? [path] : [];
  });

/** Comments explain *why* a token was chosen and legitimately name the value it replaced. */
const withoutComments = (source: string): string => source.replaceAll(/\/\*[\s\S]*?\*\//g, '');

const preludes = (source: string): string[] =>
  // `?? ''` is the type checker's due, not a case: the group is not optional, so a match always
  // carries it — an at-rule with an empty prelude yields `''` either way.
  [...withoutComments(source).matchAll(AT_RULE_PRELUDE)].map((match) => match[1] ?? '');

const stylesheets = (): { path: string; source: string }[] =>
  cssFiles(SRC).map((path) => ({
    path: path.slice(SRC.length + 1),
    source: readFileSync(path, 'utf8'),
  }));

describe('the prelude of an at-rule names a token, never a value', () => {
  it('reads the stylesheets, so an empty walk cannot pass this file', () => {
    expect(stylesheets().length).toBeGreaterThan(0);
  });

  it('takes the text between the at-rule name and its block', () => {
    expect(
      preludes('@media (width <= 40em) {\n  .a { gap: 0; }\n}\n@mixin dark-root {\n}'),
    ).toEqual([' (width <= 40em) ', ' dark-root ']);
  });

  it.each(LITERALS)(
    'recognises %s, so a clean run means the check ran',
    (_name, pattern, sample) => {
      expect(
        preludes(`${sample} { .a { gap: 0; } }`).filter((prelude) => pattern.test(prelude)),
      ).toHaveLength(1);
    },
  );

  it.each(LITERALS)('finds no %s in any at-rule', (_name, pattern) => {
    const offenders = stylesheets().flatMap(({ path, source }) =>
      preludes(source)
        .filter((prelude) => pattern.test(prelude))
        .map((prelude) => `${path}: @…${prelude.trim()}`),
    );

    expect(offenders).toEqual([]);
  });
});
