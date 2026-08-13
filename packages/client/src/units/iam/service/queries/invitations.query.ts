import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchInvitations, type Invitation } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';

/**
 * Every open invitation of the organization, at one address.
 *
 * No parameters and no `keepPreviousData`: the endpoint takes neither a filter nor a page, so
 * nothing about this key ever changes and there is no previous page to keep. What does change it is
 * a mutation — re-issuing or revoking — and both invalidate `QueryKeys.Invitations.all`.
 *
 * The `signal` is passed on, so leaving the screen cancels the request rather than letting an
 * answer land in a cache nobody is reading (`rules/tanstack-query.mdc` §4).
 */
export const useInvitationsQuery = (): UseQueryResult<readonly Invitation[], Error> =>
  useQuery({
    queryKey: QueryKeys.Invitations.list(),
    queryFn: ({ signal }) => fetchInvitations(signal),
  });
