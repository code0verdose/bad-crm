import { Chip, Group, NativeSelect, Stack, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { EmployeeModel, type EmployeeApi, type EmployeeService } from '@units/employee';

import classes from './member-list-ui.module.css';

export interface MemberFiltersBarProps {
  readonly filters: EmployeeService.EmployeeHooks.EmployeeFilters;
  readonly facets: EmployeeApi.EmployeeDirectoryPage['facets'] | undefined;
}

/**
 * Written out rather than composed from the value. ADR-0019 forbids assembling a key at runtime: a
 * key built from `status` cannot be found by reading the source, and the parity gate would report
 * three translated strings as zero used ones.
 */
const STATUS_KEYS = {
  ACTIVE: 'members.status.ACTIVE',
  SUSPENDED: 'members.status.SUSPENDED',
  INVITED: 'members.status.INVITED',
} as const;

const SORT_KEYS = {
  name: 'members.sort.name',
  '-name': 'members.sort.nameDesc',
  hiredAt: 'members.sort.hiredAt',
  '-hiredAt': 'members.sort.hiredAtDesc',
} as const;

/**
 * What narrows the directory, and nothing else.
 *
 * **Presentational.** It reads no URL and owns no state: the hook of the unit does both, and this
 * draws what it is handed (`rules/lists-and-filters.mdc`).
 *
 * **Chips rather than a `MultiSelect`.** Two reasons, and the second is the one that decided it: a
 * handful of statuses and the roles of one organization are few enough that hiding them behind a
 * dropdown costs a click to find out what the options even are — and `Combobox`, which every
 * multi-select in Mantine is built on, carries a popover, a portal and a floating engine into the
 * chunk of a screen that needs none of them (`ux-architecture.md` → «Бюджет бандла»).
 *
 * The role and team options come from the **answer**, not from `/roles` and `/teams`: a developer
 * holds neither `role:read` nor `team:read`, and this screen is open to them.
 */
export function MemberFiltersBar({ filters, facets }: MemberFiltersBarProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="sm">
      <Group align="flex-end" gap="sm" wrap="wrap">
        <TextInput
          className={classes['search']}
          label={t('members.filters.search')}
          maxLength={64}
          onChange={(event) => {
            filters.setQuery(event.currentTarget.value);
          }}
          placeholder={t('members.filters.searchPlaceholder')}
          type="search"
          value={filters.typed}
        />
        <NativeSelect
          data={EmployeeModel.MEMBER_SORTS.map((value) => ({
            value,
            label: t(SORT_KEYS[value]),
          }))}
          label={t('members.filters.sort')}
          onChange={(event) => {
            filters.setSort(event.currentTarget.value as EmployeeApi.EmployeeSort);
          }}
          value={filters.search.sort}
        />
      </Group>

      <Chip.Group
        multiple
        onChange={(values) => {
          filters.setStatuses(values);
        }}
        value={[...filters.search.status]}
      >
        <Group gap="xs" role="group" aria-label={t('members.filters.status')} wrap="wrap">
          {EmployeeModel.MEMBER_STATUSES.map((status) => (
            <Chip key={status} size="sm" value={status}>
              {t(STATUS_KEYS[status])}
            </Chip>
          ))}
        </Group>
      </Chip.Group>

      {facets !== undefined && facets.roles.length > 0 && (
        <Group gap="xs" role="group" aria-label={t('members.filters.role')} wrap="wrap">
          {facets.roles.map((role) => (
            <Chip
              key={role.id}
              checked={filters.search.role.includes(role.id)}
              onChange={() => {
                filters.toggleRole(role.id);
              }}
              size="sm"
              value={role.id}
            >
              {role.name}
            </Chip>
          ))}
        </Group>
      )}

      {facets !== undefined && facets.teams.length > 0 && (
        <Group gap="xs" role="group" aria-label={t('members.filters.team')} wrap="wrap">
          {facets.teams.map((team) => (
            <Chip
              key={team.id}
              checked={filters.search.team.includes(team.id)}
              onChange={() => {
                filters.toggleTeam(team.id);
              }}
              size="sm"
              value={team.id}
            >
              {team.name}
            </Chip>
          ))}
        </Group>
      )}
    </Stack>
  );
}
