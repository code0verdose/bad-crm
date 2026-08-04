import { SharedApi } from '@shared';

/**
 * Where a failure goes that the user is not shown — and every failure the user *is* shown, too.
 *
 * The data layer takes this as `logError` and calls it for every query and mutation error
 * (`shared/api/query-client.config.ts`), because a toast is not a record: it disappears, it carries
 * a translation key rather than a stack, and nobody can read it after the fact.
 *
 * **The console stays.** A developer with the tab open wants the real object, expandable, with the
 * source map applied — not a summary. The request is the half that reaches the team.
 *
 * **What is sent is only what the contract declares** (`ClientErrorReport` in
 * `docs/api/openapi.yaml`): message, stack, build, route template, reference. No field values, no
 * token, no identifier of a person or an organization. The report is built from the error object
 * rather than from anything the user typed, which is what makes that claim structural rather than a
 * promise to be careful.
 *
 * **A failure to report is not a failure to handle.** The request is deliberately not awaited and
 * its rejection is swallowed: an unreachable server, a 429 from the limiter or an offline tab must
 * not turn one broken component into a second error, and re-reporting a failed report is how a loop
 * starts.
 */
export const reportClientError = (error: unknown, reference?: string): void => {
  console.error('[bad-crm]', error);

  void SharedApi.sendClientErrorReport({
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    appVersion: APP_VERSION,
    route: globalThis.location.pathname,
    reference: reference ?? 'unreferenced',
  }).catch(() => undefined);
};
