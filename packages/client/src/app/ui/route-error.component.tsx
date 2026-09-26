import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { IamLib } from '@units/iam';

import { RouteForbidden } from './route-forbidden.component.js';

/**
 * The route-level error boundary — the first of the three levels
 * (`rules/errors-and-toasts.mdc` §13).
 *
 * The retry is what makes it an error *state* rather than a dead end: the router re-runs
 * `beforeLoad` and the loader and the route mounts again, which is the difference between «try
 * again» and «reload the page and lose what you were doing».
 *
 * **It is `router.invalidate()`, not the `reset` the boundary hands in.** `reset` only clears the
 * boundary's own state; the match underneath stays in `error`, renders, throws the same error and
 * lands here again — a button that does nothing. Nothing noticed while no route loaded data: the
 * first loader (the project card, STORY-014-05) is what showed it, and
 * `test/routes/project-overview-screen.test.tsx` is where it is proved end to end. `invalidate`
 * reloads the matches and moves the router's `loadedAt`, which is the key the boundary resets on.
 *
 * **It is the page.** The boundary replaces the route's content, heading included, so it renders
 * `PageErrorState` — the page's `h1`, then the alert — rather than a bare `ErrorState`, which has no
 * heading because it normally sits under one. The route announcer moves focus to that heading after
 * a navigation, and the document title and the announcement name the failure, not the route
 * (`widgets/breadcrumbs/lib/route-crumbs.util.ts`).
 *
 * Every retry, successful or not, replaces the pressed button: the router resets the boundary on
 * each load, so a second failure is a new alert — which is what a screen reader announces — and
 * the route announcer puts focus on the heading of whichever page took its place
 * (`widgets/route-announcer`), rather than leaving it on `<body>`.
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
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();

  if (IamLib.isPermissionDenied(error)) return <RouteForbidden permission={error.permission} />;

  return (
    <SharedUi.PageErrorState messageKey="errors.route.failed" onRetry={() => router.invalidate()} />
  );
}
