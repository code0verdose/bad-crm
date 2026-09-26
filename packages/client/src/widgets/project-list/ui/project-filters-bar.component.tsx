import { Chip, Group, NativeSelect, Stack, TextInput } from '@mantine/core';
import { type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { ProjectModel, type ProjectLib, type ProjectService } from '@units/project';

import classes from './project-list-ui.module.css';

export interface ProjectFiltersBarProps {
  readonly filters: ProjectService.ProjectHooks.ProjectFilters;
  /** The leads of the projects the reader can see — the answer's facet, named where possible. */
  readonly leadOptions: readonly ProjectLib.ProjectLeadOption[];
  /** The search box — always drawn, so it is where focus goes when a reset takes itself away. */
  readonly searchRef: Ref<HTMLInputElement>;
}

/**
 * Written out rather than composed from the value: a key built at runtime cannot be found by reading
 * the source (ADR-0019).
 */
const SORT_KEYS: Readonly<Record<ProjectModel.ProjectListSort, string>> = {
  name: 'projects.list.sort.name',
  '-name': 'projects.list.sort.nameDesc',
  key: 'projects.list.sort.key',
  '-key': 'projects.list.sort.keyDesc',
  createdAt: 'projects.list.sort.createdAt',
  '-createdAt': 'projects.list.sort.createdAtDesc',
};

/**
 * What narrows the list of projects, and nothing else.
 *
 * **Presentational**: it reads no URL and owns no state — the unit's hook does both
 * (`rules/lists-and-filters.mdc` §7). Chips rather than a multi-select for the statuses, for the
 * directory's reason: four values are fewer than the click it takes to find out what they are.
 *
 * There is no «client» control: the server has no such filter until STORY-014-07.
 */
export function ProjectFiltersBar({ filters, leadOptions, searchRef }: ProjectFiltersBarProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="sm">
      <Group align="flex-end" gap="sm" wrap="wrap">
        <TextInput
          className={classes['search']}
          label={t('projects.list.filters.search')}
          maxLength={ProjectModel.PROJECT_QUERY_MAX}
          onChange={(event) => {
            filters.setQuery(event.currentTarget.value);
          }}
          placeholder={t('projects.list.filters.searchPlaceholder')}
          ref={searchRef}
          type="search"
          value={filters.typed}
        />
        <NativeSelect
          data={ProjectModel.PROJECT_LIST_SORTS.map((value) => ({
            value,
            label: t(SORT_KEYS[value]),
          }))}
          label={t('projects.list.filters.sort')}
          onChange={(event) => {
            filters.setSort(event.currentTarget.value as ProjectModel.ProjectListSort);
          }}
          value={filters.search.sort}
        />
        {leadOptions.length > 0 && (
          <NativeSelect
            data={[{ value: '', label: t('projects.list.filters.anyLead') }, ...leadOptions]}
            label={t('projects.list.filters.lead')}
            onChange={(event) => {
              filters.setLead(event.currentTarget.value === '' ? null : event.currentTarget.value);
            }}
            value={filters.search.lead ?? ''}
          />
        )}
      </Group>

      <Group gap="xs" wrap="wrap">
        <Chip
          checked={filters.search.member === 'me'}
          onChange={(checked) => {
            filters.setMine(checked);
          }}
          size="sm"
          value="me"
        >
          {t('projects.list.filters.mine')}
        </Chip>
        <Chip.Group
          multiple
          onChange={(values) => {
            filters.setStatuses(values);
          }}
          value={[...filters.search.status]}
        >
          <Group aria-label={t('projects.list.filters.status')} gap="xs" role="group" wrap="wrap">
            {ProjectModel.PROJECT_STATUSES.map((status) => (
              <Chip key={status} size="sm" value={status}>
                {t(ProjectModel.PROJECT_STATUS_LABEL[status])}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </Group>
    </Stack>
  );
}
