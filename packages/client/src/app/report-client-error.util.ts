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
 * **The route is a template, and that sentence used to be false.** Until 2026-08-28 this sent
 * `globalThis.location.pathname` — the address, not the template — while the paragraph above
 * claimed otherwise. Two routes of this product carry a credential in the path
 * (`/reset-password/$token`, `/invite/$token`), and this function is wired into
 * `QueryCache.onError`, so a reset that failed on an expired token reported that token to a server
 * which writes `route` into the application log. `rules/observability.mdc` forbids precisely that:
 * the URL of a link that *is* a credential must not be logged at any level.
 *
 * The template comes from the router, the only thing that knows it. When nothing is matched — before
 * the router mounts, or in a test rendering one component — the answer is `unmatched`, never the
 * pathname: a fallback that reaches for the address would reopen the hole on exactly the paths where
 * the router has not settled yet.
 *
 * **A failure to report is not a failure to handle.** The request is deliberately not awaited and
 * its rejection is swallowed: an unreachable server, a 429 from the limiter or an offline tab must
 * not turn one broken component into a second error, and re-reporting a failed report is how a loop
 * starts.
 */
/** Where the route template comes from. Injected so this module knows nothing about the router. */
export interface ClientErrorContext {
  /** The template of the deepest matched route, or `undefined` when nothing is matched yet. */
  readonly routeTemplate: () => string | undefined;
}

/**
 * The template source used when none is supplied.
 *
 * Set once by `app/router.tsx` at composition time. A module-level slot rather than a parameter on
 * every call site, because the callers are `QueryCache.onError`, a global `error` listener and an
 * error boundary — none of which is in a position to hold the router.
 */
let context: ClientErrorContext = { routeTemplate: () => undefined };

export const setClientErrorContext = (next: ClientErrorContext): void => {
  context = next;
};

export const reportClientError = (
  error: unknown,
  reference?: string,
  override?: ClientErrorContext,
): void => {
  console.error('[bad-crm]', error);

  void SharedApi.sendClientErrorReport({
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    appVersion: APP_VERSION,
    route: (override ?? context).routeTemplate() ?? 'unmatched',
    reference: reference ?? 'unreferenced',
  }).catch(() => undefined);
};
