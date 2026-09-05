import type { ReactNode } from 'react';

import { isFormIssue, type CountValues } from './zod-form-resolver.util.js';

/**
 * What `@mantine/form` hands a component for a failed field: whatever the resolver returned, per
 * path. Declared here rather than imported so this file stays free of the form library — it is a
 * function over a record, and typing it as one keeps `shared/lib` framework-free
 * (`rules/frontend-fsd.mdc` rule 8).
 */
export type FormIssues = Record<string, unknown>;

/**
 * `t` as this file needs it: a key, and the values the sentence has places for.
 *
 * The second argument is **required and possibly empty** rather than optional, which is a
 * concession to a type rather than a design choice: under `exactOptionalPropertyTypes` i18next's
 * own `t` refuses to be assigned to a signature whose options may be `undefined`, so an issue with
 * no bound is handed `{}`. i18next reads no interpolation out of it, which is what an issue without
 * a number means anyway.
 */
export type TranslateFormIssue = (key: string, values: Partial<CountValues>) => string;

/**
 * Turns the issues a Zod schema produced into the sentences a person reads.
 *
 * Every schema in this repository answers with a **key** rather than a sentence
 * (`rules/i18n.mdc` §1): `validation.email.invalid`, `auth.register.field.slugInvalid`. Mantine
 * renders what the resolver returns, verbatim, so this step is not optional — and since the
 * resolver answers with an *object* rather than a string, a form that skips it hands React an
 * object as a child and throws «Objects are not valid as a React child». That is a deliberate
 * improvement over the shape this replaced: a resolver answering with the bare key rendered
 * `validation.email.invalid` under the field and shipped, invisible to a suite running in `cimode`
 * where `t(key)` *is* the key. The failure is now loud, and
 * `test/architecture/form-issue-translation.test.ts` states the rule before anybody has to hit it.
 *
 * An issue also carries the numbers the failed check compared against (`SharedLib.zodFormResolver`),
 * so «at most {{count}} characters» interpolates the bound from the schema rather than restating it
 * in the catalogue. A bound that declared no key arrives here as Zod's own English in `key`, `t`
 * answers an unknown key with the key itself, and the sentence reaches the field unmarked — which is
 * exactly how `test/i18n/pseudo-locale.test.tsx` sees it.
 *
 * Only issues are touched. A resolver may legitimately answer with a node — an element with a link
 * in it — and passing that through `t` would stringify it.
 *
 * Nested paths (`owner.email`) arrive as flat keys of this record, so nothing has to walk a tree.
 */
export const translateFormIssues = (
  issues: FormIssues,
  translate: TranslateFormIssue,
): Record<string, ReactNode> =>
  Object.fromEntries(
    Object.entries(issues).map(([path, issue]) => [
      path,
      isFormIssue(issue) ? translate(issue.key, issue.values ?? {}) : issue,
    ]),
  ) as Record<string, ReactNode>;
