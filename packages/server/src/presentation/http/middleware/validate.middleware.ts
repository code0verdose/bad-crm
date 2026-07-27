import { type ValidationIssue } from '@bad-crm/shared/errors';
import { type Request, type RequestHandler, type Response } from 'express';
import { type ZodType, type z } from 'zod';

import { ValidationError } from '@/domain/shared/errors/app.errors.js';
import { toValidationIssues } from '@/presentation/http/validators/zod-issues.util.js';

/** The three request sources a schema may be declared for. Headers get their own middleware. */
export interface RequestSchemas {
  readonly params?: ZodType;
  readonly query?: ZodType;
  readonly body?: ZodType;
}

/**
 * What the controller receives: the **output** type of each schema that was declared, and `never`
 * for the sources that were not.
 *
 * `z.output` rather than `z.input` on purpose — after a `z.coerce` or a `.transform` the two differ,
 * and the controller sees what came out. Declaring a source it did not validate as `never` makes
 * reading an unvalidated source a compile error instead of `undefined` at runtime.
 */
export type ValidatedInput<S extends RequestSchemas> = {
  readonly [K in keyof RequestSchemas]-?: S[K] extends ZodType ? z.output<S[K]> : never;
};

export interface RequestValidator<S extends RequestSchemas> {
  /** Mount before the controller; rejects with `ValidationError`, otherwise fills `res.locals`. */
  readonly handler: RequestHandler;
  /** Reads back what `handler` parsed, typed from the schemas. */
  readonly read: (response: Response) => ValidatedInput<S>;
}

/**
 * Where the parsed request lives between the middleware and the controller.
 *
 * `res.locals`, and not the 4.x habit of writing the parsed value back over the request's own
 * `query` property: in Express 5 that property is a getter and assigning to it throws — which is
 * why `test/unit/architecture/express-conventions.test.ts` bans the pattern outright. A symbol key
 * keeps the slot from colliding with anything else that writes to `locals`.
 */
const VALIDATED = Symbol.for('bad-crm.validated-request');

type ValidatedLocals = Record<symbol, unknown>;

const sourceOf = (request: Request, source: keyof RequestSchemas): unknown => {
  if (source === 'params') return request.params;
  if (source === 'query') return request.query;

  return request.body;
};

/**
 * Zod schemas for `params`, `query` and `body`, as one middleware (stack.md, «Валидация входа»).
 *
 * Three properties are the reason this exists as a shared middleware rather than as a `parse` call
 * at the top of every controller:
 *
 * 1. **`safeParse`, and every source parsed even after one fails.** A caller with a bad path
 *    parameter *and* a bad body gets both in one response; failing at the first schema would turn
 *    a single fix into three round trips. `parse` is not used here at all — invalid input is the
 *    expected case at a public boundary, not an exceptional one (rules/zod-validation.mdc, §4).
 * 2. **One validation, at the boundary.** What reaches the controller is the schema's *output*:
 *    `page` is a number, `enabled` is a boolean, defaults are applied. Nothing inside re-checks,
 *    which is the whole point of validating at the edge (§3).
 * 3. **No message text.** The rejected fields travel as `path` + `code`; the client owns the
 *    wording and the language (§9, ADR-0019). A server that returned a sentence would have to know
 *    the user's locale, and would hard-code a copy change into a release.
 */
export const validate = <S extends RequestSchemas>(schemas: S): RequestValidator<S> => ({
  handler: (request, response, next) => {
    const parsed: Record<string, unknown> = {};
    const issues: ValidationIssue[] = [];

    for (const source of ['params', 'query', 'body'] as const) {
      const schema = schemas[source];

      if (schema === undefined) continue;

      const result = schema.safeParse(sourceOf(request, source));

      if (result.success) parsed[source] = result.data;
      else issues.push(...toValidationIssues(result.error));
    }

    if (issues.length > 0) {
      next(new ValidationError(issues));

      return;
    }

    (response.locals as ValidatedLocals)[VALIDATED] = parsed;
    next();
  },

  read: (response) => (response.locals as ValidatedLocals)[VALIDATED] as ValidatedInput<S>,
});
