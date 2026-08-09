import { Stack } from '@mantine/core';
import { getRouteApi } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { TeamDetail } from '@widgets/team-detail';
import { TeamModel } from '@units/team';

const route = getRouteApi('/_authenticated/admin/teams/$teamId');

/**
 * `/admin/teams/$teamId` — one team, composition only.
 *
 * The heading is the generic «Команда» rather than the team's name, for the same reason the
 * personnel record's is: `PageHeader` takes an i18n **key**, and a page whose `h1` is a value from
 * the server is a page whose heading is missing while the request is in flight — and a breadcrumb
 * trail that disagrees with it. The name is the `h2` the widget renders, where it is data among
 * data.
 *
 * Where to go after the team is disbanded is decided here, because navigation is the router's and
 * the router belongs to `app`/`pages` — a widget that knew the route table would be a widget bound
 * to one place in it.
 */
export function TeamDetailPage() {
  const { teamId } = route.useParams();
  const navigate = route.useNavigate();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="teams.detail.title" />

      <TeamDetail
        onDeleted={() => {
          // The list's own defaults rather than a hand-written `{ q: '', sort: 'name', page: 1 }`:
          // the target route validates its search, so the destination has to carry one — and a
          // second copy of the defaults here would be the first thing to drift from the schema.
          void navigate({ to: '/admin/teams', search: TeamModel.teamListSearchSchema.parse({}) });
        }}
        teamId={teamId}
      />
    </Stack>
  );
}
