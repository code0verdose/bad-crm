import { Group, SegmentedControl, Stack, VisuallyHidden } from '@mantine/core';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, type ProjectModel } from '@units/project';

import { ProjectFiltersBar } from './ui/project-filters-bar.component.js';
import { ProjectGrid } from './ui/project-grid.component.js';
import { ProjectListEmpty } from './ui/project-list-empty.component.js';
import { ProjectTable } from './ui/project-table.component.js';
import classes from './ui/project-list-ui.module.css';

export interface ProjectListProps {
  readonly search: ProjectModel.ProjectListSearch;
  readonly navigate: ProjectService.ProjectHooks.ProjectSearchNavigation;
}

/** Placeholders for the first load — one page of cards, or as many rows as fit a screen. */
const SKELETON_CARDS = 6;
const SKELETON_ROWS = 8;

/**
 * `/projects`: the projects the reader can see, as cards or as a table (STORY-014-04, client half).
 *
 * The composition point (`rules/frontend-fsd.mdc` rule 7): one hook of the unit gives the filter and
 * the page, the directory gives the leads' names, and presentational components draw them. Which
 * projects come back — the private ones the reader is not on, the archive unless asked for — is the
 * server's answer (acceptance 5); this renders it.
 *
 * **The names are joined here, as the project card does**, because neither the project nor the
 * directory owns the other; the directory is read only by somebody who may read it, and everybody
 * else sees the lead's id rather than a blank.
 *
 * **Two announcements, on purpose.** The count of what the filter found is a live region of its own
 * (`rules/a11y.mdc` §15), because the pager — the other live region — is not on screen when nothing
 * was found, which is exactly the answer a person who just typed most needs to hear.
 *
 * **Focus has somewhere to go.** Every control that takes the filters off takes itself off with
 * them — the bar's reset and last chip, the empty state's reset — and each hands focus to the search
 * box, which is always drawn, rather than dropping it on `<body>`.
 */
export function ProjectList({ search, navigate }: ProjectListProps) {
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const { can } = IamService.IamHooks.useCan();
  const list = ProjectService.ProjectHooks.useProjectList(search, navigate);
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('user:read'));
  const { filters, page } = list;
  const rows = ProjectLib.projectListRows(page?.items ?? [], directory.people);
  const viewLabel =
    search.view === 'grid' ? t('projects.list.view.grid') : t('projects.list.view.table');

  return (
    <Stack gap="md">
      <Group align="flex-start" justify="space-between" wrap="wrap">
        <ProjectFiltersBar
          filters={filters}
          leadOptions={ProjectLib.projectLeadOptions(page?.facets.leadIds ?? [], directory.people)}
          searchRef={searchRef}
        />
        <SegmentedControl
          aria-label={t('projects.list.view.label')}
          data={[
            { value: 'grid', label: t('projects.list.view.grid') },
            { value: 'table', label: t('projects.list.view.table') },
          ]}
          onChange={filters.setView}
          value={search.view}
        />
      </Group>

      <SharedUi.FilterBar
        active={filters.active}
        onRemove={filters.removeFilter}
        onReset={filters.reset}
        returnFocusTo={searchRef}
      />

      <VisuallyHidden aria-live="polite" role="status">
        {page === undefined
          ? null
          : page.total === 0
            ? t('projects.list.foundNone')
            : t('projects.list.found', { count: page.total })}
      </VisuallyHidden>

      <SharedUi.DataState
        empty={
          <ProjectListEmpty
            isFiltered={filters.isFiltered}
            onReset={filters.reset}
            returnFocusTo={searchRef}
          />
        }
        errorMessageKey="projects.list.failed"
        isEmpty={list.isEmpty}
        onRetry={list.refetch}
        skeleton={
          search.view === 'grid' ? (
            <SharedUi.CardGridSkeleton cards={SKELETON_CARDS} />
          ) : (
            <SharedUi.TextSkeleton lines={SKELETON_ROWS} />
          )
        }
        status={list.status}
      >
        {search.view === 'grid' ? (
          <ProjectGrid label={viewLabel} rows={rows} />
        ) : (
          <div className={classes['scroller']}>
            <ProjectTable label={viewLabel} rows={rows} />
          </div>
        )}
        <SharedUi.PaginationBar
          onPageChange={filters.setPage}
          page={page?.page ?? 1}
          perPage={page?.perPage ?? 1}
          total={page?.total ?? 0}
        />
      </SharedUi.DataState>
    </Stack>
  );
}
