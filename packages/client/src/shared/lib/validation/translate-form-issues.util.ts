/**
 * What `@mantine/form` hands a component for a failed field: whatever the resolver returned, per
 * path. Declared here rather than imported so this file stays free of the form library — it is a
 * function over a record, and typing it as one keeps `shared/lib` framework-free
 * (`rules/frontend-fsd.mdc` rule 8).
 */
export type FormIssues = Record<string, unknown>;

/**
 * Turns the i18n keys a Zod schema produces into the sentences a person reads.
 *
 * Every schema in this repository answers with a **key** rather than a sentence
 * (`rules/i18n.mdc` §1): `validation.email.invalid`, `auth.register.field.slugInvalid`. Mantine
 * renders what the resolver returns, verbatim — so a form that wires `schemaResolver` straight into
 * `validate` shows the key itself under the field, in both languages. It is invisible to the whole
 * suite because the client tests run in `cimode`, where `t(key)` *is* the key: an assertion on
 * `validation.email.invalid` passes whether or not anything translated it.
 *
 * Only strings are touched. A resolver may legitimately answer with a node — an element with a link
 * in it — and passing that through `t` would stringify it.
 *
 * Nested paths (`owner.email`) arrive as flat keys of this record, so nothing has to walk a tree.
 */
export const translateFormIssues = <TIssues extends FormIssues>(
  issues: TIssues,
  translate: (key: string) => string,
): TIssues =>
  // The record comes back with the paths and the value types it went in with — a translated string
  // is still a string — but `Object.fromEntries` types its answer as a fresh index signature and
  // loses that. The assertion restores what the mapping already guarantees, and it is what lets a
  // caller hand the result straight back to `@mantine/form`, whose `validate` is typed over the
  // form's own error shape rather than over `unknown`.
  Object.fromEntries(
    Object.entries(issues).map(([path, issue]) => [
      path,
      typeof issue === 'string' ? translate(issue) : issue,
    ]),
  ) as TIssues;
