import { Button, Group, SegmentedControl, Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { EmployeeService, type EmployeeModel } from '@units/employee';
import { IamService } from '@units/iam';

import { MemberFiltersBar } from './ui/member-filters-bar.component.js';
import { MemberOrgChart } from './ui/member-org-chart.component.js';
import { MemberTable } from './ui/member-table.component.js';
import classes from './member-list.module.css';

export interface MemberListProps {
  readonly search: EmployeeModel.MemberListSearch;
  readonly navigate: EmployeeService.EmployeeHooks.SearchNavigation;
}

/** How many rows the skeleton draws, so the page does not jump when the real ones arrive. */
const SKELETON_ROWS = 8;

/**
 * The directory: the same people as a table and as a chart.
 *
 * The composition point (`rules/frontend-fsd.mdc` rule 7) — it asks the unit for the page and the
 * chart through one hook and hands both to presentational components. It decides nothing about
 * people: which rows come back, how much of each and whether the order asked for is allowed are all
 * answered by the server, and this renders the answer.
 *
 * **The chart is behind its own permission**, so the toggle appears only for somebody who holds it:
 * an option that always answers 403 is a dead end the reader has to walk into to discover
 * (`ux-architecture.md`, принцип 6). The guard is a hint — the endpoint refuses on its own authority.
 */
export function MemberList({ search, navigate }: MemberListProps) {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const maySeeChart = can('employee:view_org_chart');
  const showChart = search.view === 'chart' && maySeeChart;
  const directory = EmployeeService.EmployeeHooks.useEmployeeDirectory(search, navigate, showChart);
  const { filters, page } = directory;

  return (
    <Stack gap="md">
      <Group align="flex-start" justify="space-between" wrap="wrap">
        <MemberFiltersBar facets={page?.facets} filters={filters} />
        {maySeeChart && (
          <SegmentedControl
            aria-label={t('members.view.label')}
            data={[
              { value: 'table', label: t('members.view.table') },
              { value: 'chart', label: t('members.view.chart') },
            ]}
            onChange={(value) => {
              filters.setView(value);
            }}
            value={search.view}
          />
        )}
      </Group>

      {filters.isFiltered && (
        <Group>
          <Button onClick={filters.reset} size="compact-sm" variant="subtle">
            {t('members.filters.reset')}
          </Button>
        </Group>
      )}

      {showChart ? (
        <SharedUi.DataState
          errorMessageKey="members.chart.failed"
          onRetry={directory.chart.refetch}
          skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
          status={statusOf(directory.chart)}
        >
          <MemberOrgChart label={t('members.view.chart')} tree={directory.chart.tree} />
        </SharedUi.DataState>
      ) : (
        <SharedUi.DataState
          empty={
            <SharedUi.EmptyState
              descriptionKey={
                filters.isFiltered ? 'members.empty.filtered' : 'members.empty.description'
              }
              titleKey="members.empty.title"
            />
          }
          errorMessageKey="members.list.failed"
          isEmpty={page?.items.length === 0}
          onRetry={directory.refetch}
          skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
          status={statusOf(directory)}
        >
          <div className={classes['scroller']}>
            <MemberTable items={page?.items ?? []} />
          </div>
          <SharedUi.PaginationBar
            onPageChange={filters.setPage}
            page={page?.page ?? 1}
            perPage={page?.perPage ?? 1}
            total={page?.total ?? 0}
          />
        </SharedUi.DataState>
      )}
    </Stack>
  );
}

/**
 * The three states `DataState` knows, from the two booleans a query reports.
 *
 * `isPending` rather than `isFetching`: with `keepPreviousData` a refetch still has rows on screen,
 * and a skeleton over them is a flash on every page turn.
 */
const statusOf = (query: {
  readonly isPending: boolean;
  readonly isError: boolean;
}): 'pending' | 'error' | 'success' => {
  if (query.isError) return 'error';

  return query.isPending ? 'pending' : 'success';
};
