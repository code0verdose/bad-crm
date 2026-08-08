import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import {
  updateEmployeeProfile,
  type EmployeeProfile,
  type EmployeeProfilePatch,
} from '@units/employee/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/** One id for the whole operation, so a second save updates the toast instead of stacking a twin. */
const NOTIFICATION_ID = 'employee-profile-saved';

export interface UpdateEmployeeProfileInput {
  readonly userId: string;
  readonly patch: EmployeeProfilePatch;
}

/**
 * Saves the record — pessimistically.
 *
 * An optimistic patch would show fields the server may refuse in two different ways: an employment
 * field edited by somebody who may only edit their own name is `403`, and a manager that closes a
 * loop is `422`. Rolling either back reads as the interface changing its mind, and the form would
 * have to reconstruct what the person typed.
 *
 * The answer replaces the cache entry rather than invalidating it: the server has just returned the
 * stored record folded to what this caller may see, which is exactly what the query would fetch.
 *
 * **No local `onError`** — every refusal is one red toast from the global `MutationCache.onError`
 * keyed by `code` (`rules/errors-and-toasts.mdc` §3).
 */
export const useUpdateEmployeeProfile = (): UseMutationResult<
  EmployeeProfile,
  Error,
  UpdateEmployeeProfileInput
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateEmployeeProfileInput) =>
      updateEmployeeProfile(input.userId, input.patch),

    onSuccess: (profile, input) => {
      queryClient.setQueryData(QueryKeys.Employees.detail(input.userId), profile);
      notify.success({ id: NOTIFICATION_ID, messageKey: 'employee.saved' });
    },
  });
};
