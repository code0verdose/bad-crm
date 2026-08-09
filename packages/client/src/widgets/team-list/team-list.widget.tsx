import { Button, Group, Stack } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { IamService } from '@units/iam';
import { TeamService, TeamUi, type TeamModel } from '@units/team';

import { TeamCreateDialog } from './ui/team-create-dialog.component.js';
import { TeamFiltersBar } from './ui/team-filters-bar.component.js';
import { TeamTable } from './ui/team-table.component.js';
import classes from './team-list.module.css';

export interface TeamListProps {
  readonly search: TeamModel.TeamListSearch;
  readonly navigate: TeamService.TeamHooks.SearchNavigation;
}

/** How many rows the skeleton draws, so the page does not jump when the real ones arrive. */
const SKELETON_ROWS = 6;

/**
 * The org structure: every live team, narrowed by what the address bar says.
 *
 * The composition point (`rules/frontend-fsd.mdc` rule 7) — it asks the unit for the page through one
 * hook and hands it to presentational components. What it decides on its own is only which controls
 * exist:
 *
 *   * **the create control is behind `team:create`** — a hint, never a gate. The endpoint refuses on
 *     its own authority; what the check prevents is offering an action that always answers 403
 *     (`ux-architecture.md`, принцип 6). Unlike the destructive controls on the detail screen it
 *     needs no loaded document to work, so the permission is the whole condition;
 *   * **the notice that a team grants nothing** is not conditional at all. It is true for every
 *     reader, and it corrects a belief that forms from looking at the screen.
 *
 * The two empty states are different sentences on purpose (`rules/lists-and-filters.mdc` §12): a
 * filter that matched nothing is offered a wider filter, an organization with no teams is offered a
 * first one. Telling somebody to create their first team while a search box holds «legal» is the
 * interface misreading its own state.
 */
export function TeamList({ search, navigate }: TeamListProps) {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const directory = TeamService.TeamHooks.useTeamList(search, navigate);
  const mayCreate = can('team:create');
  const [createOpened, createControls] = useDisclosure(false);
  const { filters, page } = directory;

  return (
    <Stack gap="md">
      <TeamUi.TeamAccessNotice />

      <Group align="flex-end" justify="space-between" wrap="wrap">
        <TeamFiltersBar filters={filters} />
        {mayCreate && <Button onClick={createControls.open}>{t('teams.create.action')}</Button>}
      </Group>

      {filters.isFiltered && (
        <Group>
          <Button onClick={filters.reset} size="compact-sm" variant="subtle">
            {t('teams.filters.reset')}
          </Button>
        </Group>
      )}

      <TeamCreateDialog onClose={createControls.close} opened={createOpened} />

      <SharedUi.DataState
        empty={
          <SharedUi.EmptyState
            descriptionKey={filters.isFiltered ? 'teams.empty.filtered' : 'teams.empty.description'}
            titleKey="teams.empty.title"
          />
        }
        errorMessageKey="teams.list.failed"
        isEmpty={page.total === 0}
        onRetry={directory.refetch}
        skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
        status={directory.status}
      >
        <div className={classes['scroller']}>
          <TeamTable items={page.items} />
        </div>
        <SharedUi.PaginationBar
          onPageChange={filters.setPage}
          page={page.page}
          perPage={directory.perPage}
          total={page.total}
        />
      </SharedUi.DataState>
    </Stack>
  );
}
