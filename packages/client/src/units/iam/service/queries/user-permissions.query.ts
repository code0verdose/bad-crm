import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchUserPermissions, type UserPermissions } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';

/**
 * Everything one person may do, with the layer that decided each key.
 *
 * **No `enabled`, and that is a decision rather than an omission.** The obvious guard —
 * `enabled: can('permission:override_read')` — was written first and then removed, because no test
 * could make it red: the tab it belongs to is not rendered without that permission and its panel is
 * not mounted (`keepMounted={false}`), so the query never starts in the case the guard was written
 * for. A second gate that cannot be observed failing is not a second gate; it is a line that makes
 * the first one look optional. The request is not made because the screen is not there, and
 * `test/widgets/user-permissions.test.tsx` asserts exactly that.
 *
 * **No `staleTime`** either — the default 30 s from the factory stands, and this answer is not
 * something to hold longer: it is read while somebody is changing it. The endpoint carries
 * `private, no-store` for its own reasons (the body is what administrators write about a named
 * colleague), which is about disk caches and proxies rather than about this one.
 */
export const useUserPermissionsQuery = (userId: string): UseQueryResult<UserPermissions, Error> =>
  useQuery({
    queryKey: QueryKeys.Permissions.ofUser(userId),
    queryFn: ({ signal }) => fetchUserPermissions(userId, signal),
  });
