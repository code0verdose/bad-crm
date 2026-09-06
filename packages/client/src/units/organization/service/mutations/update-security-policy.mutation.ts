import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import {
  updateSecurityPolicy,
  type SecurityPolicy,
  type SecurityPolicyDraft,
} from '@units/organization/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/** One id for the whole operation, so a second save updates the toast instead of stacking one. */
const NOTIFICATION_ID = 'security-policy';

/**
 * Saves the policy — **pessimistically**, and for the reason the operation itself gives.
 *
 * There is nothing to be optimistic about: the answer carries `mfaRequiredSince`, which only the
 * server can compute (a role already covered keeps the date it entered on), and two of this
 * endpoint's outcomes are ordinary rather than exceptional — the 428 that asks the caller to confirm
 * they are putting themselves under the requirement, and the 404 for a role reference of another
 * organization. Rolling a patch back through either reads as the screen changing its mind about what
 * the organization's policy is.
 *
 * **`QueryKeys.SecurityPolicy.all`, not just the policy address.** A saved policy changes every
 * verdict on the coverage report, and the standing report is a sibling under the same prefix — a
 * table left showing yesterday's verdicts beside the policy that produced today's is the disagreement
 * between the screen and the door this story exists to prevent.
 */
export const useUpdateSecurityPolicy = (): UseMutationResult<
  SecurityPolicy,
  Error,
  SecurityPolicyDraft
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: SecurityPolicyDraft) => updateSecurityPolicy(draft),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.SecurityPolicy.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'organization.security.saved' });
    },

    /**
     * Declared so that the global toast stands aside — and for nothing else.
     *
     * `MutationCache.onError` skips a mutation that handles its own failure, which is what makes a
     * local handler an override rather than an addition (`rules/tanstack-query.mdc` §10,
     * `rules/errors-and-toasts.mdc` §2). The handling is a **render**: the confirmation dialog is
     * `aria-modal="true"`, so while it is open a toast in the corner of the page is outside the
     * accessibility tree its reader is confined to — a toast alone would be a refusal a
     * screen-reader user is never told about.
     *
     * The 428 is the reason this matters most. It is not a failure at all but the second half of the
     * operation (acceptance 7), and announcing it as a red toast would tell somebody their policy
     * was rejected at the moment they are being asked to confirm it.
     *
     * Nothing to undo: the mutation is pessimistic, so no optimistic patch was applied. The log line
     * is not lost either — `logError` runs before this check, on every failure, shown or not.
     */
    onError: () => undefined,
  });
};
