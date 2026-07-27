import { EnvValidationError, toEnvIssues, type EnvIssue } from './env.errors.js';
import {
  crossFieldEnvIssues,
  parseKnownEnvFields,
  serverEnvSchema,
  type ServerEnv,
} from './env.schema.js';

/** Same variable and same sentence twice is noise; the two passes legitimately overlap. */
const withoutDuplicates = (issues: readonly EnvIssue[]): EnvIssue[] => {
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.variable}: ${issue.message}`;

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
};

/**
 * The one place in `packages/server/src/**` that is allowed to read `process.env`; ESLint rejects
 * it everywhere else. Reading the environment from all over the codebase is how a variable ends up
 * used but absent from both the schema and `.env.example`.
 *
 * `parse`, not `safeParse`, on purpose (rules/zod-validation.mdc, rule 4): a broken configuration
 * has no sensible degraded behaviour, so the process refuses to start. The caller — `main.ts` —
 * logs the message and exits non-zero, before the HTTP port is opened.
 *
 * The source is an argument so tests can supply a configuration without mutating the real
 * environment, which would leak between test files running in the same worker.
 *
 * **Two passes, one list.** Zod skips an object-level check when a field failed fatally (a wrong
 * enum value, a failed coercion), so a single `safeParse` can report `PORT` and stay silent about a
 * plaintext `APP_URL` in production — the operator fixes one variable, restarts, and meets the next
 * one. The second pass re-runs the cross-field rules over the fields that did parse and merges the
 * result, so one start attempt yields the complete to-do list. For an installation that is brought
 * up once, that is the difference between five minutes and an afternoon.
 */
export const loadEnv = (
  // eslint-disable-next-line no-restricted-properties -- the single sanctioned read of process.env
  source: Record<string, string | undefined> = process.env,
): ServerEnv => {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(
      withoutDuplicates([
        ...toEnvIssues(result.error),
        ...crossFieldEnvIssues(parseKnownEnvFields(source)),
      ]),
    );
  }

  return result.data;
};
