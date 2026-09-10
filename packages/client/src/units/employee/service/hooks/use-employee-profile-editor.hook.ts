import { useCallback } from 'react';

import { type EmployeeProfilePatch } from '@units/employee/api';
import { useUpdateEmployeeProfile } from '@units/employee/service/mutations';

export interface EmployeeProfileEditor {
  readonly isSaving: boolean;
  /** Saves the patch onto the record this hook was bound to. */
  readonly save: (patch: EmployeeProfilePatch) => void;
}

/**
 * Editing one personnel record, as the object a screen can render — the unit's public API for the
 * page (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the page reached past it.** `EmployeeProfilePage` called
 * `EmployeeMutations.useUpdateEmployeeProfile()` directly and paired the form's values with the
 * route's `userId` inside the JSX. On a page that is the easiest violation to excuse — a page *is*
 * composition — but it is composition of hooks, not of mutations, and the call site was doing the
 * one thing rule 5 keeps out of markup: building a request body.
 *
 * Binding `userId` once, here, is the part that is worth more than the tidiness: with the id taken
 * at the top there is no id at the call site to get wrong, so the form cannot be saved onto
 * somebody else's record by a mistake in the JSX.
 *
 * No `failure` and no success signal: the toast on success belongs to
 * `update-employee-profile.mutation.ts` (it is a property of the write, and it writes the fresh
 * record into the cache in the same breath), and every refusal is the one red toast from the global
 * `MutationCache` handler (`rules/errors-and-toasts.mdc` §3).
 */
export const useEmployeeProfileEditor = (userId: string): EmployeeProfileEditor => {
  const { isPending, mutate } = useUpdateEmployeeProfile();

  const save = useCallback(
    (patch: EmployeeProfilePatch) => {
      mutate({ userId, patch });
    },
    [mutate, userId],
  );

  return { isSaving: isPending, save };
};
