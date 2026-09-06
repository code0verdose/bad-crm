import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchSecurityPolicy, type SecurityPolicy } from '@units/organization/api';
import { QueryKeys } from '@shared/lib';

/**
 * The stored second-factor policy — one address, because the question takes no parameters.
 *
 * `staleTime` is short rather than absent: this is the answer the editor opens from, and a stale one
 * would let two administrators overwrite each other's roles without either seeing the other's. The
 * save invalidates the group root, so the table beside it refetches with the same change.
 */
export const useSecurityPolicyQuery = (): UseQueryResult<SecurityPolicy, Error> =>
  useQuery({
    queryKey: QueryKeys.SecurityPolicy.policy(),
    queryFn: ({ signal }) => fetchSecurityPolicy(signal),
    staleTime: 30_000,
  });
