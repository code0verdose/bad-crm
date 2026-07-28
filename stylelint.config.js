/**
 * Stylelint — the machine half of `rules/design-system.mdc` §3.
 *
 * That rule says a stylesheet may name a *token* and never a value: colours are `--mantine-color-*`
 * or the semantic `--bc-*` aliases, spacing is `--mantine-spacing-*`, radii are `--mantine-radius-*`.
 * A rule stated only in prose is a rule that holds until the first hurried afternoon, so the three
 * claims it makes — no literal colour, no magic pixel, logical properties — are compiled into the
 * rules below and run as part of `pnpm turbo run lint`.
 *
 * This config is the whole of that rule except one blind spot, and the blind spot is covered rather
 * than described: every rule below is bound to a declaration or to `@media`, so nothing here reads
 * an at-rule's *prelude* — `@mixin smaller-than 700px` and `@container (min-width: 700px)` lint
 * clean. `packages/client/test/styles/at-rule-literals.test.ts` reads the stylesheets for exactly
 * that and for nothing else; it used to restate these rules with regular expressions, and the
 * duplicate half was deleted when this config arrived rather than kept in step by hand.
 *
 * The test that matters most is `test/lint/stylelint-rules.test.ts` — it feeds this config
 * deliberately broken CSS and asserts it fails, because a linter that never fires is a linter that
 * is switched off.
 *
 * Syntax note. The client's CSS is compiled by `postcss-preset-mantine` and `postcss-simple-vars`
 * (`packages/client/postcss.config.cjs`), so the source contains three constructs plain CSS does
 * not have: `@mixin light-root` / `@mixin dark-root`, the helper functions `rem()` / `em()` /
 * `alpha()` / `lighten()` / `darken()`, and `$mantine-breakpoint-*` inside media queries. Each is
 * resolved before a browser ever sees it, and each is taught to the relevant rule below rather than
 * silenced by dropping the rule.
 *
 * `stylelint-config-css-modules` is deliberately not used. Its whole payload for a project like
 * this one is the handful of `ignore*` entries reproduced under "CSS Modules" below — the rest of
 * it is a `**\/*.scss` override that pulls `stylelint-scss` into a repository whose ADR-0006 rules
 * SCSS out. Six packages of supply chain for an override that can never match is a bad trade.
 */

/**
 * A `px` length that is neither `0px` nor `1px`.
 *
 * `1px` stays legal on purpose and is the only exception: it is the hairline border every surface
 * in the client draws (`border: 1px solid var(--bc-border)`) and the 1×1 box of the visually-hidden
 * idiom in `route-announcer.module.css`. There is no spacing token for "one device pixel", and
 * inventing one would give the rule a false positive on every card in the product — which is how a
 * rule ends up disabled wholesale instead of tightened.
 *
 * The lookbehind keeps the match off the inside of an identifier, so `--bc-2px-thing` and
 * `translate3d(…)` are not mistaken for lengths; the optional sign catches `-8px`, which is
 * otherwise the easiest way to write a magic number and pass.
 */
const MAGIC_PIXELS = /(?<![\w.-])-?(?!0px\b)(?!1px\b)\d*\.?\d+px\b/;

/**
 * Every colour syntax that spells a value instead of naming a token.
 *
 * `color-no-hex` and `color-named` already cover `#1971c2` and `white`; this covers the functional
 * notations, which are the ones a copy from a design tool actually produces. `light-dark()` is
 * absent by design — it is how a token declares its two halves and is required, not forbidden.
 */
