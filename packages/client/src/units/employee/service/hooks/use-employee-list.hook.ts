import { useMemo } from 'react';

import { type EmployeeDirectoryPage, type OrgChartNode } from '@units/employee/api';
import { buildOrgTree } from '@units/employee/lib/utils/build-org-tree.util.js';
import { type OrgTreeNode } from '@units/employee/types/org-chart.types.js';
import {
  useEmployeeFilters,
  type EmployeeFilters,
  type SearchNavigation,
} from '@units/employee/service/hooks/use-employee-filters.hook.js';
import { useEmployeeListQuery } from '@units/employee/service/queries/employee-list.query.js';
import { useOrgChartQuery } from '@units/employee/service/queries/org-chart.query.js';
import { type MemberListSearch } from '@units/employee/model/validation/member-list-search.schema.js';

export interface EmployeeDirectory {
  readonly filters: EmployeeFilters;
  readonly page: EmployeeDirectoryPage | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
  readonly chart: {
    readonly tree: readonly OrgTreeNode<OrgChartNode>[];
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly refetch: () => void;
  };
}

/**
 * The directory as one screen reads it: the filter, the page, and the chart of the same people.
 *
 * The public API of the unit for this screen (`rules/frontend-fsd.mdc` rule 7): the widget below
 * calls this and renders, and knows nothing about query keys, abort signals or the URL.
 *
 * **`isPending`, not `isFetching`.** With `keepPreviousData` a refetch keeps the previous rows on
 * screen, and a skeleton over rows that are already there is a flash for every page turn. The first
 * load — the one with nothing to keep — is the only one that gets a skeleton.
 */
export const useEmployeeDirectory = (
  search: MemberListSearch,
  navigate: SearchNavigation,
  showChart: boolean,
): EmployeeDirectory => {
  const filters = useEmployeeFilters(search, navigate);
  // Always: this screen *is* the directory, and it is behind `user:read` at the route.
  const list = useEmployeeListQuery(filters.params, true);
  const chart = useOrgChartQuery(showChart);

  // Rebuilt only when the answer changes, not on every keystroke in the search box above it.
  const tree = useMemo(() => buildOrgTree(chart.data ?? []), [chart.data]);

  return {
    filters,
    page: list.data,
    isPending: list.isPending,
    isError: list.isError,
    refetch: () => {
      void list.refetch();
    },
    chart: {
      tree,
      isPending: chart.isPending && showChart,
      isError: chart.isError,
      refetch: () => {
        void chart.refetch();
      },
    },
  };
};
