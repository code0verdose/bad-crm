/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { ProjectsPage } from '@pages/projects';
import { IamService } from '@units/iam';
import { ProjectModel } from '@units/project';

/**
 * `/projects` — wiring only (`rules/frontend-fsd.mdc` rule 10; STORY-014-04).
 *
 * The search schema is the screen's state: a hand-edited URL falls back field by field inside the
 * schema instead of replacing the screen with the error boundary.
 *
 * The guard is the capability `project:read` — a courtesy, as every guard is: which projects the
 * reader sees is decided in SQL on the server. `forbidden` rather than `not-found`: the list is in
 * everybody's navigation, so its existence is no secret, unlike one project's.
 *
 * No loader: the data depends on the search, and the screen owns its first-load skeleton through
 * `DataState` — the directory's arrangement. Without a loader the route declares no boundaries of
 * its own and inherits the router's defaults.
 */
export const Route = createFileRoute('/_authenticated/projects/')({
  beforeLoad: IamService.IamGuards.requirePermission({
    permission: 'project:read',
    whenDenied: 'forbidden',
  }),
  validateSearch: ProjectModel.projectListSearchSchema,
  component: ProjectsPage,
  staticData: { crumbKey: 'projects.list.title' },
});
