import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchTeams, type TeamListEntry } from '@units/team/api';
import { QueryKeys } from '@shared/lib';

/**
 * Every live team of the organization, once.
 *
 * One address and no parameters, because the endpoint has none — the phrase and the page of the
 * screen are applied to this answer (`narrowTeams`). There is therefore no `keepPreviousData` here
 * either: nothing refetches when a filter changes, so there is no previous page to keep.
 *
 * `staleTime` is longer than the default half-minute: an org chart is edited by an administrator
 * every few months, and the writes that do change it invalidate this key by hand.
 */
const FRESH_FOR_MS = 60_000;

export const useTeamListQuery = (): UseQueryResult<readonly TeamListEntry[], Error> =>
  useQuery({
    queryKey: QueryKeys.Teams.list(),
    queryFn: ({ signal }) => fetchTeams(signal),
    staleTime: FRESH_FOR_MS,
  });
