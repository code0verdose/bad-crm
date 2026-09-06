import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';

import { appCssVariables, appTheme } from '@app/theme/app-theme.config.js';

import { colourTokens, type ColorScheme } from './token-table.util.js';

/**
 * The colours Mantine **paints**, asked of Mantine rather than deduced from a shade index.
 *
 * The difference is not pedantry, it is the defect this file exists to prevent. Which shade a
 * variable resolves to is a decision the library makes out of `primaryShade`, the scheme, and its
 * own table — `--mantine-color-<c>-outline` is the primary shade, `--mantine-color-<c>-light-color`
 * is shade 9 in the light scheme and shade 0 in the dark one, and the dark `--mantine-color-<c>-light`
 * is not a shade at all but shade 9 darkened by half. A test that writes `scale[9]` states a belief
 * about that table; a test that reads the table states the fact. On 2026-09-06 a belief and the
 * fact disagreed, an outline control on a tinted panel shipped at 4.02:1, and no assertion in this
 * package could see it because none of them was asking the library anything.
 *
 * Nor is the package's `styles.css` an answer: it carries the *default* theme's values, which are a
 * different palette and a different `primaryShade` from the ones this product ships.
 *
 * The two resolvers are combined exactly as `MantineProvider` combines them — the default first,
 * the application's `cssVariablesResolver` over it (`getMergedVariables`, a `deepMerge`) — so a
 * remap declared in `app-theme.config.ts` is measured here as the browser would see it.
 */
const theme: MantineTheme = mergeMantineTheme(DEFAULT_THEME, appTheme);

const defaults = defaultCssVariablesResolver(theme);
const overrides = appCssVariables(theme);

const variableTable = (scheme: ColorScheme): Map<string, string> =>
  new Map(
    Object.entries({
      ...defaults.variables,
      ...defaults[scheme],
      ...overrides.variables,
      ...overrides[scheme],
    }),
  );

const VAR_REFERENCE = /^var\((--[\w-]+)\)$/;
const RGB_FUNCTION = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/;

/** `rgba(81, 17, 17, 1)` → `#511111`. Mantine's `darken()` returns this form, and only this form. */
const toHex = (value: string): string => {
  const channels = RGB_FUNCTION.exec(value);

  return channels === null
    ? value
    : `#${channels
        .slice(1, 4)
        .map((channel) => Number(channel).toString(16).padStart(2, '0'))
        .join('')}`;
};

/**
 * Follows one CSS variable to the opaque colour a browser would end up with.
 *
 * Chains are short by construction — `-text` → `-filled` → `-6` is the longest Mantine builds — but
 * they cross two tables: a Mantine variable may point at a `--bc-*` token of ours (the `dimmed`
 * remap does), and a `--bc-*` token always points back at a Mantine variable.
 */
export const paintedColor = (scheme: ColorScheme, variable: string): string => {
  const mantine = variableTable(scheme);
  const tokens = colourTokens(scheme);
  let current = `var(${variable})`;

  for (let step = 0; step < 8; step += 1) {
    const reference = VAR_REFERENCE.exec(current)?.[1];

    if (reference === undefined) return toHex(current);

    const next = reference.startsWith('--bc-')
      ? tokens.get(reference)
      : (mantine.get(reference) ?? tokens.get(reference));

    if (next === undefined) {
      throw new Error(`${scheme}: nothing declares ${reference}`);
    }

    current = next.trim();
  }

  throw new Error(`${scheme}: ${variable} does not resolve to a colour`);
};
