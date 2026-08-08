/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { AdminMembersInvitePage } from '@pages/admin-members-invite';
import { IamService } from '@units/iam';

/**
 * `/admin/members/invite` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * Guarded by `invitation:create`, which is the capability the endpoint behind the button checks. The
 * screen used to be described in `ux-architecture.md` as guarded by `user:invite`; the two are
 * granted together by every system role, but a screen gated on a permission the API does not check
 * is a screen that can open and then refuse everything on it.
 */
export const Route = createFileRoute('/_authenticated/admin/members/invite')({
  beforeLoad: IamService.IamGuards.requirePermission('invitation:create'),
  component: AdminMembersInvitePage,
  staticData: { crumbKey: 'members.invite.title' },
});
