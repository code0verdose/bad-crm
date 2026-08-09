import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchTeam, type TeamDetail } from '@units/team/api';
import { QueryKeys } from '@shared/lib';

/**
 * One team and who is on it.
 *
 * A second read rather than a row of the list: the list carries `memberCount` and no people, which
 * is the contract keeping a screen that asks «how big is this team» from paying for every roster in
 * the organization.
 */
export const useTeamDetailQuery = (teamId: string): UseQueryResult<TeamDetail, Error> =>
  useQuery({
    queryKey: QueryKeys.Teams.detail(teamId),
    queryFn: ({ signal }) => fetchTeam(teamId, signal),
    staleTime: 30_000,
  });
