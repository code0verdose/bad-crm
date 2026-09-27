import { Chip, Group, TextInput } from '@mantine/core';
import { type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { ProjectModel, type ProjectService } from '@units/project';

export interface ProjectMemberFiltersProps {
  readonly filters: ProjectService.ProjectHooks.ProjectMemberFilters;
  /** The search box — always drawn, so it is where focus goes when a control takes itself away. */
  readonly searchRef: Ref<HTMLInputElement>;
}

/**
 * What narrows the roster: a phrase and the roles (STORY-014-02, acceptance 10).
 *
 * **Presentational**: it reads no URL and owns no state — the unit's hook does both
 * (`rules/lists-and-filters.mdc` §7). Chips rather than a multi-select for the roles, as the project
 * list does for statuses: four values are fewer than the click it takes to find out what they are.
 */
export function ProjectMemberFilters({ filters, searchRef }: ProjectMemberFiltersProps) {
  const { t } = useTranslation();

  return (
    <Group align="flex-end" gap="sm" wrap="wrap">
      <TextInput
        label={t('projects.members.filters.search')}
        maxLength={ProjectModel.PROJECT_MEMBER_QUERY_MAX}
        onChange={(event) => {
          filters.setQuery(event.currentTarget.value);
        }}
        placeholder={t('projects.members.filters.searchPlaceholder')}
        ref={searchRef}
        type="search"
        value={filters.typed}
      />
      <Chip.Group
        multiple
        onChange={(values) => {
          filters.setRoles(values);
        }}
        value={[...filters.search.role]}
      >
        <Group aria-label={t('projects.members.filters.role')} gap="xs" role="group" wrap="wrap">
          {ProjectModel.PROJECT_ROLES.map((role) => (
            <Chip key={role} size="sm" value={role}>
              {t(ProjectModel.PROJECT_ROLE_LABEL[role])}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
    </Group>
  );
}
