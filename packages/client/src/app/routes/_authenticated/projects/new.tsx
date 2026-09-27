/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { ProjectNewPage } from '@pages/project-new';
import { IamService } from '@units/iam';

/**
 * `/projects/new` — creating a project; wiring only (`rules/frontend-fsd.mdc` rule 10,
 * STORY-014-01 acceptance 1).
 *
 * The guard is `project:create`, an organization capability: nothing about a project that does not
 * exist yet can be a resource ACL. A courtesy rather than security — `POST /projects` decides on its
 * own authority — and the refusal names what is missing, because creating projects is no secret
 * (`ux-architecture.md` → «403 vs 404»). A static segment, so it wins over `$projectId`.
 */
export const Route = createFileRoute('/_authenticated/projects/new')({
  beforeLoad: IamService.IamGuards.requirePermission({
    permission: 'project:create',
    whenDenied: 'forbidden',
  }),
  component: ProjectNewPage,
  staticData: { crumbKey: 'projects.create.title' },
});
