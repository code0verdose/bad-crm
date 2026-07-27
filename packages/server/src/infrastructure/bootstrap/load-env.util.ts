import { EnvValidationError, toEnvIssues } from './env.errors.js';
import { serverEnvSchema, type ServerEnv } from './env.schema.js';

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
 */
export const loadEnv = (
  // eslint-disable-next-line no-restricted-properties -- the single sanctioned read of process.env
  source: Record<string, string | undefined> = process.env,
): ServerEnv => {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(toEnvIssues(result.error));
  }

  return result.data;
};
