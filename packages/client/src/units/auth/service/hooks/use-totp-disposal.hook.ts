import { useCallback } from 'react';

import { errorMessage, type ErrorMessage } from '@shared/api';
import { type TotpDisableRequest } from '@units/auth/api';
import { useDisableTotp } from '@units/auth/service/mutations/disable-totp.mutation.js';

export interface TotpDisposal {
  /**
   * The refusal as a sentence — key and values — chosen from the `code` and never from `detail`
   * (`rules/errors-and-toasts.mdc` §10). Absent while nothing has been refused.
   *
   * `403 reauthentication_required` answers a wrong password, a wrong code and an already-spent
   * recovery code alike, which is why the dialog renders it above both fields rather than under
   * either — the server deliberately refuses to say which half was wrong.
   */
  readonly failure: ErrorMessage | undefined;
  readonly isPending: boolean;
  /**
   * Sends both proofs as typed. `onDisabled` fires only on success: the section this dialog was
   * opened from stops being drawn the moment the factor is off, and the widget above needs to know
   * *why* it closed to decide where the focus goes.
   */
  readonly disable: (proof: TotpDisableRequest, onDisabled?: () => void) => void;
}

/**
 * Turning one's own second factor off, as the object a dialog can render — the unit's public API for
 * `ui` (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the dialog reached past it.** `DisableTotpDialog` called
 * `AuthService.useDisableTotp()` — the mutation, reached through the unit's flat barrel — and turned
 * the `Error` into a key itself: the middle link of the call chain skipped (rule 4), and a copy of
 * `error → messageKey` in a widget.
 *
 * **`useTotpDisposal`, not `useDisableTotp`.** `units/auth/service/index.ts` re-exports `hooks`,
 * `mutations`, `queries` and `stores` into one flat namespace rather than as four
 * (`AuthService.useLogin()`, not `AuthService.AuthHooks.useLogin()`), so two exports of one name
 * would silently become one, resolved by the order of the re-exports. The unit already names this
 * operation twice this way: the API function takes a `disposal`, and enrolment's opposite number is
 * `useTotpEnrolment`.
 *
 * **No `dismiss`.** Unlike the three confirmations that keep one, this dialog is unmounted rather
 * than emptied — `DisableTotp` renders it only while it is open — so a reset would have nothing left
 * to reset. Adding one for symmetry would be an unused branch of a hook.
 */
export const useTotpDisposal = (): TotpDisposal => {
  const { error, isPending, mutate } = useDisableTotp();

  const disable = useCallback(
    (proof: TotpDisableRequest, onDisabled?: () => void) => {
      mutate(proof, onDisabled === undefined ? undefined : { onSuccess: onDisabled });
    },
    [mutate],
  );

  return {
    failure: error === null ? undefined : errorMessage(error),
    isPending,
    disable,
  };
};
