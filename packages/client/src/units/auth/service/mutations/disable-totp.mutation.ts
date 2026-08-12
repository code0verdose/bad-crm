import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { disableTotp, type TotpDisableRequest } from '@units/auth/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

const NOTIFICATION_ID = 'totp-disabled';

/**
 * Turns the caller's own second factor off — **pessimistically**, and with no undo.
 *
 * `rules/errors-and-toasts.mdc` §9 offers «Удалено» with an eight-second undo as one of the three
 * shapes a destructive action can take, and this is emphatically not it: the server clears the
 * secret and deletes every recovery code in one transaction, and an undo could only re-enrol — a
 * new secret, a new QR code, a new set of ten codes. An affordance that cannot keep its promise is
 * worse than the confirmation it would replace, so the confirmation stays and the toast is a plain
 * success.
 *
 * **The counter is invalidated rather than assumed.** `GET /auth/2fa/recovery-codes` is the only
 * thing on this screen that knows whether 2FA is on (`recovery-code-status.query.ts` says why), and
 * after this call it answers `{ total: 0, remaining: 0 }`. Writing that locally would be a second
 * answer to the same question, and the screen would show «two-factor authentication is off» above a
 * recovery-code section still counting down from seven. Asserted as a second `GET`, not as a spy on
 * this callback: a spy would be equally happy with an invalidation aimed at a key nothing reads.
 *
 * **The local `onError` is what makes the dialog's own message the only signal.** The confirmation
 * is `aria-modal="true"`, so while it is open a toast in the corner is, for a screen-reader user, no
 * signal at all — and `403 reauthentication_required` is a statement about the two fields on screen
 * (`rules/tanstack-query.mdc` §10, `rules/errors-and-toasts.mdc` §2–§3).
 */
export const useDisableTotp = (): UseMutationResult<void, Error, TotpDisableRequest> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (disposal: TotpDisableRequest) => disableTotp(disposal),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.RecoveryCodes.all });
      notify.success({ id: NOTIFICATION_ID, messageKey: 'security.disable.done' });
    },
    onError: () => undefined,
  });
};
