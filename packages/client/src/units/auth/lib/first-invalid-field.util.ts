/**
 * Which field a failed submit should move the focus to.
 *
 * The first one the schema complained about, in the order the schema declares its fields — which is
 * the order they are on screen, so the focus moves forwards rather than to whichever key an object
 * happened to be built with.
 *
 * Without this the browser leaves the caret where it was: a sighted user sees a field turn red, and
 * nobody else learns that anything happened at all (`rules/a11y.mdc` §18).
 *
 * An empty path is the honest answer for «nothing to fix» — it matches no input, so
 * `form.getInputNode('')` answers `null` and the focus stays where the user put it. A submit
 * reported as failed with no errors on it should not steal the caret to a guessed field.
 */
export const firstInvalidField = (errors: Readonly<Record<string, unknown>>): string =>
  Object.keys(errors)[0] ?? '';
