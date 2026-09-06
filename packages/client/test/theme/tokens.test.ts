import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DANGER_COLORS,
  INFO_COLORS,
  NEUTRAL_COLORS,
  SUCCESS_COLORS,
  WARNING_COLORS,
} from '@app/theme/app-theme.config.js';

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
  '--bc-link',
  '--bc-danger-surface',
  '--bc-danger-text',
  '--bc-warning-surface',
  '--bc-warning-text',
  '--bc-success-surface',
  '--bc-success-text',
  '--bc-info-surface',
  '--bc-info-text',
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
  /*
   * A link is measured on both surfaces, and the raised one is the case that was missing.
   *
   * `--bc-surface` alone is what `--mantine-color-anchor` is already tuned for, so a link token
   * checked only there would have passed while the product shipped the defect: a striped table
   * paints every other row `--bc-surface-raised`, and the person links of `/admin/members` sat on
   * it at 4.39:1. Nothing in this repository could see it — jsdom applies no stylesheet, so the
   * token block could not resolve the pair, and `axe` only meets the colour on a rendered page.
   * It took an end-to-end audit of a screen that did not exist until EPIC-012
   * (`packages/e2e/tests/tenancy/cross-tenant-ui.spec.ts`) to report it.
   */
  {
    name: 'link text on the page surface',
    foreground: '--bc-link',
    background: '--bc-surface',
    minimum: 4.5,
  },
  {
    name: 'link text on a raised surface',
    foreground: '--bc-link',
    background: '--bc-surface-raised',
    minimum: 4.5,
  },
  /*
   * Every status is measured twice, because its text appears on two backgrounds and only one of
   * them is the tinted panel the token is named after: an `Alert` puts the label on the status
   * surface, and a `<Text c="var(--bc-danger-text)">` beside a permission row puts the same colour
   * on the page. A pair that clears 4.5:1 on the tint can still fail on white — that is precisely
   * how `--mantine-color-red-text` shipped at 3.28:1.
   */
  {
    name: 'danger text on the danger surface',
    foreground: '--bc-danger-text',
    background: '--bc-danger-surface',
    minimum: 4.5,
  },
  {
    name: 'danger text on the page surface',
    foreground: '--bc-danger-text',
    background: '--bc-surface',
    minimum: 4.5,
  },
  {
    name: 'warning text on the warning surface',
    foreground: '--bc-warning-text',
    background: '--bc-warning-surface',
    minimum: 4.5,
  },
  {
    name: 'warning text on the page surface',
    foreground: '--bc-warning-text',
    background: '--bc-surface',
    minimum: 4.5,
  },
  {
    name: 'success text on the success surface',
    foreground: '--bc-success-text',
    background: '--bc-success-surface',
    minimum: 4.5,
  },
  {
    name: 'success text on the page surface',
    foreground: '--bc-success-text',
    background: '--bc-surface',
    minimum: 4.5,
  },
  {
    name: 'info text on the info surface',
    foreground: '--bc-info-text',
    background: '--bc-info-surface',
    minimum: 4.5,
  },
  {
    name: 'info text on the page surface',
    foreground: '--bc-info-text',
    background: '--bc-surface',
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

/**
 * The semantic scales, measured at the three places Mantine reads text off a palette.
 *
 * A component says `color="warning"`, and the library — not this repository — decides that
 * `variant="light"` is shade 9 on shade 1, that `variant="filled"` is white on the primary shade,
 * and that the dark scheme puts shade 0 on a tint built from the dark end. None of those three
 * pairs is named by a `--bc-*` token, so the block above cannot see them, and every one of them
 * failed on Mantine's own palettes: `yellow-9` on `yellow-1` is 2.68:1, white on `red-6` is
 * 3.28:1. This is the assertion that makes «shade 6 is a bit prettier one step lighter» fail in a
 * test run rather than in an axe report on a screen nobody opened.
 */
describe.each([
  ['danger', DANGER_COLORS],
  ['warning', WARNING_COLORS],
  ['success', SUCCESS_COLORS],
  ['info', INFO_COLORS],
  ['neutral', NEUTRAL_COLORS],
] as const)('the %s scale', (_name, scale) => {
  const ratio = (foreground: string, background: string): number =>
    roundRatio(contrastRatio(foreground, background));

  /**
   * **This case does not measure what its name says, and the correction is not a one-line edit.**
   *
   * Mantine 9 paints `variant="light"` as `--mantine-color-<c>-light-color` on
   * `--mantine-color-<c>-light`, and in the light scheme that resolves to **shade 6** on shade 1,
   * not shade 9 on shade 1. Measured on a rendered page 2026-09-06: the `ErrorState` alert reports
   * `#c84242` on `#ffe3e3` — `danger-6` on `danger-1` — at **4.02:1**, a WCAG AA failure, while
   * this assertion sat green throughout.
   *
   * So the pair below is real (shade 9 on shade 1 is what a hand-written label on a tinted panel
   * uses) but it is not the library's, and asserting it has been giving false confidence to every
   * `variant="light"` surface in the product. Repairing that means moving shade 6 on five palettes
   * while keeping white legible on it — a design-system change with its own review — so the wrong
   * assumption is annotated here rather than quietly deleted, and the missing case is added by that
   * work. `packages/e2e/tests/tenancy/cross-tenant-ui.spec.ts` carries the same note beside the one
   * screen whose audit is switched off because of it.
   */
  it('carries a hand-written label on a light-variant surface', () => {
    expect(ratio(scale[9] as string, scale[1] as string)).toBeGreaterThanOrEqual(4.5);
  });

  it('carries white on a filled surface in either scheme', () => {
    // `primaryShade` is 6 in the light scheme and 8 in the dark one, and Mantine applies it to
    // every palette, not only the primary — so a filled control is one of these two.
    expect(ratio('#ffffff', scale[6] as string)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ffffff', scale[8] as string)).toBeGreaterThanOrEqual(4.5);
  });

  it('carries its lightest shade on its darkest, which is the dark-scheme light variant', () => {
    expect(ratio(scale[0] as string, scale[9] as string)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * Shade 4 is what `--mantine-color-<scale>-text` and `-outline` resolve to in the dark scheme,
   * and the light-scheme half of that same variable is where this whole repair started:
   * `--mantine-color-red-text` was `red-6` on white at 3.28:1, on every `dangerous` label there is.
   * The dark half deserves the same assertion, not the same trust.
   */
  it('carries its text shade on the dark page surface', () => {
    const surface = colourTokens('dark').get('--bc-surface') as string;

    expect(ratio(scale[4] as string, surface)).toBeGreaterThanOrEqual(4.5);
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

/**
 * The consumers of `--bc-link`, because measuring the token proves nothing about who uses it.
 *
 * The token exists for one reason: `--mantine-color-anchor` is `brand-6`, tuned against white, and
 * a striped table paints every other row `--bc-surface-raised`, where it measures 4.39:1. Both
 * stylesheets below put a link on exactly that surface.
 *
 * Only one of them had a guard. `/admin/members` is audited by `axe` in the end-to-end run, so a
 * regression there resurfaces; `/admin/teams` is visited by no scenario at all, and reverting its
 * link to `var(--mantine-color-anchor)` would have passed stylelint (both spellings are legal
 * tokens), passed the contrast block above (which measures the token, not its consumers) and passed
 * every other test in this package. This is the assertion that closes that hole, and it is here
 * rather than in a browser because the property is textual: a stylesheet either names the token or
 * it does not.
 */
describe('the link token is what the striped tables actually use', () => {
  const LINK_STYLESHEETS = [
    'src/widgets/member-list/ui/member-list-ui.module.css',
    'src/widgets/team-list/ui/team-list-ui.module.css',
  ] as const;

  it.each(LINK_STYLESHEETS)('%s colours its link with --bc-link', (path) => {
    const css = readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8');
    const linkRule = /\.\w*[Ll]ink\s*\{([^}]*)\}/.exec(css)?.[1];

    expect(linkRule, `${path}: no link class found`).toBeDefined();
    expect(linkRule).toContain('var(--bc-link)');
  });

  /**
   * CONTROL: the regular expression finds a rule and reads its body, rather than matching nothing
   * and passing on a `toContain` that was never reached. Without it, renaming the class would turn
   * both cases above into assertions about `undefined`.
   */
  it('CONTROL: rejects a link rule that names the anchor colour instead', () => {
    const stale = /\.\w*[Ll]ink\s*\{([^}]*)\}/.exec(
      '.personLink {\n  color: var(--mantine-color-anchor);\n}',
    )?.[1];

    expect(stale).toBeDefined();
    expect(stale).not.toContain('var(--bc-link)');
  });
});
