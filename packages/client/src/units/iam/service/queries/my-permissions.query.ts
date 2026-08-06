import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchMyPermissions, type MyPermissions } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';

/**
 * What the caller may do, cached for the length of a screen.
 *
 * `staleTime` is deliberately short rather than clever. The server answers this request with an
 * `ETag` built from the person's permission version, so a revalidation after a change costs a 304
 * and a changed answer arrives on the first request after it — the cache here is about not asking
 * five times while one screen renders, not about avoiding the network.
 *
 * **This is a hint, never a decision.** Every request the interface would make is authorised again
 * on the server; what this buys is a button that is not offered rather than a button that fails.
 */
export const useMyPermissionsQuery = (): UseQueryResult<MyPermissions, Error> =>
  useQuery({
    queryKey: QueryKeys.Permissions.mine(),
    queryFn: ({ signal }) => fetchMyPermissions(signal),
    staleTime: 30_000,
  });
