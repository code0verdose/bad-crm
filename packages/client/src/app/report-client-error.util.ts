/**
 * Where a failure goes that the user is not shown — and every failure the user *is* shown, too.
 *
 * The data layer takes this as `logError` and calls it for every query and mutation error
 * (`shared/api/query-client.config.ts`), because a toast is not a record: it disappears, it carries
 * a translation key rather than a stack, and nobody can read it after the fact.
 *
 * The console is the sink until telemetry exists: `POST /api/v1/telemetry/client-error`
 * (`docs/architecture/stack.md`) is not in `docs/api/openapi.yaml` yet, and inventing the request
 * here would mean writing a client for a contract that has not been agreed. What must not change
 * when it lands is the call site — one function, called from one place.
 */
export const reportClientError = (error: unknown): void => {
  console.error('[bad-crm]', error);
};
