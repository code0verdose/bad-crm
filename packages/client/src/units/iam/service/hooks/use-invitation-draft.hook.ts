import { useCallback } from 'react';

import { type MintedInvitation } from '@units/iam/api';
import { type InvitationForm } from '@units/iam/model';
import { useCreateInvitation } from '@units/iam/service/mutations';

export interface InvitationDraftState {
  readonly isPending: boolean;
  /**
   * The link the last send produced — the **only** copy that will ever exist.
   *
   * It lives in the mutation's own result and nowhere else: not in the URL, not in storage, not in a
   * query key. `useCreateInvitation` sets `gcTime: 0`, so it goes with the screen.
   */
  readonly minted: MintedInvitation | undefined;
  /**
   * Sends it from the form's own values — the mapping to the request body lives here, not in the
   * widget.
   */
  readonly send: (values: InvitationForm) => void;
}

/**
 * Inviting a colleague, as the object a widget can render — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the widget reached past it.** `InviteMember` called
 * `IamMutations.useCreateInvitation()` directly and normalised the form's empty role itself: the
 * middle link of the call chain skipped (rule 4), and a piece of contract knowledge — «no role for
 * now» is `null`, not `''` — sitting in a widget where the next screen to invite somebody would
 * have had to rediscover it.
 *
 * No `failure`: this write has no refusal the screen renders itself. The global mutation handler
 * is the single signal (`rules/errors-and-toasts.mdc` §2), and the success half is not a toast
 * either — it is the link the widget shows beside the form, because «sent» and «sent without a
 * relay» are one sentence with two meanings (`create-invitation.mutation.ts` says why).
 */
export const useInvitationDraft = (): InvitationDraftState => {
  const { data, isPending, mutate } = useCreateInvitation();

  const send = useCallback(
    (values: InvitationForm) => {
      mutate({
        email: values.email,
        // The select has no empty state of its own, and the contract spells «no role» as `null`.
        roleId: values.roleId === '' ? null : values.roleId,
        locale: values.locale,
      });
    },
    [mutate],
  );

  return { isPending, minted: data, send };
};
