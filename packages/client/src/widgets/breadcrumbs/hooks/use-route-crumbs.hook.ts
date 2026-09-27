import { useMatches } from '@tanstack/react-router';

import { ProjectLib, ProjectService } from '@units/project';
import { routeCrumbs, type RouteCrumb } from '@widgets/breadcrumbs/lib';

/**
 * The trail of the page on screen, with the pages named by their data given their names — the one
 * source of the breadcrumbs, the document title and the route announcement, so the three cannot
 * disagree.
 *
 * Today one page is named by its data: a project, «KEY · Name» (STORY-014-06, acceptance 8). The
 * name is the card the project layout's guard already put in the cache — read, never fetched — and
 * it goes to the layout's crumb by route id. Joining a unit's answer to the route tree is what a
 * widget is for; the pure rules — stand-in screens, which crumb is current — stay in `lib`.
 *
 * **The cache is read only once the layout has settled.** Reading it subscribes an observer to the
 * card's entry, and this hook lives in the route announcer, which the root route mounts under
 * `StrictMode` — subscribe, unsubscribe, subscribe. An observer that leaves a query while the
 * guard's request is in flight, as its last observer, makes TanStack Query cancel that request (or
 * its pending retry): the guard's `ensureQueryData` rejects, and a failed load never reaches its
 * error screen. Measured, not guessed — `test/routes/project-overview-screen.test.tsx`, the two
 * failed-load cases, go red with the observer attached while pending. Until the layout succeeds
 * the page has no name to give anyway: while it loads the crumb is the route's key, and a refusal
 * or a failure is named by its stand-in screen.
 */
export const useRouteCrumbs = (): RouteCrumb[] => {
  const matches = useMatches();
  const settled = matches.filter(
    (match) => match.routeId === ProjectLib.PROJECT_LAYOUT_ROUTE_ID && match.status === 'success',
  );
  const title = ProjectService.ProjectHooks.useProjectTitle(
    ProjectLib.projectLocation(settled).projectId,
  );

  return routeCrumbs(
    matches,
    title === null ? {} : { [ProjectLib.PROJECT_LAYOUT_ROUTE_ID]: title },
  );
};
