import { describe, expect, it } from 'vitest';

import { contrastRatio, roundRatio } from './contrast.util.js';
import { colourTokens, declaredTokens, schemeTokens, tokensCss } from './token-table.util.js';

/**
 * The design tokens, checked as values rather than as documentation.
 *
 * `rules/design-system.mdc` §3 makes `--bc-*` the only vocabulary a stylesheet may use, and
 * `rules/a11y.mdc` §1 puts a number on every text pair in **both** themes. A token that fails the
 * number is a screen nobody can read, and it is invisible to every other check in the suite:
 * rendering succeeds, and `axe` cannot resolve a colour that a CSS variable defines in a
 * stylesheet jsdom never applies.
 */

/** Semantic aliases `ux-architecture.md` → «Дизайн-система → Токены» requires to exist. */
const REQUIRED_COLOUR_TOKENS = [
  '--bc-surface',
  '--bc-surface-raised',
  '--bc-border',
  '--bc-border-strong',
  '--bc-text',
  '--bc-text-muted',
  '--bc-danger-surface',
  '--bc-danger-text',
  '--bc-focus-ring',
] as const;

/** Non-colour tokens: motion durations and the density row height. */
const REQUIRED_VALUE_TOKENS = ['--bc-motion-fast', '--bc-motion-base', '--bc-row-height'] as const;

interface ContrastCase {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  /** 4.5 for body text (WCAG 1.4.3), 3 for control borders and focus rings (WCAG 1.4.11). */
  readonly minimum: number;
}

const CONTRAST_CASES: readonly ContrastCase[] = [
  {
    name: 'body text on the page surface',
    foreground: '--bc-text',
    background: '--bc-surface',
    minimum: 4.5,
  },
  {
    name: 'body text on a raised surface',
    foreground: '--bc-text',
    background: '--bc-surface-raised',
    minimum: 4.5,
  },
  {
    name: 'muted text on the page surface',
    foreground: '--bc-text-muted',
    background: '--bc-surface',
    minimum: 4.5,
  },
  {
    name: 'danger text on the danger surface',
    foreground: '--bc-danger-text',
    background: '--bc-danger-surface',
    minimum: 4.5,
  },
  {
    name: 'control border against the page surface',
    foreground: '--bc-border-strong',
    background: '--bc-surface',
    minimum: 3,
  },
  {
    name: 'focus ring against the page surface',
    foreground: '--bc-focus-ring',
    background: '--bc-surface',
    minimum: 3,
  },
];

describe('semantic tokens', () => {
  it.each(REQUIRED_COLOUR_TOKENS)('%s has a value in both schemes', (token) => {
    expect(schemeTokens('light').get(token), `light: ${token}`).toBeDefined();
    expect(schemeTokens('dark').get(token), `dark: ${token}`).toBeDefined();
  });

  it.each(REQUIRED_VALUE_TOKENS)('%s is declared', (token) => {
    expect(declaredTokens().get(token)).toBeDefined();
  });

  /**
   * The failure this catches is one-sided theming: a token added to the light block and forgotten
   * in the dark one inherits nothing and renders as an empty value — a transparent background or
   * an invisible border, in the theme the author was not looking at.
   */
  it('declares no scheme token that only one scheme has', () => {
    const light = [...schemeTokens('light').keys()];
    const dark = [...schemeTokens('dark').keys()];

    expect([
      ...light.filter((token) => !dark.includes(token)),
      ...dark.filter((token) => !light.includes(token)),
    ]).toEqual([]);
  });

  /** Every scheme value is a Mantine variable: a literal hex here is a palette nobody can retheme. */
  it('builds every scheme token out of Mantine colour variables', () => {
    const literal = (['light', 'dark'] as const).flatMap((scheme) =>
      [...schemeTokens(scheme)]
        .filter(([, value]) => !value.startsWith('var(--mantine-color-'))
        .map(([name]) => `${scheme}: ${name}`),
    );

    expect(literal).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('contrast in the %s scheme', (scheme) => {
  it.each(CONTRAST_CASES)('$name is at least $minimum:1', ({ foreground, background, minimum }) => {
    const tokens = colourTokens(scheme);
    const front = tokens.get(foreground);
    const back = tokens.get(background);

    expect(front, foreground).toBeDefined();
    expect(back, background).toBeDefined();
    expect(roundRatio(contrastRatio(front as string, back as string))).toBeGreaterThanOrEqual(
      minimum,
    );
  });
});

describe('motion and density', () => {
  it('names the two durations the design system allows', () => {
    const css = declaredTokens();

    expect(css.get('--bc-motion-fast')).toBe('120ms');
    expect(css.get('--bc-motion-base')).toBe('200ms');
  });

  /**
   * The escape hatch for a user who cannot tolerate motion is the media query, and it is the one
   * thing no component may forget (`rules/a11y.mdc` §24). Here it collapses the durations at the
   * source, so a component that animates with a token honours the preference for free.
   */
  it('collapses both durations under prefers-reduced-motion', () => {
    const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\{([^}]*)\}/.exec(
      tokensCss(),
    );

    expect(reduced?.[1]).toContain('--bc-motion-fast: 0ms');
    expect(reduced?.[1]).toContain('--bc-motion-base: 0ms');
  });

  it('shortens the row height in the compact density mode', () => {
    const compact = /\[data-bc-density='compact'\]\s*\{([^}]*)\}/.exec(tokensCss())?.[1];

    expect(compact).toContain('--bc-row-height');
  });
});
