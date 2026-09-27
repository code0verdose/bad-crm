/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { ProjectLayout } from '@pages/project';
import { IamService } from '@units/iam';
import { ProjectService } from '@units/project';
import { ProjectNotFound, RouteError, RoutePending } from '@app/ui';

const requireProjectRead = IamService.IamGuards.requirePermission({
  permission: 'project:read',
  // A project is the closed contour: somebody else's project must be indistinguishable from an
  // address that never existed (`ux-architecture.md` → «403 vs 404», invariant 2 of CLAUDE.md).
  whenDenied: 'not-found',
});

/**
 * `/projects/$projectId` — the layout of a project card; wiring only (`rules/frontend-fsd.mdc`
 * rule 10, STORY-014-05 acceptances 1–3).
 *
 * `beforeLoad` runs **before** any loader and any render of this route and of its children, which
 * is what acceptance 2 asks for: first the capability (`project:read`, no request if it is missing),
 * then the resource — the server's answer to «may this caller see this project», read into the
 * query cache. A `404` or `403` becomes the not-found screen, and nothing under the layout runs.
 *
 * The `loader` then asks the cache for the same entry and finds it; the components read it with
 * `useSuspenseQuery`, so a navigation is one request (acceptance 3). It stays a loader, rather than
 * leaning on the guard alone, so that the data dependency of the route is stated where the router
 * looks for it — `defaultPreload: 'intent'` preloads through it.
 *
 * All three boundaries are named here rather than inherited, because this route loads data
 * (`test/architecture/route-state-conventions.test.ts`). The not-found one is the project's own:
 * its way out is the list of projects, not the dashboard (STORY-014-05, acceptance 8).
 */
export const Route = createFileRoute('/_authenticated/projects/$projectId')({
  beforeLoad: async (args) => {
    await requireProjectRead(args);
    await ProjectService.ProjectGuards.requireProjectAccess(args);
  },
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      ProjectService.ProjectQueries.projectDetailQueryOptions(params.projectId),
    ),
  component: ProjectLayout,
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  notFoundComponent: ProjectNotFound,
  staticData: { crumbKey: 'projects.detail.title' },
});
