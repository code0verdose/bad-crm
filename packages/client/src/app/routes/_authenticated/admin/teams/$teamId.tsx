/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { TeamDetailPage } from '@pages/team-detail';
import { IamService } from '@units/iam';

/**
 * `/admin/teams/$teamId` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * The guard is `team:read`, the same as the list: unlike the personnel record next door, a team is
 * nobody's own page — there is no self-service reading of a roster, so there is no reason to let
 * somebody without the permission reach it and be refused per request.
 *
 * A team of another organization, and one that has been disbanded, is `404` from the server rather
 * than 403 — confirming that an id once named a team would be a fact about data the caller cannot
 * see. The screen shows that as its error state, which is why there is nothing to arrange here.
 */
export const Route = createFileRoute('/_authenticated/admin/teams/$teamId')({
  beforeLoad: IamService.IamGuards.requirePermission('team:read'),
  component: TeamDetailPage,
  staticData: { crumbKey: 'teams.detail.title' },
});
