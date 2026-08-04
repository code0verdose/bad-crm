import { Stack } from '@mantine/core';
import { getRouteApi } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { DashboardModel } from '@units/dashboard';
import { AppStatus } from '@widgets/app-status';
import { Breadcrumbs } from '@widgets/breadcrumbs';

/**
 * `getRouteApi`, not an import of the route file: a page may not import from `app/`
 * (`rules/frontend-fsd.mdc` rule 1), and this gives the same typed `useSearch` through the
 * registered route tree instead of through a dependency pointing the wrong way.
 */
const route = getRouteApi('/_authenticated/dashboard');

/**
 * Composition only (`rules/frontend-fsd.mdc` rule 7): the header, and the widgets that fill the
 * page. No query, no mapping, no conditional beyond which widget appears.
 *
 * The real dashboard — one code path for all three roles — is EPIC-024. What has to survive from
 * here is the shape: search parameters read from the URL, a single `h1` in `PageHeader`, widgets
 * doing the work.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { range, scope } = route.useSearch();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="nav.dashboard" />
      <AppStatus />
      <output aria-live="polite">
        {/*
          The selected window and scope, as the URL carries them — proof the schema round-trips.
          Through the catalogue, not as raw values: `7d · me` is a string assembled at runtime, which
          is exactly what the lint rule cannot see and what the pseudo locale found.
        */}
        {`${t(DashboardModel.DASHBOARD_RANGE_LABEL_KEY[range])} · ${t(DashboardModel.DASHBOARD_SCOPE_LABEL_KEY[scope])}`}
      </output>
    </Stack>
  );
}
