import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchRoles, type RoleListEntry } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';

/**
 * Every role with everything it grants — the read behind the administration matrix.
 *
 * One address and no parameters: the screen renders all roles against all permissions, and the
 * filtering it offers (search, groups, «only differences») happens over an answer it already has.
 * A cache entry per filter would be the same rows stored several times and invalidated in some of
 * them.
 */

/**
 * `enabled` exists for one caller and one reason: the invite screen needs role names but is reached
 * with `invitation:create`, which is not `role:read`. Asking anyway would put a 403 on a screen that
 * is working exactly as intended, so the screen that cannot read roles simply offers none.
 */
export interface RolesMatrixQueryOptions {
  readonly enabled?: boolean;
}

export const useRolesMatrixQuery = (
  options: RolesMatrixQueryOptions = {},
): UseQueryResult<readonly RoleListEntry[], Error> =>
  useQuery({
    queryKey: QueryKeys.Roles.matrix(),
    queryFn: ({ signal }) => fetchRoles(signal),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
