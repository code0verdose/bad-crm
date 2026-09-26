/** The contract's own shape for a palette name (`ProjectDraft.color`). */
const PALETTE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The CSS value a project's colour is painted with — a palette **name** turned into the theme
 * variable Mantine declares for it, never a literal.
 *
 * The name comes from the server and ends up inside a CSS value, so it is held to the contract's
 * pattern here as well: a value that does not match paints nothing (`undefined`) instead of being
 * interpolated into a stylesheet. An unknown but well-formed name resolves to an undefined variable
 * and paints nothing either — the swatch is decorative, and the key and name beside it are what
 * identify the project (`rules/a11y.mdc` §2).
 */
export const projectColorValue = (color: string): string | undefined =>
  PALETTE_NAME.test(color) ? `var(--mantine-color-${color}-filled)` : undefined;
