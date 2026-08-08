import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchEmployeeProfile, type EmployeeProfile } from '@units/employee/api';
import { QueryKeys } from '@shared/lib';

/**
 * One person's personnel record.
 *
 * `detail(userId)` rather than a list address: the screen is about one human, and the directory
 * (STORY-012-04) will have its own key under the same prefix so that one invalidation reaches both.
 */
export const useEmployeeProfileQuery = (userId: string): UseQueryResult<EmployeeProfile, Error> =>
  useQuery({
    queryKey: QueryKeys.Employees.detail(userId),
    queryFn: ({ signal }) => fetchEmployeeProfile(userId, signal),
    staleTime: 30_000,
  });
