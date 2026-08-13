/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { AdminMembersInvitationsPage } from '@pages/admin-members-invitations';
import { IamService } from '@units/iam';

/**
 * `/admin/members/invitations` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * Guarded by `invitation:read`, which is the capability `GET /invitations` itself checks: a screen
 * gated on a permission the API does not check is a screen that can open and then refuse everything
 * on it. Re-issuing and revoking are two further capabilities, and their controls are hidden
 * without them — but nothing here depends on that, the endpoints refuse on their own authority.
 *
 * No `validateSearch`: the operation accepts no filter, no page and no order, so there is no state
 * for the URL to carry (`rules/lists-and-filters.mdc` applies to a list that has filters —
 * STORY-012-08, D3).
 */
export const Route = createFileRoute('/_authenticated/admin/members/invitations')({
  beforeLoad: IamService.IamGuards.requirePermission({
    permission: 'invitation:read',
    // `/admin/**` is in everybody's navigation, so its existence is no secret and the
    // refusal names what is missing (`ux-architecture.md` → «403 vs 404»).
    whenDenied: 'forbidden',
  }),
  component: AdminMembersInvitationsPage,
  staticData: { crumbKey: 'members.invitations.title' },
});
