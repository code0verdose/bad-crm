/**
 * Which field a failed submit should move the focus to.
 *
 * **Without an order**: the first one the schema complained about, in the order the schema declares
 * its fields — which is the order they are on screen, so the focus moves forwards rather than to
 * whichever key an object happened to be built with. That is the form's own verdict, what
 * `form.onSubmit(…, onInvalid)` hands over.
 *
 * **With an order**: the first field of `order` that has a message. A server lists `errors[]` in the
 * order it found them, which has nothing to do with the screen, so its verdict is read against the
 * screen's own list of fields. A path the list does not name is not guessed at: it is not a field
 * of this form, and the caller shows it above the fields instead.
 *
 * Without this the browser leaves the caret where it was: a sighted user sees a field turn red, and
 * nobody else learns that anything happened at all (`rules/a11y.mdc` §18).
 *
 * An empty path is the honest answer for «nothing to fix» — it matches no input, so
 * `form.getInputNode('')` answers `null` and the focus stays where the user put it. A submit
 * reported as failed with no errors on it should not steal the caret to a guessed field.
 *
 * Moved here from `units/auth/lib` (2026-09-27) when the project form became the first form outside
 * sign-in to need it: nothing in it knows about a domain (`rules/frontend-fsd.mdc` rule 8).
 */
export const firstInvalidField = (
  errors: Readonly<Record<string, unknown>>,
  order?: readonly string[],
): string => {
  const failed = (field: string): boolean => errors[field] !== undefined;

  if (order === undefined) return Object.keys(errors).find(failed) ?? '';

  return order.find(failed) ?? '';
};