const LITERAL_COLOR_FUNCTIONS = /(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/;

/**
 * Physical properties whose logical form is required.
 *
 * The inline-axis entries (`margin-left`, `padding-right`, `left`, `border-left`, …) are the
 * acceptance criterion of STORY-004-03 and the ones that actually break: they do not mirror under
 * `direction: rtl`, so a physical stylesheet needs a second stylesheet per locale. The block-axis
 * and size entries are here because the client already writes them logically everywhere
 * (`inset-block-start`, `block-size`, `min-block-size`, `border-block-end`) — enforcing a
 * convention the code already keeps costs nothing and stops the drift.
 *
 * The block-axis borders are on the list too, longhands included. They were left off while one
 * occurrence existed — `page-header.module.css` wrote `border-bottom` where its sibling
 * `topbar.module.css` wrote `border-block-end` — and the gap was asserted in
 * `test/lint/stylelint-rules.test.ts` so that it could not be mistaken for an oversight. That
 * declaration is now logical, the assertion is gone, and the names are here: `border-bottom-color`
 * is listed beside `border-bottom` because a list holding only the shorthand is walked around by a
 * longhand without anybody noticing.
 */
const PHYSICAL_PROPERTIES = [
  // Inline axis — the RTL failure, and the acceptance criterion of the story.
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'left',
  'right',
  'border-left',
  'border-left-width',
  'border-left-style',
  'border-left-color',
  'border-right',
  'border-right-width',
  'border-right-style',
  'border-right-color',
  // Block axis — free to enforce, the client already writes these logically.
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-bottom',
  'top',
  'bottom',
  'border-top',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-bottom',
  'border-bottom-width',
  'border-bottom-style',
  'border-bottom-color',
  // Sizes — likewise: `inline-size` / `block-size` are what the modules already use.
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
];

/**
 * The two files where a literal value is legal, named individually.
 *
 * `rules/design-system.mdc` → «Исключения»: `tokens.css` is where the tokens are *declared* and
 * `global.css` is the reset, so both consume nothing and define everything. The exception is a list
 * of two paths rather than a rule turned off globally — the moment it becomes a directory glob, the
 * next stylesheet dropped beside them inherits permission to hard-code a colour.
 */
const TOKEN_DECLARATION_FILES = [
  'packages/client/src/app/styles/tokens.css',
  'packages/client/src/app/global.css',
];

/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard'],

  rules: {
    // ── no literal colours (rules/design-system.mdc §3) ────────────────────────────────────────
    'color-no-hex': [
      true,
      {
        message:
          'Literal colour. Use a token: `var(--bc-*)` for a semantic role or `var(--mantine-color-*)` for a palette step (rules/design-system.mdc §3).',
      },
    ],
    'color-named': [
      'never',
      {
        message:
          'Named colour. Use a token: `var(--bc-*)` or `var(--mantine-color-*)` (rules/design-system.mdc §3).',
      },
    ],

    // ── no magic pixels, no literal colour functions ───────────────────────────────────────────
    'declaration-property-value-disallowed-list': [
      {
        '/.+/': [MAGIC_PIXELS, LITERAL_COLOR_FUNCTIONS],
        // `text-align` and `float` carry the direction in the *value*, so the property-level list
        // cannot see them.
        'text-align': [/^(left|right)$/],
        float: [/^(left|right)$/],
      },
      {
        message:
          'Literal value. Spacing comes from `var(--mantine-spacing-*)` (or `calc()` over it), radii from `var(--mantine-radius-*)`, colours from `var(--bc-*)`; direction is `start` / `end`, never `left` / `right` (rules/design-system.mdc §3).',
      },
    ],

    // ── logical properties ─────────────────────────────────────────────────────────────────────
    'property-disallowed-list': [
      PHYSICAL_PROPERTIES,
      {
        message:
          'Physical property. Use the logical form — `margin-inline-start`, `padding-block-end`, `inset-inline-start`, `inline-size`, `block-size` — so a right-to-left locale needs no second stylesheet (rules/design-system.mdc §3).',
      },
    ],

    // ── the token namespace itself ─────────────────────────────────────────────────────────────
    // A custom property outside `--bc-*` is a token nobody declared and no contrast test measures.
    'custom-property-pattern': [
      '^(bc|mantine)-[a-z0-9]+(-[a-z0-9]+)*$',
      {
        message:
          'Custom properties belong to the token system: name them `--bc-*` (declared in `app/styles/tokens.css`) or consume `--mantine-*` (rules/design-system.mdc §3).',
      },
    ],

    // ── CSS Modules ────────────────────────────────────────────────────────────────────────────
    // Class names are consumed as `classes.sectionTitle`, so the identifier is camelCase, not the
    // kebab-case `stylelint-config-standard` assumes for a global stylesheet.
    // Two alternatives, and both are needed: a local class is read back as `classes.sectionTitle`,
    // so it is camelCase, while a name inside `:global(...)` belongs to a third-party widget
    // (dnd-kit, BlockNote, Schedule-X) and is kebab-case by their convention, not ours. What the
    // rule still rejects is the shape that is nobody's convention — `Section_Title`, `SectionTitle`.
    'selector-class-pattern': [
      '^(?:[a-z][a-zA-Z0-9]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$',
      {
        message:
          'CSS Modules class names are read back as `classes.<name>` in TSX, so a local class is camelCase; a third-party class inside `:global(...)` may be kebab-case.',
      },
    ],
    'selector-pseudo-class-no-unknown': [
      true,
      { ignorePseudoClasses: ['global', 'local', 'export', 'import', 'external'] },
    ],
    'property-no-unknown': [
      true,
      {
        ignoreProperties: ['composes', 'compose-with'],
        ignoreSelectors: [':export', '/^:import/'],
      },
    ],

    // ── postcss-preset-mantine / postcss-simple-vars ───────────────────────────────────────────
    // `@mixin light-root` and `@mixin dark-root` are how `tokens.css` declares the two schemes;
    // `@value` is the CSS Modules constant. Both are gone by the time the CSS is served.
    'at-rule-no-unknown': [true, { ignoreAtRules: ['mixin', 'define-mixin', 'value'] }],

    // A breakpoint is written by name, never by number. `postcss-simple-vars` substitutes the
    // `$mantine-breakpoint-*` values from `packages/client/postcss.config.cjs`, which are in `em` —
    // a media query in `px` ignores the reader's font size, and that is the accessibility failure
    // `rules/a11y.mdc` §4 is about. This is also where the story's "no magic pixels in media
    // queries" lives: `declaration-property-value-disallowed-list` sees declarations only and would
    // never look inside `@media (max-width: 768px)`.
    'media-feature-name-value-allowed-list': [
      // Both notations. `stylelint-config-standard` prefers the range form `(width <= …)`, and
      // measured on this config the prefix form `(max-width: …)` is the one Mantine documents — so
      // the key has to match `width` as well as `max-width`, or `@media (width <= 768px)` walks
      // straight through the gate that exists to stop `@media (max-width: 768px)`.
      {
        '/^(?:(?:min|max)-)?(?:width|height|inline-size|block-size)$/': [/^\$mantine-breakpoint-/],
      },
      {
        message:
          'Breakpoints are named, not measured: use `$mantine-breakpoint-xs|sm|md|lg|xl` (resolved by postcss-simple-vars) or the `@mixin smaller-than` / `larger-than` helpers (rules/design-system.mdc §3, rules/a11y.mdc §4).',
      },
    ],
    // The price of the line above. Stylelint parses `@media` params with a real media-query parser,
    // and `$mantine-breakpoint-sm` is not valid media-query grammar — it is a placeholder resolved
    // by PostCSS long before a browser sees it. The rule's only escape hatch is `ignoreFunctions`,
    // and a `$variable` is not a function, so there is nothing narrower to switch off. The coverage
    // it would have provided over width and height features is replaced, and tightened, by the
    // allow-list above; what is genuinely lost is typo detection on non-dimensional features
    // (`@media (prefers-reduce-motion: reduce)`), which `media-feature-name-no-unknown` — still on,
    // from `stylelint-config-recommended` — catches anyway.
    'media-query-no-invalid': null,

    // ── whitespace belongs to Prettier ─────────────────────────────────────────────────────────
    // Measured, not assumed: with `stylelint-config-standard` unmodified, the only rule that fired
    // over the whole client was this one, six times, on comments that annotate the declaration
    // *following* them — the house style of every stylesheet and every config in this repository.
    // Prettier already formats CSS here and has no opinion about blank lines before a comment, so
    // the rule buys no consistency and costs a blank line between every declaration and its reason.
    // Turned off deliberately, and only this one: everything else `stylelint-config-standard`
    // brings (shorthand redundancy, duplicate properties, invalid hex, unknown units) stays on.
    'comment-empty-line-before': null,
    // The preset's helpers. `light-dark()` is standard CSS and needs no entry, but stylelint's
    // function list lags the platform, so it is named here too.
    'function-no-unknown': [
      true,
      { ignoreFunctions: ['light-dark', 'rem', 'em', 'alpha', 'lighten', 'darken'] },
    ],
  },

  overrides: [
    {
      files: TOKEN_DECLARATION_FILES,
      rules: {
        'color-no-hex': null,
        'color-named': null,
        'declaration-property-value-disallowed-list': null,
      },
    },
  ],
};
