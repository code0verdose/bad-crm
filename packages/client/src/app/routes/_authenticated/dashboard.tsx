import { createFileRoute } from '@tanstack/react-router';

import { DashboardPage } from '@pages';

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
