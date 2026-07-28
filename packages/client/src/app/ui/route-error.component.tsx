import { type ErrorComponentProps } from '@tanstack/react-router';

import { SharedUi } from '@shared';

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
 */
export function RouteError({ reset }: ErrorComponentProps) {
  return <SharedUi.ErrorState messageKey="errors.route.failed" onRetry={reset} />;
}
