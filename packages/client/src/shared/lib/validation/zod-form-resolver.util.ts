import type { $ZodIssue } from 'zod/v4/core';
import type { ZodType } from 'zod';

/**
 * One refusal, as the pair a sentence needs: the i18n key the schema declared, and the numbers the
 * failed check itself carried.
 *
 * `values` is not a copy of anything. `too_big` on a Zod issue holds the very `maximum` the check
 * compared against, so «at most {{count}} characters» interpolates the bound that refused the
 * value — there is no second place for the number to live and therefore nothing to drift from.
 */
export interface CountValues {
  readonly count: number;
}

export interface FormIssue {
  readonly key: string;
  readonly values?: CountValues;
}

/**
 * `{ key }` and nothing else is still an issue — and a React element is never one, however much it
 * looks like one.
 *
 * The second clause is not defensive coding. `@mantine/form` may legitimately be handed a node as a
 * field error — a sentence with a link in it — and **a React element carries `key`**: written as
 * `<a key="terms">…</a>` it has a string there and would otherwise be mistaken for an issue,
 * stringified through `t`, and rendered as `[object Object]`. `$$typeof` is the marker React itself
 * uses to tell its elements apart from plain objects, and it is the only thing that separates the
 * two shapes here.
 */
export const isFormIssue = (value: unknown): value is FormIssue =>
  typeof value === 'object' &&
  value !== null &&
  !('$$typeof' in value) &&
  typeof (value as { key?: unknown }).key === 'string';

/**
 * What the sentence may interpolate, taken from the check that failed.
 *
 * Only the two bound issues carry a number. `count` rather than `max`/`min` because i18next
 * pluralises on `count` and nothing else, and the sentence needs it: «не меньше 1 часа» against
 * «не меньше 80 часов» (`rules/i18n.mdc` §8). Whether the count is characters, hours or list
 * entries is the sentence's business, and the sentence is chosen by the key.
 */
const issueValues = (issue: $ZodIssue): CountValues | undefined => {
  if (issue.code === 'too_big') return { count: Number(issue.maximum) };
  if (issue.code === 'too_small') return { count: Number(issue.minimum) };

  // A `refine` has no bound of its own, so a check Zod cannot express — «every entry of this one
  // input is short enough» — declares its number in `params`. A typed field on the issue, not a
  // number smuggled inside the message: the message stays a key and nothing has to be parsed.
  if (issue.code === 'custom') {
    const declared = (issue.params as { count?: unknown } | undefined)?.count;

    if (typeof declared === 'number') return { count: declared };
  }

  return undefined;
};

/**
 * `@mantine/form`'s `validate`, over a Zod schema, answering with keys and values instead of text.
 *
 * **Why not `schemaResolver` from the library.** It reads a schema through its Standard Schema face,
 * where an issue is a `message` and a `path` — the bound that produced it is gone by then. A message
 * with a number in it therefore has to state that number a second time in the catalogue, in both
 * languages, free to disagree with the schema forever: eight sentences in this tree did. Zod's
 * own `safeParse` keeps `maximum` / `minimum` on the issue, which is the whole reason this file
 * exists rather than a `translate` wrapper around the library's resolver.
 *
 * Behaviour is otherwise the library's, deliberately: paths joined with `.` so `owner.email` and
 * `skills.0` address what Mantine addresses, and the **first** issue per path wins, so a field with
 * two failed checks shows the one the schema declared first rather than the last.
 *
 * The answer is not text. `SharedLib.translateFormIssues` turns it into text, and a form calls the
 * two together — `packages/client/test/architecture/form-issue-translation.test.ts` is what keeps
 * the next form from calling only the first half and printing `validation.required` under a field.
 */
export const zodFormResolver =
  (schema: ZodType) =>
  (values: unknown): Record<string, FormIssue> => {
    const result = schema.safeParse(values);

    if (result.success) return {};

    const issues: Record<string, FormIssue> = {};

    for (const issue of result.error.issues) {
      const path = issue.path.join('.');

      if (path in issues) continue;

      const carried = issueValues(issue);

      issues[path] =
        carried === undefined ? { key: issue.message } : { key: issue.message, values: carried };
    }

    return issues;
  };
