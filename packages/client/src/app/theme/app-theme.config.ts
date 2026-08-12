import {
  createTheme,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from '@mantine/core';

/**
 * The status scales, and why they are ours rather than Mantine's.
 *
 * A component that says `color="yellow"` is not naming a colour, it is naming a *palette*, and
 * Mantine derives three things from it that all have to be read: `variant="light"` puts shade 9 on
 * shade 1, `variant="filled"` puts white on shade 6, and the dark scheme puts shade 0 on a tint of
 * the same hue. Measured against WCAG 1.4.3, Mantine's own palettes fail the first two for every
 * warm and green hue there is: `yellow-9` on `yellow-1` is 2.68:1, `teal-9` on `teal-1` is 4.32:1,
 * `green-9` on `green-1` is 3.80:1, `orange-9` on `orange-1` is 3.61:1 — and no darker shade
 * exists, so this cannot be fixed by picking a different number. White on `red-6` is 3.28:1, which
 * is every destructive button in the product.
 *
 * So the product declares five semantic scales instead. Shades 0–5 are Mantine's — they are tints
 * and hover states, and nothing reads text off them. Shades 6–9 are the same hue darkened by a
 * single factor per scale, chosen as the lightest one that clears the two numbers with margin:
 *
 * | Scale | Hue | Factor | shade 9 on shade 1 | white on shade 6 | shade 0 on shade 9 |
 * |---|---|---|---|---|---|
 * | `danger` | red | 0.80 | 6.26:1 | 4.86:1 | 7.09:1 |
 * | `warning` | yellow | 0.60 | 6.31:1 | 4.81:1 | 6.64:1 |
 * | `success` | green | 0.70 | 6.53:1 | 4.57:1 | 6.98:1 |
 * | `info` | blue | 0.85 | 6.21:1 | 4.72:1 | 6.90:1 |
 * | `neutral` | gray | 0.80 | 15.08:1 | 4.87:1 | 15.91:1 |
 *
 * The numbers are not maintained by hand: `test/theme/tokens.test.ts` recomputes the pairs from
 * these arrays, in both schemes, on every run — the same treatment `BRAND_COLORS` already gets.
 *
 * Naming them by *status* rather than by hue is the half of this that a linter can hold: hue names
 * are what let `color="yellow"` mean «amber, and hope», and `bad-crm/no-raw-mantine-color` now
 * refuses them. A screen asks for `danger`, and which colour that is stays one decision.
 */
export const DANGER_COLORS: MantineColorsTuple = [
  '#fff5f5',
  '#ffe3e3',
  '#ffc9c9',
  '#ffa8a8',
  '#ff8787',
  '#ff6b6b',
  '#c84242',
  '#c03232',
  '#b32727',
  '#a12222',
];

export const WARNING_COLORS: MantineColorsTuple = [
  '#fff9db',
  '#fff3bf',
  '#ffec99',
  '#ffe066',
  '#ffd43b',
  '#fcc419',
  '#966a03',
  '#935f00',
  '#905400',
  '#8a4700',
];

export const SUCCESS_COLORS: MantineColorsTuple = [
  '#ebfbee',
  '#d3f9d8',
  '#b2f2bb',
  '#8ce99a',
  '#69db7c',
  '#51cf66',
  '#2d863d',
  '#277d36',
  '#216f30',
  '#1e612b',
];

export const INFO_COLORS: MantineColorsTuple = [
  '#e7f5ff',
  '#d0ebff',
  '#a5d8ff',
  '#74c0fc',
  '#4dabf7',
  '#339af0',
  '#1d76c4',
  '#186bb6',
  '#1560a5',
  '#145591',
];

export const NEUTRAL_COLORS: MantineColorsTuple = [
  '#f8f9fa',
  '#f1f3f5',
  '#e9ecef',
  '#dee2e6',
  '#ced4da',
  '#adb5bd',
  '#6b7278',
  '#3a4046',
  '#2a2e33',
  '#1a1e21',
];

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
  colors: {
    brand: BRAND_COLORS,
    danger: DANGER_COLORS,
    warning: WARNING_COLORS,
    success: SUCCESS_COLORS,
    info: INFO_COLORS,
    neutral: NEUTRAL_COLORS,
  },
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 8 },

  /** Controls `sm`, cards `md`, overlays `lg` — the default is the one controls use. */
  defaultRadius: 'sm',

  /**
   * Honour `prefers-reduced-motion`. Mantine 9 defaults this to `false`, so without the line the
   * setting a person turned on in their operating system — often because motion makes them ill —
   * reaches our modals, drawers and transitions and is ignored by all of them.
   *
   * It also removes a whole class of false accessibility failure. An axe audit taken while a dialog
   * is fading in measures the *composite* of the element over what is behind it, and reports pairs
   * like `#ecd0d0` on `#b65858` — colours present in no palette and in no stylesheet, drifting run
   * to run with wherever the transition happened to be. One of those survived the entire palette
   * being repaired and looked exactly like a contrast defect. With the preference respected, a
   * violation reported by the suite is a fact about the tokens rather than about the frame the
   * audit landed on.
   */
  respectReducedMotion: true,

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

/**
 * The Mantine variables this product replaces, as opposed to the ones it consumes.
 *
 * `--mantine-color-dimmed` is what Mantine's own components put on the description under an input,
 * a checkbox or a table caption. No file in this repository writes that text, so renaming
 * `c="dimmed"` at the call sites fixes the muted text we author and leaves the muted text the
 * library renders — which is most of it, and which is what `@axe-core/playwright` reported on
 * `/settings/security`. Measured, the default is `gray-6` on white at 3.32:1 and `dark-2` on
 * `dark-7` at 4.03:1: secondary body text below the 4.5:1 of WCAG 1.4.3, in **both** schemes.
 *
 * Done here rather than by re-declaring the variable in `tokens.css`, and the difference is not
 * stylistic. `MantineProvider` renders its resolved variables into a `<style>` inside the tree —
 * after `<head>` in document order, at the same specificity — so a stylesheet override only wins
 * while Mantine's deduplication happens to strip that variable for being equal to its default.
 * Change the value through this resolver and the variable stops being equal to its default, which
 * is precisely when the stylesheet override would have lost. One mechanism, and it is the one that
 * cannot be undone by load order.
 */
export const appCssVariables: CSSVariablesResolver = () => ({
  variables: {},
  light: { '--mantine-color-dimmed': 'var(--bc-text-muted)' },
  dark: { '--mantine-color-dimmed': 'var(--bc-text-muted)' },
});
