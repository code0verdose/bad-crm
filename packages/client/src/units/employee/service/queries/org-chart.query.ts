import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchOrgChart, type OrgChartNode } from '@units/employee/api';
import { QueryKeys } from '@shared/lib';

/**
 * Every edge of the organization, once.
 *
 * `enabled` rather than a conditional call: the chart is a view of the same screen, and asking for
 * it while the table is on show would spend a request on a picture nobody is looking at. It is also
 * behind a permission the directory does not imply, so for most people the answer would be a 403.
 */
export const useOrgChartQuery = (
  enabled: boolean,
): UseQueryResult<readonly OrgChartNode[], Error> =>
  useQuery({
    queryKey: QueryKeys.Employees.orgChart(),
    queryFn: ({ signal }) => fetchOrgChart(signal),
    enabled,
    staleTime: 60_000,
  });
