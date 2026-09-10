import { loadEnv } from '../src/infrastructure/bootstrap/load-env.util.js';
import { type ServerEnv } from '../src/infrastructure/bootstrap/env.schema.js';

/**
 * What every maintenance command under `scripts/` does at its door and at its exit, in one place.
 *
 * Both halves used to be wrong the same way in two commands. `loadEnv` sat outside the `try`, so
 * `AUDIT_RETENTION_MONTHS=6` printed a stack trace and exited with `1` — the code the runbook
 * reads as «something was refused or timed out, look at the report» — when it was a configuration
 * error and the runbook's `2`. And a run over `DATABASE_URL` instead of `DATABASE_MIGRATION_URL`
 * said `must be owner of table audit_logs` and nothing about which variable would fix it.
 */

export type ScriptEnv =
  { readonly ok: true; readonly env: ServerEnv } | { readonly ok: false; readonly message: string };

/**
 * The environment, or the one line the operator should read instead of a stack.
 *
 * `loadEnv` throws `EnvValidationError` with every invalid variable in its message; the message is
 * the whole of what an operator needs, and the trace behind it is noise that hides the variable.
 */
export const readScriptEnv = (
  command: string,
  source: Record<string, string | undefined>,
): ScriptEnv => {
  try {
    return { ok: true, env: loadEnv(source) };
  } catch (error) {
    return {
      ok: false,
      message: `${command} could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * The hint for the one mistake with an obvious fix: the command ran as the application role.
 *
 * Matched on the sentence PostgreSQL uses for `insufficient_privilege` on DDL (`must be owner of
 * table …`), and only when the migration URL was not set — with it set, the owner check failed
 * for another reason (a role renamed, a restore that changed ownership) and naming the variable
 * would send the operator the wrong way.
 */
export const ownerRoleHint = (
  error: unknown,
  { migrationUrlSet }: { readonly migrationUrlSet: boolean },
): string | undefined => {
  if (migrationUrlSet || !(error instanceof Error) || !/must be owner/.test(error.message)) {
    return undefined;
  }

  return 'hint: set DATABASE_MIGRATION_URL (app_migrator) — this command runs DDL the application role does not own';
};
