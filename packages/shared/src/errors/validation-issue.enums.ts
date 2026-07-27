/**
 * The per-field half of a `validation_failed` RFC 9457 problem response.
 *
 * `code` at the top level of the document says *that* the request was rejected; this list says
 * *which field* and *why*, one entry per offending field. Both halves are contract: the client
 * maps `errors[].code` to an i18n key exactly the way it maps the top-level `code`, so the set of
 * possible values has to be closed and enumerated in `docs/api/openapi.yaml`
 * (stack.md, «Формат ошибок»).
 *
 * The values are the issue codes of Zod 4. They are restated here rather than imported from `zod`
 * for two reasons: `packages/shared` is isomorphic and the client must not carry a validator it
 * never runs, and a Zod release that renames a code has to break a test in this repository instead
 * of silently shipping a code no dictionary has an entry for.
 */
export const VALIDATION_ISSUE_CODES = [
  'invalid_type',
  'too_big',
  'too_small',
  'invalid_format',
  'not_multiple_of',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'invalid_element',
  'invalid_value',
  'custom',
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

/**
 * One rejected field.
 *
 * `path` is dot notation over the request value — `amount.value`, `items[0].title` — so a form can
 * highlight the input that caused it without parsing anything. `message` is for the developer
 * reading a log or a failing test; it is English, it may be reworded at any time, and the client
 * must not show it to a user (that is what `code` is for).
 */
export interface ValidationIssue {
  readonly path: string;
  readonly code: ValidationIssueCode;
  readonly message: string;
}

const VALIDATION_ISSUE_CODE_SET: ReadonlySet<string> = new Set<string>(VALIDATION_ISSUE_CODES);

export const isValidationIssueCode = (value: string): value is ValidationIssueCode =>
  VALIDATION_ISSUE_CODE_SET.has(value);

/**
 * An arbitrary string narrowed to the catalog, with `custom` as the fallback.
 *
 * A validator can produce a code this catalog has never seen: a new issue kind in a Zod minor
 * release, or a schema from a dependency. Letting it through would put a value in `errors[].code`
 * that the OpenAPI `enum` does not list — a response that violates its own published contract, and
 * a client with nothing to translate. `custom` is the honest answer: the field is invalid and the
 * reason has no dedicated code.
 */
export const asValidationIssueCode = (value: string): ValidationIssueCode =>
  isValidationIssueCode(value) ? value : 'custom';
