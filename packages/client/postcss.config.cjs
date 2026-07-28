/*
 * PostCSS for the client — the two plugins Mantine's setup requires, and nothing else.
 *
 * `postcss-preset-mantine` provides `light-dark()`, the `light-root`/`dark-root` mixins used by
 * `src/app/styles/tokens.css`, and the `rem()`/`em()` helpers. Without it those constructs reach
 * the browser verbatim and the dark theme silently never applies.
 *
 * `postcss-simple-vars` resolves `$mantine-breakpoint-*` inside media queries, which is what lets a
 * stylesheet write a breakpoint by name instead of by magic pixel value (`rules/design-system.mdc`
 * §3). The values are Mantine's own defaults, in `em` — a breakpoint in `px` ignores the user's
 * font size, which is the accessibility failure `rules/a11y.mdc` §4 is about.
 *
 * CommonJS, because PostCSS loads its configuration synchronously and this package is `"type":
 * "module"`; `.cjs` is the extension that says so.
 */
module.exports = {
  plugins: {
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
  },
};
