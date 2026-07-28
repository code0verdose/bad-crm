import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_THEME } from '@mantine/core';

import { BRAND_COLORS } from '@app/theme/app-theme.config.js';

/**
 * Reads `app/styles/tokens.css` as data, so every assertion is made about the stylesheet that
 * actually ships rather than about a TypeScript copy of it that could drift from it silently.
 *
 * The two schemes live in `@mixin light-root` / `@mixin dark-root` rather than in `light-dark()`:
 * `postcss-preset-mantine` documents that `light-dark()` «does not work on `:root`/`html` element»,
 * because it compiles to a descendant selector — on `:root` the dark half would compile to
 * `[data-mantine-color-scheme='dark'] :root`, which matches nothing, and the dark theme would be
 * silently missing while every test that renders a component still passed.
 */
const TOKENS_CSS = resolve(process.cwd(), 'src/app/styles/tokens.css');

/** `--bc-name: value;` — every declaration, whatever its shape and wherever it sits. */
const ANY_TOKEN = /(--bc-[\w-]+):\s*([^;]+);/g;

/** The body of `@mixin light-root { … }` / `@mixin dark-root { … }`, non-greedy to the first `}`. */
const rootMixin = (scheme: 'light' | 'dark'): RegExp =>
  new RegExp(String.raw`@mixin ${scheme}-root\s*\{([^}]*)\}`);

export type ColorScheme = 'light' | 'dark';

export const tokensCss = (): string => readFileSync(TOKENS_CSS, 'utf8');

/**
 * Every `--bc-*` declared anywhere in the stylesheet, mapped to its **first** declaration.
 *
 * First, not last: the reduced-motion block re-declares the durations as `0ms`, and a map built
 * last-wins would report the override as the token's value and pass an assertion about the wrong
 * declaration.
 */
export const declaredTokens = (): Map<string, string> => {
  const tokens = new Map<string, string>();

  for (const [, name, value] of tokensCss().matchAll(ANY_TOKEN)) {
    if (!tokens.has(name as string)) tokens.set(name as string, (value as string).trim());
  }

  return tokens;
};

/** The `--bc-*` declarations of one scheme block, raw. */
export const schemeTokens = (scheme: ColorScheme): Map<string, string> => {
  const block = rootMixin(scheme).exec(tokensCss())?.[1] ?? '';

  return new Map(
    [...block.matchAll(ANY_TOKEN)].map(([, name, value]) => [
      name as string,
      (value as string).trim(),
    ]),
  );
};

/**
 * Resolves a Mantine colour variable to the hex the theme gives it.
 *
 * `--mantine-color-white` and `--mantine-color-black` are single values; everything else is
 * `<palette>-<shade>`. `brand` comes from this project's theme, the rest from Mantine's default,
 * which is the object `MantineProvider` merges the override into.
 */
export const resolveMantineColor = (variable: string): string => {
  const name = variable.replace('--mantine-color-', '');

  if (name === 'white') return DEFAULT_THEME.white;
  if (name === 'black') return DEFAULT_THEME.black;

  const shade = Number(name.slice(name.lastIndexOf('-') + 1));
  const palette = name.slice(0, name.lastIndexOf('-'));
  const tuple =
    palette === 'brand'
      ? BRAND_COLORS
      : DEFAULT_THEME.colors[palette as keyof typeof DEFAULT_THEME.colors];

  const value = tuple?.[shade];

  if (value === undefined) {
    throw new Error(`unknown Mantine colour variable: ${variable}`);
  }

  return value;
};

/** `var(--mantine-color-gray-9)` → `#212529`; anything else is returned unchanged. */
export const resolveTokenValue = (value: string): string => {
  const variable = /^var\((--mantine-color-[\w-]+)\)$/.exec(value)?.[1];

  return variable === undefined ? value : resolveMantineColor(variable);
};

/** The colour tokens of one scheme, resolved to hex. */
export const colourTokens = (scheme: ColorScheme): Map<string, string> =>
  new Map(
    [...schemeTokens(scheme)]
      .filter(([, value]) => value.startsWith('var(--mantine-color-'))
      .map(([name, value]) => [name, resolveTokenValue(value)]),
  );
