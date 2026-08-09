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
  /**
   * Whether to ask at all — required rather than defaulted, so every caller states it.
   *
   * The directory is behind `user:read`, which the screen that owns it always holds and a screen
   * that merely *joins* against it may not: the team roster carries account ids and no names, and it
   * asks for names only when the reader may be told them. A request certain to be refused is not a
   * graceful fallback, it is a 403 per page view — and a default would let the next caller acquire
   * one by not thinking about it.
   */
  enabled: boolean,
): UseQueryResult<EmployeeDirectoryPage, Error> =>
  useQuery({
    queryKey: QueryKeys.Employees.list(params),
    queryFn: ({ signal }) => fetchEmployeeList(params, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
