import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchEmployeeList,
  type EmployeeDirectoryPage,
  type EmployeeListParams,
} from '@units/employee/api';
import { QueryKeys } from '@shared/lib';

/**
 * One page of the directory.
 *
 * `keepPreviousData`: while the next page or the next filter is in flight the previous rows stay on
 * screen, so paging does not blink through an empty table and back. The first load has no previous
 * data and is a skeleton — which is the honest difference between «nothing yet» and «something,
 * being replaced».
 *
 * The `signal` is passed on, so a filter changed twice in a second cancels the first request rather
 * than racing it: two answers to two different questions arriving out of order is how a list ends up
 * showing rows that match neither.
 */
export const useEmployeeListQuery = (
  params: EmployeeListParams,
): UseQueryResult<EmployeeDirectoryPage, Error> =>
  useQuery({
    queryKey: QueryKeys.Employees.list(params),
    queryFn: ({ signal }) => fetchEmployeeList(params, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
