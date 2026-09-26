import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchProjectMembers, type ProjectMember } from '@units/project/api';
import { QueryKeys } from '@shared/lib';

/**
 * Who is on a project. A second read rather than a field of the card: the roster is a list of ids
 * with roles, and the card's `memberCount` is what a screen that asks «how big» should pay for.
 */
export const useProjectMembersQuery = (
  projectId: string,
): UseQueryResult<readonly ProjectMember[], Error> =>
  useQuery({
    queryKey: QueryKeys.Projects.members(projectId),
    queryFn: ({ signal }) => fetchProjectMembers(projectId, signal),
  });
