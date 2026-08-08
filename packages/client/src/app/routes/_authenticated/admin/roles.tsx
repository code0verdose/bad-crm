/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { AdminRolesPage } from '@pages/admin-roles';
import { IamModel, IamService } from '@units/iam';

/**
 * `/admin/roles` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * The search schema is the screen's state, validated here so that a hand-edited URL cannot reach a
 * component: an unknown domain in `collapsed`, a `diff` that is not a boolean, a search string
 * somebody pasted an essay into — each falls back to its default inside the schema rather than being
 * defended against downstream, and rather than replacing the screen with an error boundary over a
 * mistyped query string.
 */
export const Route = createFileRoute('/_authenticated/admin/roles')({
  beforeLoad: IamService.IamGuards.requirePermission('role:read'),
  validateSearch: IamModel.rolesSearchSchema,
  component: AdminRolesPage,
  staticData: { crumbKey: 'roles.title' },
});
