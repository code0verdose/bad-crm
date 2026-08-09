import { Stack } from '@mantine/core';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { TeamList } from '@widgets/team-list';
import { type TeamService } from '@units/team';

const route = getRouteApi('/_authenticated/admin/teams/');

/**
 * `/admin/teams` — composition only (`rules/frontend-fsd.mdc` rule 7).
 *
 * It reads the typed search of the route and hands it, with a way to write it back, to the widget.
 * The filter logic — the pause before a keystroke becomes a URL, the page reset, which change counts
 * as a filter at all — lives in the unit's hook, and the URL is the only state there is.
 */
export function AdminTeamsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();

  /**
   * The router's `navigate`, narrowed to what the unit needs.
   *
   * Wrapped rather than passed through, because `units/` must not depend on the generated route tree
   * — it lives two layers above. The wrapper is also what makes the hook testable without a router.
   */
  const write = useCallback<TeamService.TeamHooks.SearchNavigation>(
    (input) => {
      void navigate({ search: input.search, replace: input.replace });
    },
    [navigate],
  );

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="teams.title" />

      <TeamList navigate={write} search={search} />
    </Stack>
  );
}
