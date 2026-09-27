/** The project form's fields that are a choice from a list rather than typed text. */
const CHOICE_FIELDS: ReadonlySet<string> = new Set(['visibility', 'leadId', 'color']);

/** Does nothing — the handler a locked field is given so that it stays a controlled one. */
const ignoreChange = (): void => undefined;

/**
 * What every input of the project form gets on top of `@mantine/form`'s own props while the
 * project is archived: reachable, announced as unavailable, and unable to change.
 *
 * **`aria-disabled`, not `disabled`** (`rules/a11y.mdc` §23): a hard `disabled` drops the field out
 * of the tab order, and a keyboard user can no longer read what the project holds or find the note
 * that says why nothing can be changed.
 *
 * **The code refuses, not the attribute.** `aria-disabled` only describes. A typed field is
 * `readOnly`, which the browser enforces and a screen reader announces. A `<select>` has no
 * read-only state in HTML, so it is held instead: `value` pins the stored choice and the change
 * handler ignores what the reader picks, and React puts the stored option back — which is why the
 * field is made controlled here, with `defaultValue` taken away (React warns about an input that
 * carries both).
 *
 * Fed from `enhanceGetInputProps`, which `@mantine/form` merges over the props it builds itself, so
 * the markup keeps one spread per field instead of a locked twin of each.
 */
export const lockedFieldProps = (field: string, value: unknown) => ({
  'aria-disabled': true,
  defaultValue: undefined,
  value,
  onChange: ignoreChange,
  ...(CHOICE_FIELDS.has(field) ? {} : { readOnly: true }),
});
