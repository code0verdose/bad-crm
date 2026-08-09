import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { EmployeeService, type EmployeeApi } from '@units/employee';
import { IamService } from '@units/iam';
import { TeamLib, TeamService, TeamUi } from '@units/team';

import { rosterRows } from './lib/roster-rows.util.js';
import { teamCandidates } from './lib/team-candidates.util.js';
import { AddTeamMemberForm } from './ui/add-team-member-form.component.js';
import { TeamDeleteDialog } from './ui/team-delete-dialog.component.js';
import { TeamMemberTable } from './ui/team-member-table.component.js';

export interface TeamDetailProps {
  readonly teamId: string;
  /** Where to go once the team is disbanded — this screen is about something that stopped existing. */
  readonly onDeleted: () => void;
}

/**
 * The directory page this screen joins against, spelled once.
 *
 * Unpaged in effect: a hundred rows is the contract's maximum and the product's own size is five to
 * fifty people, so the first page is the organization. It is the largest page rather than a search,
 * because the answer serves two purposes at once — labelling the roster and offering the people who
 * are not on it — and a picker that could only find somebody by typing their name first would be a
 * picker for people you already know are there.
 */
const DIRECTORY: EmployeeApi.EmployeeListParams = {
  q: '',
  status: [],
  role: [],
  team: [],
  sort: 'name',
  page: 1,
  perPage: 100,
};

/** Rows of the skeleton, so the page does not jump when the roster arrives. */
const SKELETON_ROWS = 6;

/**
 * One team: what it is, who is on it, and the three things one can do about it.
 *
 * The composition point (`rules/frontend-fsd.mdc` rule 7). Two decisions belong to it rather than to
 * anything it renders:
 *
 * **What a control needs, not only who may use it.** Every affordance here is behind a permission —
 * a hint, never a gate, since the endpoint refuses on its own authority. But a permission is not
 * enough to draw a control: the disband dialog cannot name a team the page has not got, and the
 * picker cannot offer people the reader may not be told about. So each is drawn from the permission
 * **and** the data it needs, which is the reasoning `pages/employee-profile/page.tsx` arrived at and
 * the same failure it avoids — a control that is clickable while the document is on its way, and for
 * ever if it never comes.
 *
 * **The names come from a different permission than the roster.** `GET /teams/{teamId}` answers with
 * user ids and no names on purpose, so this screen asks the directory itself — and only when it may.
 * Without `user:read` there is no second request at all, and the roster shows ids: a request certain
 * to be refused is not a fallback, it is a 403 per page view.
 */
export function TeamDetail({ teamId, onDeleted }: TeamDetailProps) {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const team = TeamService.TeamQueries.useTeamDetailQuery(teamId);
  const mayReadPeople = can('user:read');
  const people = EmployeeService.EmployeeQueries.useEmployeeListQuery(DIRECTORY, mayReadPeople);
  const save = TeamService.TeamMutations.useUpdateTeam();
  const addMember = TeamService.TeamMutations.useAddTeamMember();
  const removeMember = TeamService.TeamMutations.useRemoveTeamMember();
  const [disbandOpened, disbandControls] = useDisclosure(false);

  const directory = people.data?.items ?? [];
  const members = team.data?.members ?? [];
  const mayManageMembers = can('team:manage_members') && people.data !== undefined;
  const mayRename = can('team:update');
  const mayDisband = can('team:delete');

  return (
    <SharedUi.DataState
      errorMessageKey="teams.detail.failed"
      onRetry={() => {
        void team.refetch();
      }}
      skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
      status={statusOf(team)}
    >
      {team.data === undefined ? null : (
        <Stack gap="md">
          <Group align="center" gap="sm" wrap="wrap">
            <Title order={2}>{team.data.name}</Title>
            <Badge variant="light">{team.data.slug}</Badge>
          </Group>
          {team.data.description !== null && <Text>{team.data.description}</Text>}

          <TeamUi.TeamAccessNotice />

          <SharedUi.Section
            descriptionKey="teams.members.description"
            titleKey="teams.members.title"
          >
            {mayManageMembers && (
              <AddTeamMemberForm
                candidates={teamCandidates(directory, members)}
                isPending={addMember.isPending}
                onAdd={(userId, teamRole) => {
                  addMember.mutate({ teamId, userId, teamRole });
                }}
              />
            )}
            {/*
              Two spreads rather than one object with `undefined` in it: under
              `exactOptionalPropertyTypes` an explicit `undefined` is not the same as «no property».
              The wait belongs to the row whose control was pressed, which is what the mutation's own
              `variables` say and a shared boolean cannot.
            */}
            <TeamMemberTable
              rows={rosterRows(members, directory)}
              {...(mayManageMembers
                ? {
                    onRemove: (userId: string) => {
                      removeMember.mutate({ teamId, userId });
                    },
                  }
                : {})}
              {...(removeMember.isPending ? { removingUserId: removeMember.variables.userId } : {})}
            />
          </SharedUi.Section>

          {mayRename && (
            <SharedUi.Section descriptionKey="teams.edit.description" titleKey="teams.edit.title">
              <TeamUi.TeamForm
                initialValues={{
                  name: team.data.name,
                  slug: team.data.slug,
                  description: team.data.description ?? '',
                }}
                isPending={save.isPending}
                onSubmit={(values) => {
                  save.mutate({ teamId, draft: TeamLib.toTeamDraft(values) });
                }}
                submitLabelKey="teams.edit.submit"
              />
            </SharedUi.Section>
          )}

          {mayDisband && (
            <SharedUi.Section
              descriptionKey="teams.danger.description"
              titleKey="teams.danger.title"
            >
              <Group>
                <Button color="red" onClick={disbandControls.open} variant="light">
                  {t('teams.delete.action')}
                </Button>
              </Group>
              <TeamDeleteDialog
                onClose={disbandControls.close}
                onDeleted={onDeleted}
                opened={disbandOpened}
                teamId={teamId}
                teamName={team.data.name}
              />
            </SharedUi.Section>
          )}
        </Stack>
      )}
    </SharedUi.DataState>
  );
}

/**
 * The three states `DataState` knows, from the two booleans a query reports.
 *
 * `isPending` rather than `isFetching`: a background refetch — the one a membership change triggers
 * — keeps the roster on screen, and a skeleton over rows that are already there is a flash after
 * every single click.
 */
const statusOf = (query: {
  readonly isPending: boolean;
  readonly isError: boolean;
}): 'pending' | 'error' | 'success' => {
  if (query.isError) return 'error';

  return query.isPending ? 'pending' : 'success';
};
