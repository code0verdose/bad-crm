import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { removePermissionOverride } from '@units/iam/api';
import { overrideRefusalNotification } from '@units/iam/lib';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/** The same id the write uses: one control, one signal, whichever direction it was moved. */
const NOTIFICATION_ID = 'permission-override';

export interface RemoveOverrideInput {
  readonly userId: string;
  readonly permission: string;
}

/**
 * Puts one key back on whatever the person's roles say — **pessimistically**, like its twin.
 *
 * What the screen shows afterwards is not «nothing»: removing an exception hands the key back to
 * the roles, and whether those grant it is the server's answer to assemble. That is why the group
 * is invalidated rather than patched — the row's new `source` is `ROLE` or `NOT_GRANTED` depending
 * on facts this client does not hold, and choosing between them here would be the client deciding a
 * permission.
 *
 * `DELETE` on an exception that is not there answers `204` as well, by contract: the caller asked
 * for a state and the state is that none exists. Nothing special is done with that — the
 * invalidation re-reads what is true either way.
 *
 * The one refusal of its own is `self_assignment_forbidden` — lifting a DENY from oneself is
 * exactly the escalation the DENY was written to prevent — and it arrives as `user_forbidden`,
 * whose sentence would be wrong. Hence the local `onError`, which **replaces** the global toast
 * (`rules/tanstack-query.mdc` §10) rather than adding a second one.
 */
export const useRemovePermissionOverride = (): UseMutationResult<
  void,
  Error,
  RemoveOverrideInput
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RemoveOverrideInput) =>
      removePermissionOverride(input.userId, input.permission),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Permissions.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'permissions.removed' });
    },

    onError: (error) => {
      notify.error(overrideRefusalNotification(NOTIFICATION_ID, error));
    },
  });
};
