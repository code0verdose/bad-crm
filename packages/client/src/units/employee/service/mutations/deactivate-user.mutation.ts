import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { deactivateUser, type OffboardingReport } from '@units/employee/api';
import { QueryKeys } from '@shared/lib';

export interface DeactivationInput {
  readonly userId: string;
  readonly reason: string;
}

/**
 * Offboarding, **pessimistically**.
 *
 * No optimistic patch, and the reason is not caution about the network: the answer is a report of
 * what was actually revoked, and there is nothing to guess. Showing «deactivated» before the server
 * says so would be showing the one thing this operation exists to stop somebody from assuming.
 *
 * The whole employee group is invalidated rather than one key: a suspension changes the person's row
 * in the directory, their profile, and — once statuses are filtered by default — whether they appear
 * at all. `QueryKeys.Employees.all` is the prefix both the list and the detail start with, which is
 * why the factory puts them there (`rules/tanstack-query.mdc` §2).
 */
export const useDeactivateUser = (): UseMutationResult<
  OffboardingReport,
  Error,
  DeactivationInput
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: DeactivationInput) => deactivateUser(input.userId, input.reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Employees.all });
    },
    /**
     * Declared so that the global toast stands aside — and for nothing else.
     *
     * `MutationCache.onError` skips a mutation that handles its own failure, which is what makes a
     * local handler an override rather than an addition (`rules/tanstack-query.mdc` §10). The
     * handling is a render, not a callback: the dialog reads `mutation.error` and shows the refusal
     * in place. It has to, because that dialog is `aria-modal="true"` — while it is open, a toast
     * in the corner of the page is outside the accessibility tree its reader is confined to, so a
     * toast alone would be a refusal a screen-reader user is never told about.
     *
     * There is nothing to undo here: the mutation is pessimistic, so no optimistic patch was
     * applied. The log line is not lost either — `logError` runs before this check, on every
     * failure, shown or not.
     */
    onError: () => undefined,
  });
};
