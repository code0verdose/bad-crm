import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { listSessions, type SessionSummary } from '@units/auth/api';
import { QueryKeys } from '@shared/lib';

/**
 * Where this account is signed in — one entry per device, never paginated.
 *
 * **A read, unlike everything else this unit keeps out of `service/queries`.** The rule the segment
 * was built on is that an answer carrying a credential is never a query: the rotation, the drafted
 * TOTP secret and the ten recovery codes are mutations for exactly that reason. This answer carries
 * none. `SessionSummary` is deliberately built from what cannot be used to *be* the session —
 * `refreshTokenHash`, `familyId` and `ipHash` stay on the server, and the address arrives already
 * masked — so it is cacheable for the same reason the recovery-code counter is.
 *
 * `staleTime` is the client default rather than something shorter. A shorter window would not make
 * the list truer: a session that has just been revoked from another device disappears here on the
 * next refetch either way, and the answer nobody can afford to be stale about — «is this session
 * still valid» — is answered by the server on every request, not by this list.
 *
 * The `signal` is passed on because a query is always cancellable (`rules/tanstack-query.mdc` §4).
 */
export const useSessionListQuery = (): UseQueryResult<readonly SessionSummary[], Error> =>
  useQuery({
    queryKey: QueryKeys.Sessions.list(),
    queryFn: ({ signal }) => listSessions(signal),
  });
