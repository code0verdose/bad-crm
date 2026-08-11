/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { EmployeeProfilePage } from '@pages/employee-profile';
import { IamModel } from '@units/iam';

/**
 * `/admin/members/$userId` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * **No permission guard, and STORY-011-11 does not add one.** A person always reads their own
 * personnel record, and the endpoint behind this screen is self-service for exactly that reason;
 * how much of the record comes back — and whether this caller may edit any of it — is decided on
 * the server, per field. A guard here would either lock people out of their own profile or promise
 * an edit the API refuses. The permissions tab the story asks for is therefore gated **as a tab**:
 * it is absent without `permission:override_read`, its panel is never mounted for a caller without
 * that permission (`keepMounted={false}` in `pages/employee-profile/page.tsx`) so the query behind it
 * never starts, and `?tab=roles` from somebody without it falls back to the profile
 * (`pages/employee-profile/page.tsx`). The story's task list names
 * `beforeLoad: requirePermission('user:read')` here; that would take away every person's own record
 * and is the one line of it that is not implemented — see «Что отложено» in the story.
 *
 * The search schema is the tab's state — which face is open, and how the catalogue is narrowed —
 * validated here so a hand-edited URL cannot reach a component. Each field falls back to its
 * default inside the schema rather than replacing the screen with an error boundary over a mistyped
 * query string.
 */
export const Route = createFileRoute('/_authenticated/admin/members/$userId')({
  validateSearch: IamModel.userPermissionsSearchSchema,
  component: EmployeeProfilePage,
  staticData: { crumbKey: 'employee.title' },
});
