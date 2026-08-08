/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { DashboardPage } from '@pages/dashboard';
import { DashboardModel } from '@units/dashboard';

/**
 * `/dashboard` — the first screen behind the guard.
 *
 * The route file stays wiring only (`rules/frontend-fsd.mdc` rule 10): which schema validates the
 * URL, which component renders, what the breadcrumb says. The screen itself is a page, and the data
 * behind it will be a unit hook — neither is imported by the router, and both can change without
 * touching this file.
 */
export const Route = createFileRoute('/_authenticated/dashboard')({
  validateSearch: DashboardModel.dashboardSearchSchema,
  component: DashboardPage,
  staticData: { crumbKey: 'nav.dashboard' },
});
