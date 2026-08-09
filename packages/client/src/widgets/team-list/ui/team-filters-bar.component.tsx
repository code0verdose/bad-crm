import { Group, NativeSelect, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { TeamModel, type TeamService } from '@units/team';

import classes from './team-list-ui.module.css';

export interface TeamFiltersBarProps {
  readonly filters: TeamService.TeamHooks.TeamFilters;
}

/**
 * Written out rather than composed from the value. ADR-0019 forbids assembling a key at runtime: a
 * key built from the order cannot be found by reading the source, and the parity gate would report
 * four translated strings as zero used ones.
 */
const SORT_KEYS = {
  name: 'teams.sort.name',
  '-name': 'teams.sort.nameDesc',
  members: 'teams.sort.members',
  '-members': 'teams.sort.membersDesc',
} as const;

/**
 * What narrows the list, and nothing else.
 *
 * **Presentational**: it reads no URL and owns no state — the hook of the unit does both, and this
 * draws what it is handed (`rules/lists-and-filters.mdc` §7).
 *
 * `NativeSelect` rather than `Select`: four options need no search, the native control is the one a
 * phone renders as its own picker and a screen reader already knows, and Mantine's `Select` carries
 * `Combobox` with a popover and a floating engine into a chunk that needs none of it
 * (`ux-architecture.md` → «Бюджет бандла»).
 */
export function TeamFiltersBar({ filters }: TeamFiltersBarProps) {
  const { t } = useTranslation();

  return (
    <Group align="flex-end" gap="sm" wrap="wrap">
      <TextInput
        className={classes['search']}
        label={t('teams.filters.search')}
        maxLength={64}
        onChange={(event) => {
          filters.setQuery(event.currentTarget.value);
        }}
        placeholder={t('teams.filters.searchPlaceholder')}
        type="search"
        value={filters.typed}
      />
      <NativeSelect
        data={TeamModel.TEAM_SORTS.map((value) => ({ value, label: t(SORT_KEYS[value]) }))}
        label={t('teams.filters.sort')}
        onChange={(event) => {
          filters.setSort(event.currentTarget.value as TeamModel.TeamSort);
        }}
        value={filters.search.sort}
      />
    </Group>
  );
}
