import { useMemo } from 'react';

import { type TeamListEntry } from '@units/team/api';
import { narrowTeams, TEAMS_PER_PAGE, type NarrowedTeams } from '@units/team/lib';
import { type TeamListSearch } from '@units/team/model/validation/team-list-search.schema.js';
import {
  useTeamFilters,
  type SearchNavigation,
  type TeamFilters,
} from '@units/team/service/hooks/use-team-filters.hook.js';
import { useTeamListQuery } from '@units/team/service/queries/team-list.query.js';

export interface TeamDirectory {
  readonly filters: TeamFilters;
  /** The page being shown, and how many matched — computed here, because the endpoint has no pages. */
  readonly page: NarrowedTeams<TeamListEntry>;
  readonly perPage: number;
  readonly status: 'pending' | 'error' | 'success';
  readonly refetch: () => void;
}

/**
 * The team list as one screen reads it: the filter, and the page of the answer it selects.
 *
 * The public API of the unit for that screen (`rules/frontend-fsd.mdc` rule 6): the widget calls
 * this and renders, and knows nothing about query keys, abort signals or the URL.
 *
 * **The narrowing is memoised on the answer and the filter**, not recomputed per render: the search
 * box re-renders this component on every keystroke, and re-sorting the organization's teams for each
 * letter is work nobody asked for. It is a `useMemo` rather than an effect because it is derived
 * state, which `rules/frontend-fsd.mdc` rule 11 is explicit about.
 */
export const useTeamList = (search: TeamListSearch, navigate: SearchNavigation): TeamDirectory => {
  const filters = useTeamFilters(search, navigate);
  const query = useTeamListQuery();

  const page = useMemo(() => narrowTeams(query.data ?? [], search), [query.data, search]);

  return {
    filters,
    page,
    perPage: TEAMS_PER_PAGE,
    status: statusOf(query),
    refetch: () => {
      void query.refetch();
    },
  };
};

/**
 * The three states `DataState` knows, from the two booleans a query reports.
 *
 * `isPending` rather than `isFetching`: a background refetch keeps the rows on screen, and a
 * skeleton over rows that are already there is a flash for no reason.
 */
const statusOf = (query: {
  readonly isPending: boolean;
  readonly isError: boolean;
}): 'pending' | 'error' | 'success' => {
  if (query.isError) return 'error';

  return query.isPending ? 'pending' : 'success';
};
