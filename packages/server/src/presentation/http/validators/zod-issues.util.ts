import { asValidationIssueCode, type ValidationIssue } from '@bad-crm/shared/errors';
import { type ZodError, type core } from 'zod';

/**
 * A Zod path (`['items', 1, 'title']`) as the client sees it (`items[1].title`).
 *
 * Dot notation with bracketed indices is what a form library addresses a field by, so the response
 * can be applied to an input without any parsing on the other side. An empty path means the value
 * as a whole was wrong — a body that is a string where an object was expected — and there is no
 * field to point at.
 */
const formatPath = (segments: readonly PropertyKey[]): string =>
  segments.reduce<string>((path, segment) => {
    if (typeof segment === 'number') return `${path}[${segment}]`;

    return path === '' ? String(segment) : `${path}.${String(segment)}`;
  }, '');

/** `unrecognized_keys` names its keys in a payload rather than in `path`. */
const unrecognizedKeysOf = (issue: core.$ZodIssue): readonly string[] | undefined =>
  issue.code === 'unrecognized_keys' ? issue.keys : undefined;

/**
 * `ZodError` → the `errors[]` array of a `validation_failed` problem document.
 *
 * The whole point is one entry **per offending field**. The previous shape of this response was a
 * count (`issueCount`), which is enough to tell a developer that something was wrong and nothing
 * at all to a form that has to highlight an input — so the client either showed a generic banner
 * or re-implemented the validation to guess which field it was.
 *
 * Two flattenings happen here, both because Zod's structure is about *its own* traversal and the
 * response is about the *request*:
 *
 * - `unrecognized_keys` arrives as a single issue with an empty path carrying a list of keys; it
 *   becomes one entry per key, addressed at the key, because "you sent `perPage`, which this
 *   operation does not accept" is per-field information;
 * - every other code keeps its path, narrowed through `asValidationIssueCode` so that a Zod
 *   release cannot put a value into the response that the OpenAPI `enum` does not list.
 */
export const toValidationIssues = (error: ZodError): readonly ValidationIssue[] =>
  error.issues.flatMap((issue): ValidationIssue[] => {
    const code = asValidationIssueCode(issue.code);
    const unrecognized = unrecognizedKeysOf(issue);

    if (unrecognized !== undefined) {
      const base = formatPath(issue.path);

      return unrecognized.map((key) => ({
        path: base === '' ? key : `${base}.${key}`,
        code,
        message: `Unrecognized key: ${key}`,
      }));
    }

    return [{ path: formatPath(issue.path), code, message: issue.message }];
  });
