import { type ErrorComponentProps } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { IamLib } from '@units/iam';

import { RouteForbidden } from './route-forbidden.component.js';

/**
 * The route-level error boundary — the first of the three levels
 * (`rules/errors-and-toasts.mdc` §13).
 *
 * `reset` is what makes it an error *state* rather than a dead end: the router re-runs the loader
 * and the route mounts again, which is the difference between «try again» and «reload the page and
 * lose what you were doing».
 *
 * The text is a key, and a generic one: the error object here is whatever the loader threw, and
 * turning it into a sentence for the user is the job of the layer that knew what it was asking for
 * (`rules/errors-and-toasts.mdc` §10). The details go to the log through the query client.
 *
 * **The one error that is not a failure.** A permission guard refusing an open section throws
 * `PermissionDeniedError`, and it arrives here because that is where an ordinary error thrown in
 * `beforeLoad` goes — deliberately, since the router's own `notFound()` would be taken by
 * `notFoundComponent`, the screen that has to stay indistinguishable from «no such address» for the
 * closed contour (`ux-architecture.md` → «403 vs 404»). Routing it here rather than declaring an
 * `errorComponent` on each admin route is what makes the behaviour arrive with the guard: the next
 * section to be guarded gets the right screen without anybody remembering to wire one.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  if (IamLib.isPermissionDenied(error)) return <RouteForbidden permission={error.permission} />;

  return <SharedUi.ErrorState messageKey="errors.route.failed" onRetry={reset} />;
}
