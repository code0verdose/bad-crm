/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { AdminTeamsPage } from '@pages/admin-teams';
import { IamService } from '@units/iam';
import { TeamModel } from '@units/team';

/**
 * `/admin/teams` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * The search schema is the screen's state, validated here so that a hand-edited URL cannot reach a
 * component: an order by a column nobody exposed, a page that is a word — each falls back to its
 * default inside the schema rather than replacing the screen with an error boundary over a mistyped
 * query string.
 *
 * The guard is `team:read` — a courtesy rather than security, as every guard is: the endpoint
 * authorises on its own authority, and what this buys is «this page is not for you» instead of a
 * page that renders and fills with 403s.
 */
export const Route = createFileRoute('/_authenticated/admin/teams/')({
  beforeLoad: IamService.IamGuards.requirePermission({
    permission: 'team:read',
    // `/admin/**` is in everybody's navigation, so its existence is no secret and the
    // refusal names what is missing (`ux-architecture.md` → «403 vs 404»).
    whenDenied: 'forbidden',
  }),
  validateSearch: TeamModel.teamListSearchSchema,
  component: AdminTeamsPage,
  staticData: { crumbKey: 'teams.title' },
});
