import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { writePermissionOverride, type PermissionOverride } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/** One id for the whole operation, so a second success updates the toast instead of stacking one. */
const NOTIFICATION_ID = 'permission-override';

export interface WriteOverrideInput {
  readonly userId: string;
  readonly permission: string;
  readonly override: PermissionOverride;
}

/**
 * Writes the exception on one key — **pessimistically**, and the reason is the answer, not the
 * network.
 *
 * `PUT` answers `204`: there is no document to write into the cache, and the fact the screen needs
 * next — the new `source` of that key — is assembled from roles, overrides and ownership by the
 * server. Guessing it here would be a second capability ladder on the client, which is the one
 * thing this screen is not allowed to grow (`permission-model.md` §«Слой 5», «одна лестница»). An
 * optimistic patch would also be optimistic about three refusals that are ordinary rather than
 * exceptional — the owner, the self-lockout, the permission the granter does not hold — and rolling
 * a control back through them reads as the interface changing its mind about who somebody is.
 *
 * **`QueryKeys.Permissions.all`, not just this subject's key.** A change to an exception bumps the
 * subject's `permissionsVersion`, and the subject may be the caller: denying oneself
 * `invoice:issue` is supported on purpose (`permission-override.policy.ts` refuses only the two
 * keys that govern rights). `all` is the prefix `mine()` starts with, so the sidebar, every
 * `can(...)` in the shell and the next `beforeLoad` all see the change (`rules/tanstack-query.mdc`
 * §2, §13).
 */
export const useWritePermissionOverride = (): UseMutationResult<
  void,
  Error,
  WriteOverrideInput
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: WriteOverrideInput) =>
      writePermissionOverride(input.userId, input.permission, input.override),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Permissions.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'permissions.saved' });
    },

    /**
     * Declared so that the global toast stands aside — and for nothing else.
     *
     * `MutationCache.onError` skips a mutation that handles its own failure, which is what makes a
     * local handler an override rather than an addition (`rules/tanstack-query.mdc` §10). The
     * handling is a **render**, not a callback: the dialog reads `mutation.error` and shows the
     * refusal in place. It has to, because that dialog is `aria-modal="true"` — while it is open a
     * toast in the corner of the page is outside the accessibility tree its reader is confined to,
     * so a toast alone would be a refusal a screen-reader user is never told about. The same
     * decision, for the same reason, as the offboarding dialog next door.
     *
     * It is also where the sentence is chosen: two of this endpoint's refusals — «you cannot grant
     * what you do not hold» and «somebody else has to lift a DENY from you» — are both answered
     * `user_forbidden`, whose translation is «you do not have access to this person» and is false
     * in both cases. The distinction survives in `reason`; `overrideRefusalMessage` reads it.
     *
     * Nothing to undo: the mutation is pessimistic, so no optimistic patch was applied. The log
     * line is not lost either — `logError` runs before this check, on every failure, shown or not.
     */
    onError: () => undefined,
  });
};
