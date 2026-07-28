import { createTheme, type MantineColorsTuple, type MantineThemeOverride } from '@mantine/core';

/**
 * The brand scale, ten shades, dark enough to carry white text.
 *
 * Mantine's own blue fails WCAG AA as a filled button background — `#228be6` under white text is
 * about 3.1:1, and a primary action is body-sized text, so it needs 4.5:1. This scale is measured
 * instead of chosen: shade 6 (light scheme) is 4.63:1 under white and shade 8 (dark scheme) is
 * 7.08:1, and `test/theme/tokens.test.ts` recomputes both from this array on every run.
 */
export const BRAND_COLORS: MantineColorsTuple = [
  '#eef3ff',
  '#dce4f5',
  '#b9c7e2',
  '#94a8d0',
  '#748dc1',
  '#5f7cb8',
  '#5474b4',
  '#44639f',
  '#39588f',
  '#2d4b81',
];

/**
 * The theme is a *narrowing* of Mantine, not a replacement (ADR-0006): what it fixes is the small
 * set of choices that must not be made per component — the brand scale, the radius vocabulary, the
 * type scale — so that a screen assembled by two people still looks like one product.
 *
 * `primaryShade` differs per scheme on purpose. One shade cannot satisfy both: light enough to read
 * against a dark surface is too light to carry white text on a button, and the compromise is the
 * button nobody can read.
 */
export const appTheme: MantineThemeOverride = createTheme({
  colors: { brand: BRAND_COLORS },
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 8 },

  /** Controls `sm`, cards `md`, overlays `lg` — the default is the one controls use. */
  defaultRadius: 'sm',

  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',

  /**
   * 1.5 is a WCAG 1.4.12 floor for body text, not a taste: below it, text at 200 % zoom overlaps.
   * Headings are allowed to be tighter because they are large text.
   */
  lineHeights: { xs: '1.5', sm: '1.5', md: '1.55', lg: '1.55', xl: '1.6' },

  headings: {
    fontWeight: '600',
    sizes: {
      h1: { fontSize: 'var(--mantine-font-size-xl)', lineHeight: '1.3' },
      h2: { fontSize: 'var(--mantine-font-size-lg)', lineHeight: '1.35' },
      h3: { fontSize: 'var(--mantine-font-size-md)', lineHeight: '1.4' },
    },
  },

  components: {
    /**
     * Every icon-only control is a `Tooltip` candidate and every tooltip in this product is
     * keyboard-reachable, so the delay is short enough to feel like a label rather than a reward
     * for hovering (`rules/a11y.mdc` §17 — the tooltip is *not* the accessible name, the
     * `aria-label` is; this only stops the two from disagreeing about when they appear).
     */
    Tooltip: { defaultProps: { openDelay: 200, withArrow: true } },
  },
});
