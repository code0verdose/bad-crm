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

/**
 * `/admin/members/$userId` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * **No permission guard.** A person always reads their own personnel record, and the endpoint behind
 * this screen is self-service for exactly that reason; how much of the record comes back — and
 * whether this caller may edit any of it — is decided on the server, per field. A guard here would
 * either lock people out of their own profile or promise an edit the API refuses.
 */
export const Route = createFileRoute('/_authenticated/admin/members/$userId')({
  component: EmployeeProfilePage,
  staticData: { crumbKey: 'employee.title' },
});
